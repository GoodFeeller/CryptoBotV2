import type { Candle } from '../../core/types.js'

export interface ZigzagPoint {
  time: number
  price: number
}

/** Ломаная через точки разворотов как значения по свечам, между точками по прямой. Точки левее первой свечи тянут линию от края. */
export function zigzagValues(candles: Candle[], points: ZigzagPoint[]): (number | undefined)[] {
  const values: (number | undefined)[] = candles.map(() => undefined)
  if (candles.length === 0) return values
  const step = candles.length > 1 ? candles[1]!.openTime - candles[0]!.openTime : 1
  const position = (time: number) => Math.round((time - candles[0]!.openTime) / step)
  for (let k = 1; k < points.length; k++) {
    const from = position(points[k - 1]!.time)
    const to = position(points[k]!.time)
    if (to < 0) continue
    for (let i = Math.max(from, 0); i <= Math.min(to, candles.length - 1); i++) {
      values[i] = points[k - 1]!.price + ((points[k]!.price - points[k - 1]!.price) * (i - from)) / Math.max(to - from, 1)
    }
  }
  return values
}
