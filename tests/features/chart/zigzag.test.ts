import { describe, expect, it } from 'vitest'
import type { Candle } from '../../../src/core/types.js'
import { zigzagValues } from '../../../src/features/chart/zigzag.js'

const HOUR = 3_600_000
const candles: Candle[] = Array.from({ length: 5 }, (_, i) => ({ openTime: i * HOUR, closeTime: (i + 1) * HOUR, open: 1, high: 1, low: 1, close: 1, volume: 1, turnover: 1 }))

describe('zigzagValues', () => {
  it('draws straight lines between points and leaves the rest empty', () => {
    expect(zigzagValues(candles, [{ time: HOUR, price: 10 }, { time: 3 * HOUR, price: 20 }])).toEqual([undefined, 10, 15, 20, undefined])
  })

  it('a point left of the chart pulls the line in from the edge', () => {
    expect(zigzagValues(candles, [{ time: -2 * HOUR, price: 0 }, { time: 2 * HOUR, price: 40 }])).toEqual([20, 30, 40, undefined, undefined])
  })
})
