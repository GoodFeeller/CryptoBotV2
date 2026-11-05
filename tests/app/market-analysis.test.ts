import { describe, expect, it } from 'vitest'
import { loadConfig } from '../../src/app/config.js'
import { createMarketAnalysis } from '../../src/app/market-analysis.js'
import type { Candle } from '../../src/core/types.js'

const HOUR = 3_600_000
const DAY = 24 * HOUR

/** Зигзаг: волны по 20 свечей с размахом 30, чтобы хватило разворотов и на мелкие, и на крупные волны. */
function zigzag(count: number, step: number): Candle[] {
  return Array.from({ length: count }, (_, i) => {
    const phase = i % 40
    const close = 100 + (phase < 20 ? phase : 40 - phase) * 1.5
    const open = i === 0 ? close : 100 + ((i - 1) % 40 < 20 ? (i - 1) % 40 : 40 - ((i - 1) % 40)) * 1.5
    return { openTime: i * step, closeTime: (i + 1) * step, open, close, high: Math.max(open, close) + 0.2, low: Math.min(open, close) - 0.2, volume: 1, turnover: 1 }
  })
}

describe('createMarketAnalysis', () => {
  const analysis = createMarketAnalysis(loadConfig())
  const hourly = zigzag(720, HOUR)
  const daily = zigzag(400, DAY)
  const at = hourly.at(-1)!.closeTime

  it('counts small and big waves and structure on hourly candles', () => {
    expect(analysis.waves(hourly, at, 'small').ok).toBe(true)
    expect(analysis.waves(hourly, at, 'big').ok).toBe(true)
    expect(analysis.structure(hourly, at).ok).toBe(true)
  })

  it('finds levels at the zigzag turns', () => {
    const prices = analysis.levels(daily, hourly).map((level) => level.price)

    expect(prices.some((price) => Math.abs(price - 130.2) < 1)).toBe(true)
  })

  it('needs enough history for EMA 200', () => {
    expect(analysis.ema(hourly, at).ok).toBe(true)
    expect(analysis.ema(hourly.slice(-100), at).ok).toBe(false)
  })
})
