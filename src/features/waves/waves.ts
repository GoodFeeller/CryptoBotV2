// Размер волн в заданный момент: сколько обычно проходит движение вверх и вниз и сколько уже прошла текущая волна. Если текущая
// волна прошла свой обычный размер, продолжения ждать поздно, пора искать разворот. Чистые функции: видят только свечи, закрытые
// к моменту, поэтому в бэктесте не заглядывают в будущее.
import { computeAtr } from '../../core/atr.js'
import { findPivots, type Pivot } from '../../core/pivots.js'
import type { Candle } from '../../core/types.js'

export interface WaveOptions {
  /** Разворот засчитывается, когда цена ушла от экстремума на столько ATR. От этого зависит, какие волны считаются. */
  swingAtr: number
  atrPeriod: number
  /** Обычный размер: медиана стольких последних волн каждого направления. */
  sampleWaves: number
  /** Без стольких завершённых волн в каждую сторону обычный размер не считается. */
  minWaves: number
}

export type WaveDirection = 'up' | 'down'

export interface WavePoint {
  time: number
  price: number
}

export interface Wave {
  direction: WaveDirection
  from: WavePoint
  to: WavePoint
  length: number
}

export type WaveSnapshot =
  | {
      ok: true
      at: number
      close: number
      atr: number
      /** Завершённые волны от старых к новым. */
      waves: Wave[]
      /** Обычный размер волны в цене и в ATR. */
      average: Record<WaveDirection, number>
      averageAtr: Record<WaveDirection, number>
      /** Текущая волна: от последнего разворота до самой дальней цены после него. share это доля от обычного размера. */
      current: { direction: WaveDirection; start: WavePoint; extreme: WavePoint; length: number; lengthAtr: number; share: number }
      /** Верх, низ и середина последней завершённой волны: ключевые зоны по видео. */
      lastWave: { direction: WaveDirection; top: number; bottom: number; middle: number }
    }
  | { ok: false; reason: 'not_enough_waves'; up: number; down: number; needed: number }

export function waveSnapshot(candles: Candle[], at: number, options: WaveOptions): WaveSnapshot {
  const closed = candles.filter((candle) => candle.closeTime <= at)
  const atrSeries = computeAtr(closed, options.atrPeriod)
  const pivots = findPivots(closed, atrSeries, options.swingAtr)
  const waves = pivots.slice(1).map((pivot, i) => toWave(pivots[i]!, pivot, closed))
  const up = waves.filter((wave) => wave.direction === 'up')
  const down = waves.filter((wave) => wave.direction === 'down')
  if (up.length < options.minWaves || down.length < options.minWaves) {
    return { ok: false, reason: 'not_enough_waves', up: up.length, down: down.length, needed: options.minWaves }
  }

  const atr = atrSeries.at(-1)!
  const average = { up: typicalLength(up, options.sampleWaves), down: typicalLength(down, options.sampleWaves) }
  const last = pivots.at(-1)!
  const direction: WaveDirection = last.type === 'high' ? 'down' : 'up'
  const after = closed.slice(last.index + 1)
  const extremeCandle = after.reduce<Candle | undefined>((best, candle) => {
    if (!best) return candle
    return direction === 'up' ? (candle.high > best.high ? candle : best) : candle.low < best.low ? candle : best
  }, undefined)
  const extreme = extremeCandle
    ? { time: extremeCandle.openTime, price: direction === 'up' ? extremeCandle.high : extremeCandle.low }
    : { time: closed[last.index]!.openTime, price: last.price }
  const length = Math.abs(extreme.price - last.price)
  const lastWave = waves.at(-1)!
  const top = Math.max(lastWave.from.price, lastWave.to.price)
  const bottom = Math.min(lastWave.from.price, lastWave.to.price)

  return {
    ok: true,
    at,
    close: closed.at(-1)!.close,
    atr,
    waves,
    average,
    averageAtr: { up: average.up / atr, down: average.down / atr },
    current: {
      direction,
      start: { time: closed[last.index]!.openTime, price: last.price },
      extreme,
      length,
      lengthAtr: length / atr,
      share: length / average[direction],
    },
    lastWave: { direction: lastWave.direction, top, bottom, middle: (top + bottom) / 2 },
  }
}

function toWave(from: Pivot, to: Pivot, candles: Candle[]): Wave {
  return {
    direction: to.type === 'high' ? 'up' : 'down',
    from: { time: candles[from.index]!.openTime, price: from.price },
    to: { time: candles[to.index]!.openTime, price: to.price },
    length: Math.abs(to.price - from.price),
  }
}

/** Медиана последних волн: одна огромная волна не раздувает обычный размер. */
function typicalLength(waves: Wave[], sample: number): number {
  const lengths = waves.slice(-sample).map((wave) => wave.length).sort((a, b) => a - b)
  const middle = Math.floor(lengths.length / 2)
  return lengths.length % 2 === 1 ? lengths[middle]! : (lengths[middle - 1]! + lengths[middle]!) / 2
}
