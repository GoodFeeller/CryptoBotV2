// [REVIEW i-code#22] Обезличивание запроса: без тикера и дат, цены в шкале «текущая цена = 100». Иначе модель может узнать монету
// и период и вспомнить, что было дальше, и бэктест окажется завышен. Позиция тоже передаётся только полями цены и состояния.
// Шкала строится от текущей цены, а не от последнего закрытия, чтобы правило «текущая цена всегда 100» было точным.
import type { Candle, CandleWindows, EntryRequest, MarketPicture, ReviewRequest, Side, StructurePoint, Timeframe, WavePicture } from '../../core/types.js'

const HOUR_MS = 3_600_000

type AnonCandle = [open: number, high: number, low: number, close: number, relativeVolume: number]
type AnonCandles = Partial<Record<Timeframe, AnonCandle[]>>

/** Картина рынка в шкале запроса: точки структуры вместо времени получают «свечей назад» по часовику. */
export type AnonPicture = Omit<MarketPicture, 'structure'> & {
  structure: Omit<MarketPicture['structure'], 'highs' | 'lows'> & { highs: AnonPoint[]; lows: AnonPoint[] }
}

interface AnonPoint {
  barsAgo: number
  price: number
}

export interface AnonEntryBody {
  situation: { kind: string; picture: AnonPicture | null }
  currentPrice: number
  maxLossPct: number
  candles: AnonCandles
}

export interface AnonReviewBody {
  side: Side
  currentPrice: number
  entryPrice: number
  stop: number
  take: number
  resultR: number
  hoursInTrade: number
  candles: AnonCandles
}

export interface Anonymized<T> {
  body: T
  scale: number
  /** Переводит цену из шкалы запроса обратно в реальную. */
  unscale: (value: number) => number
}

export function anonymizeEntry(request: EntryRequest): Anonymized<AnonEntryBody> {
  const { situation, currentPrice, candles, maxLossPct } = request
  const toScale = scaler(currentPrice)
  return {
    body: {
      situation: {
        kind: situation.kind,
        picture: situation.picture ? anonymizePicture(situation.picture, situation.at, toScale) : null,
      },
      currentPrice: toScale(currentPrice),
      maxLossPct,
      candles: anonymizeCandles(candles, toScale),
    },
    ...scaleOf(currentPrice),
  }
}

export function anonymizeReview(request: ReviewRequest): Anonymized<AnonReviewBody> {
  const { position, currentPrice, now, candles } = request
  const toScale = scaler(currentPrice)
  const sign = position.side === 'long' ? 1 : -1
  const riskPerUnit = Math.abs(position.entryPrice - position.initialStop)

  return {
    body: {
      side: position.side,
      currentPrice: toScale(currentPrice),
      entryPrice: toScale(position.entryPrice),
      stop: toScale(position.stop),
      take: toScale(position.take),
      resultR: round((sign * (currentPrice - position.entryPrice)) / riskPerUnit),
      hoursInTrade: round((now - position.openedAt) / HOUR_MS),
      candles: anonymizeCandles(candles, toScale),
    },
    ...scaleOf(currentPrice),
  }
}

/** Все цены картины переводятся в шкалу; доли, расстояния в ATR и ATR в процентах уже относительные. */
function anonymizePicture(picture: MarketPicture, at: number, toScale: (value: number) => number): AnonPicture {
  const point = ({ time, price }: StructurePoint): AnonPoint => ({ barsAgo: Math.round((at - time) / HOUR_MS), price: toScale(price) })
  const wave = ({ averageAtr, current, lastWave }: WavePicture): WavePicture => ({
    averageAtr,
    current: { ...current, startPrice: toScale(current.startPrice) },
    lastWave: { direction: lastWave.direction, top: toScale(lastWave.top), middle: toScale(lastWave.middle), bottom: toScale(lastWave.bottom) },
  })
  const ema: AnonPicture['ema'] = {}
  for (const [tf, item] of Object.entries(picture.ema) as [Timeframe, NonNullable<MarketPicture['ema'][Timeframe]>][]) {
    ema[tf] = { stack: item.stack, emas: item.emas.map((reading) => ({ ...reading, value: toScale(reading.value) })) }
  }
  const { zone, structure } = picture
  return {
    zone: { price: toScale(zone.price), low: toScale(zone.low), high: toScale(zone.high), reasons: zone.reasons },
    levels: picture.levels.map((level) => ({ ...level, price: toScale(level.price) })),
    waves: { small: wave(picture.waves.small), big: wave(picture.waves.big) },
    structure: { ...structure, highs: structure.highs.map(point), lows: structure.lows.map(point) },
    ema,
    atrPct: picture.atrPct,
  }
}

function scaleOf(price: number): { scale: number; unscale: (value: number) => number } {
  return { scale: 100 / price, unscale: (value) => (value * price) / 100 }
}

function scaler(price: number): (value: number) => number {
  return (value) => round((value * 100) / price)
}

function anonymizeCandles(windows: CandleWindows, toScale: (value: number) => number): AnonCandles {
  const result: AnonCandles = {}
  for (const [timeframe, candles] of Object.entries(windows) as [Timeframe, Candle[]][]) {
    const meanVolume = candles.reduce((sum, candle) => sum + candle.volume, 0) / candles.length || 1
    result[timeframe] = candles.map((candle) => [
      toScale(candle.open),
      toScale(candle.high),
      toScale(candle.low),
      toScale(candle.close),
      round(candle.volume / meanVolume),
    ])
  }
  return result
}

function round(value: number): number {
  return Number(value.toFixed(4))
}
