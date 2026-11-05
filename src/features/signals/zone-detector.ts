// Детектор зон по видео: цена пришла в область ценности в конце исчерпанной волны. Тогда собираем картину рынка и отдаём её Claude,
// а вход, сторону, стоп и тейк решает он. Пока цена стоит в той же зоне, спрашиваем раз в час, но не больше maxAsksPerVisit раз:
// паттерн на 5m может сложиться позже закрытия часа. Состояние живёт в памяти прогона; бэктест всегда идёт с начала, поэтому
// повторный прогон даёт те же ситуации.
import { computeAtr } from '../../core/atr.js'
import type { MarketAnalysis, MarketData, SignalDetector } from '../../core/ports.js'
import { timeframeMs } from '../../core/timeframes.js'
import type { Candle, Level, MarketPicture, SignalContext, Situation, StructureSnapshot, WaveSnapshot } from '../../core/types.js'
import { buildZones, inOuterHalf, touches, type Zone } from './zones.js'

const HOUR = timeframeMs('1h')
const ATR_PERIOD = 14
/** Уровни подбирались по году дневок, поэтому и здесь берём год, хотя для EMA 200 грузится больше. */
const LEVEL_DAYS = 365

export interface ZoneDetectorOptions {
  /** Половина ширины зоны в ATR часовика. */
  zoneAtr: number
  /** Волна исчерпана, когда прошла столько от обычного размера. */
  exhaustedShare: number
  maxAsksPerVisit: number
  /** Уровни для картины: не дальше стольких дневных ATR от цены. */
  nearbyLevelsAtr: number
  history: { '1d': number; '1h': number }
}

interface Visit {
  low: number
  high: number
  asks: number
  lastAt: number
}

type OkWaves = Extract<WaveSnapshot, { ok: true }>

export class ZoneDetector implements SignalDetector {
  readonly isPlaceholder = false
  private readonly visits = new Map<string, Visit>()

  constructor(private readonly deps: { market: MarketData; analysis: MarketAnalysis; options: ZoneDetectorOptions }) {}

  async detect(ctx: SignalContext): Promise<Situation | null> {
    const { market, analysis, options } = this.deps
    const { symbol, now } = ctx
    const daily = await market.candles(symbol, '1d', now, options.history['1d'])
    const hourly = await market.candles(symbol, '1h', now, options.history['1h'])
    const last = hourly.at(-1)
    if (!last || last.closeTime !== now) return this.leave(symbol)

    const small = analysis.waves(hourly, now, 'small')
    const big = analysis.waves(hourly, now, 'big')
    const structure = analysis.structure(hourly, now)
    if (!structure.ok || (!small.ok && !big.ok)) return this.leave(symbol)

    const levels = analysis.levels(daily.slice(-LEVEL_DAYS), hourly)
    const atr = computeAtr(hourly, ATR_PERIOD).at(-1)!
    const found = this.exhaustedZone(buildZones(levels, big, atr, options.zoneAtr), last, [small, big])
    if (!found) return this.leave(symbol)
    if (!this.mayAsk(symbol, found, now)) return null

    const dailyAtr = computeAtr(daily, ATR_PERIOD).at(-1) ?? 0
    const picture = this.picture({ zone: found, levels, small, big, structure, hourly, daily, atr, dailyAtr, close: last.close, now })
    return picture ? { symbol, kind: 'zone', at: now, picture } : null
  }

  /** Касающаяся зона во внешней половине исчерпанной волны; из нескольких — ближайшая к краю волны. */
  private exhaustedZone(zones: Zone[], last: Candle, waveSets: WaveSnapshot[]): Zone | null {
    let best: { zone: Zone; distance: number } | null = null
    for (const zone of zones.filter((item) => touches(item, last))) {
      for (const waves of waveSets) {
        if (!waves.ok || waves.current.share < this.deps.options.exhaustedShare || !inOuterHalf(zone, waves.current)) continue
        const distance = Math.abs(zone.price - waves.current.extreme.price)
        if (!best || distance < best.distance) best = { zone, distance }
      }
    }
    return best?.zone ?? null
  }

  /** Считает вопросы за один подход к зоне. Подход продолжается, если час назад касалась та же зона. */
  private mayAsk(symbol: string, zone: Zone, now: number): boolean {
    const visit = this.visits.get(symbol)
    const sameVisit = visit && visit.lastAt === now - HOUR && zone.low <= visit.high && zone.high >= visit.low
    if (!sameVisit) {
      this.visits.set(symbol, { low: zone.low, high: zone.high, asks: 1, lastAt: now })
      return true
    }
    visit.lastAt = now
    if (visit.asks >= this.deps.options.maxAsksPerVisit) return false
    visit.asks++
    return true
  }

  private leave(symbol: string): null {
    this.visits.delete(symbol)
    return null
  }

  private picture(input: {
    zone: Zone
    levels: Level[]
    small: WaveSnapshot
    big: WaveSnapshot
    structure: Extract<StructureSnapshot, { ok: true }>
    hourly: Candle[]
    daily: Candle[]
    atr: number
    dailyAtr: number
    close: number
    now: number
  }): MarketPicture | null {
    const { zone, levels, small, big, structure, hourly, daily, atr, dailyAtr, close, now } = input
    // Картина требует обе сетки волн: если одна не посчиталась, берём другую вместо неё, чтобы не терять ситуацию.
    const smallOk = small.ok ? small : big.ok ? big : null
    const bigOk = big.ok ? big : smallOk
    if (!smallOk || !bigOk) return null
    const ema: MarketPicture['ema'] = {}
    for (const [tf, candles] of [['1h', hourly], ['1d', daily]] as const) {
      const snapshot = this.deps.analysis.ema(candles, now)
      if (snapshot.ok) ema[tf] = { stack: snapshot.stack, emas: snapshot.emas }
    }
    const reach = this.deps.options.nearbyLevelsAtr * dailyAtr
    return {
      zone: { price: zone.price, low: zone.low, high: zone.high, reasons: zone.reasons },
      levels: levels
        .filter((level) => Math.abs(level.price - close) <= reach)
        .sort((a, b) => a.price - b.price)
        .map((level) => ({ price: level.price, class: level.class, status: level.status, bounces: level.bounces, falseBreaks: level.falseBreaks, flips: level.flips })),
      waves: { small: wavePicture(smallOk), big: wavePicture(bigOk) },
      structure: { trend: structure.trend, previousTrend: structure.previousTrend, beyond: structure.beyond, highs: structure.highs, lows: structure.lows },
      ema,
      atrPct: { '1h': (atr / close) * 100, '1d': (dailyAtr / close) * 100 },
    }
  }
}

function wavePicture(waves: OkWaves): MarketPicture['waves']['small'] {
  const { current, lastWave, averageAtr } = waves
  return {
    averageAtr,
    current: { direction: current.direction, startPrice: current.start.price, lengthAtr: current.lengthAtr, share: current.share },
    lastWave,
  }
}
