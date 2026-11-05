import type { Candle } from './types.js'

/** ATR по каждой свече: среднее истинного диапазона за period свечей со сглаживанием Уайлдера. Первые свечи усредняются по тому, что есть. */
export function computeAtr(candles: Candle[], period: number): number[] {
  const result: number[] = []
  candles.forEach((candle, i) => {
    const previousClose = candles[i - 1]?.close ?? candle.close
    const range = Math.max(candle.high - candle.low, Math.abs(candle.high - previousClose), Math.abs(candle.low - previousClose))
    const previous = result[i - 1]
    if (previous === undefined) result.push(range)
    else result.push((previous * (Math.min(i, period) - 1) + range) / Math.min(i, period))
  })
  return result
}

export function lastAtr(candles: Candle[], period: number): number {
  return computeAtr(candles, period).at(-1) ?? 0
}
