import { describe, expect, it } from 'vitest'
import type { MarketData } from '../../../src/core/ports.js'
import { ClampedMarketData } from '../../../src/features/market-data/clamped-market-data.js'

const NOW = 1_000_000

function recording(): { inner: MarketData; calls: unknown[][] } {
  const calls: unknown[][] = []
  const inner: MarketData = {
    instrument: async () => {
      throw new Error('not used')
    },
    candles: async (symbol, tf, endAt, limit) => {
      calls.push(['candles', symbol, tf, endAt, limit])
      return []
    },
    fundingRates: async (symbol, from, to) => {
      calls.push(['fundingRates', symbol, from, to])
      return []
    },
  }
  return { inner, calls }
}

describe('ClampedMarketData', () => {
  const clock = { now: () => NOW }

  it('clamps candles endAt to the clock', async () => {
    const { inner, calls } = recording()

    await new ClampedMarketData(inner, clock).candles('BTCUSDT', '1h', NOW + 5, 3)

    expect(calls[0]).toEqual(['candles', 'BTCUSDT', '1h', NOW, 3])
  })

  it('keeps an earlier endAt unchanged', async () => {
    const { inner, calls } = recording()

    await new ClampedMarketData(inner, clock).candles('BTCUSDT', '1h', NOW - 5, 3)

    expect(calls[0]).toEqual(['candles', 'BTCUSDT', '1h', NOW - 5, 3])
  })

  it('clamps fundingRates', async () => {
    const { inner, calls } = recording()

    await new ClampedMarketData(inner, clock).fundingRates('BTCUSDT', 0, NOW + 5)

    expect(calls[0]).toEqual(['fundingRates', 'BTCUSDT', 0, NOW])
  })
})
