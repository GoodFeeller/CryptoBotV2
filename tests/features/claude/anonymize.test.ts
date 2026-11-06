import { describe, expect, it } from 'vitest'
import type { EntryRequest, MarketPicture } from '../../../src/core/types.js'
import { anonymizeEntry } from '../../../src/features/claude/anonymize.js'

const HOUR = 3_600_000
const AT = 1000 * HOUR
const PRICE = 80_000

const wave = (start: number) => ({
  averageAtr: { up: 3, down: 4 },
  current: { direction: 'up' as const, startPrice: start, lengthAtr: 5, share: 0.95 },
  lastWave: { direction: 'down' as const, top: 84_000, middle: 80_400, bottom: 76_800 },
})

const PICTURE: MarketPicture = {
  zone: { price: 80_800, low: 80_400, high: 81_200, reasons: [{ type: 'wave', part: 'middle' }] },
  levels: [{ price: 81_600, class: 'major', status: 'active', bounces: 4, falseBreaks: 1, flips: 1 }],
  waves: { small: wave(77_600), big: wave(76_000) },
  structure: {
    trend: 'flat',
    previousTrend: 'down',
    beyond: null,
    highs: [{ time: AT - 30 * HOUR, price: 85_600 }, { time: AT - 10 * HOUR, price: 82_400 }],
    lows: [{ time: AT - 40 * HOUR, price: 74_400 }, { time: AT - 20 * HOUR, price: 75_200 }],
  },
  ema: { '1h': { stack: 'up', emas: [{ period: 20, value: 79_200, priceSide: 'above', distanceAtr: 1.2, slope: 'up' }] } },
  atrPct: { '1h': 0.8, '1d': 3.1 },
}

const REAL_PRICES = [80_800, 80_400, 81_200, 81_600, 77_600, 76_000, 84_000, 80_400, 76_800, 85_600, 82_400, 74_400, 75_200, 79_200]

function request(picture: MarketPicture | null): EntryRequest {
  return { situation: { symbol: 'BTCUSDT', kind: 'zone', at: AT, picture }, currentPrice: PRICE, candles: {}, maxLossPct: 10 }
}

function numbers(value: unknown): number[] {
  if (typeof value === 'number') return [value]
  if (Array.isArray(value)) return value.flatMap(numbers)
  if (value && typeof value === 'object') return Object.values(value).flatMap(numbers)
  return []
}

describe('anonymize market picture', () => {
  const picture = anonymizeEntry(request(PICTURE)).body.situation.picture!

  it('every price in the picture is on the scale', () => {
    expect(picture.zone).toMatchObject({ price: 101, low: 100.5, high: 101.5 })
    expect(picture.levels[0]!.price).toBe(102)
    expect(picture.waves.small.current.startPrice).toBe(97)
    expect(picture.waves.big.lastWave).toEqual({ direction: 'down', top: 105, middle: 100.5, bottom: 96 })
    expect(picture.ema['1h']!.emas[0]!.value).toBe(99)
    expect(picture.structure.highs.map((point) => point.price)).toEqual([107, 103])
  })

  it('keeps relative values as they are', () => {
    expect(picture.waves.small.current).toMatchObject({ lengthAtr: 5, share: 0.95 })
    expect(picture.ema['1h']!.emas[0]!.distanceAtr).toBe(1.2)
    expect(picture.atrPct).toEqual({ '1h': 0.8, '1d': 3.1 })
  })

  it('no real price leaks into the request', () => {
    const sent = numbers(anonymizeEntry(request(PICTURE)).body)

    for (const price of REAL_PRICES) expect(sent).not.toContain(price)
  })

  it('structure points are given as bars ago, without times', () => {
    expect(picture.structure.lows).toEqual([
      { barsAgo: 40, price: 93 },
      { barsAgo: 20, price: 94 },
    ])
    expect(JSON.stringify(picture)).not.toContain(String(AT - 40 * HOUR))
  })

  it('a situation without a picture stays null', () => {
    expect(anonymizeEntry(request(null)).body.situation).toEqual({ kind: 'zone', picture: null })
  })
})

describe('prompt v2', () => {
  it('is registered and explains the zone setup', async () => {
    const { SYSTEM_PROMPTS } = await import('../../../src/features/claude/decision-advisor.js')

    expect(SYSTEM_PROMPTS.v2).toContain('5m')
    expect(SYSTEM_PROMPTS.v2).toContain('post-only')
    expect(SYSTEM_PROMPTS.v2).toContain('не ближе 0.3% от entryPrice')
    expect(SYSTEM_PROMPTS.v1).toBeDefined()
  })
})
