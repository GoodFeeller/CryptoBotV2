// Структура старшего таймфрейма: тренд вверх, вниз или флэт по двум последним максимумам и минимумам крупных волн. По видео торгуем
// в сторону старшего таймфрейма, а во флэте внутри тренда в сторону этого тренда. Чистые функции: видят только свечи, закрытые
// к моменту.
import { computeAtr } from '../../core/atr.js'
import { findPivots, type Pivot } from '../../core/pivots.js'
import type { Candle } from '../../core/types.js'

export interface StructureOptions {
  /** Разворот засчитывается, когда цена ушла от экстремума на столько ATR. Структуру смотрим по крупным волнам. */
  swingAtr: number
  atrPeriod: number
}

export type Trend = 'up' | 'down' | 'flat'

export interface StructurePoint {
  time: number
  price: number
}

export type StructureSnapshot =
  | {
      ok: true
      at: number
      close: number
      trend: Trend
      /** Для флэта: последний тренд перед ним, null если тренда не было. Для тренда всегда null. */
      previousTrend: 'up' | 'down' | null
      /** Два последних максимума и минимума, старый первым. */
      highs: [StructurePoint, StructurePoint]
      lows: [StructurePoint, StructurePoint]
      /** Цена уже за последним максимумом или минимумом, а новый разворот ещё не подтверждён. */
      beyond: 'above_high' | 'below_low' | null
    }
  | { ok: false; reason: 'not_enough_pivots'; highs: number; lows: number; needed: 2 }

export function structureSnapshot(candles: Candle[], at: number, options: StructureOptions): StructureSnapshot {
  const closed = candles.filter((candle) => candle.closeTime <= at)
  const pivots = findPivots(closed, computeAtr(closed, options.atrPeriod), options.swingAtr)
  const highs = pivots.filter((pivot) => pivot.type === 'high')
  const lows = pivots.filter((pivot) => pivot.type === 'low')
  if (highs.length < 2 || lows.length < 2) {
    return { ok: false, reason: 'not_enough_pivots', highs: highs.length, lows: lows.length, needed: 2 }
  }

  const trend = trendOf(pivots)!
  const close = closed.at(-1)!.close
  const point = (pivot: Pivot): StructurePoint => ({ time: closed[pivot.index]!.openTime, price: pivot.price })
  const lastHigh = highs.at(-1)!
  const lastLow = lows.at(-1)!

  return {
    ok: true,
    at,
    close,
    trend,
    previousTrend: trend === 'flat' ? previousTrend(pivots) : null,
    highs: [point(highs.at(-2)!), point(lastHigh)],
    lows: [point(lows.at(-2)!), point(lastLow)],
    beyond: close > lastHigh.price ? 'above_high' : close < lastLow.price ? 'below_low' : null,
  }
}

/** Тренд по двум последним максимумам и минимумам из этих разворотов, null если их меньше двух. */
function trendOf(pivots: Pivot[]): Trend | null {
  const highs = pivots.filter((pivot) => pivot.type === 'high').slice(-2)
  const lows = pivots.filter((pivot) => pivot.type === 'low').slice(-2)
  if (highs.length < 2 || lows.length < 2) return null
  const highsRise = highs[1]!.price > highs[0]!.price
  const lowsRise = lows[1]!.price > lows[0]!.price
  if (highsRise && lowsRise) return 'up'
  if (!highsRise && !lowsRise) return 'down'
  return 'flat'
}

/** Последний тренд до текущего флэта: идём назад по истории разворотов. */
function previousTrend(pivots: Pivot[]): 'up' | 'down' | null {
  for (let end = pivots.length - 1; end > 0; end--) {
    const trend = trendOf(pivots.slice(0, end))
    if (trend === 'up' || trend === 'down') return trend
  }
  return null
}
