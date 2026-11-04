import { describe, expect, it } from 'vitest'
import type { Candle, Level } from '../../../src/core/types.js'
import { buildLevelsSvg, renderLevelsPng } from '../../../src/features/chart/levels-chart.js'

const DAY = 86_400_000
const T0 = Date.UTC(2026, 0, 1)

const CANDLES: Candle[] = Array.from({ length: 30 }, (_, i) => ({
  openTime: T0 + i * DAY,
  closeTime: T0 + (i + 1) * DAY,
  open: 100 + i,
  high: 102 + i,
  low: 98 + i,
  close: 101 + i,
  volume: 1,
  turnover: 1,
}))

const LEVEL: Level = {
  class: 'major',
  price: 110,
  status: 'active',
  origins: ['trend_break'],
  bornAt: T0 + 5 * DAY,
  bounces: 3,
  falseBreaks: 1,
  flips: 1,
  strength: 6,
  events: [
    { time: T0 + 6 * DAY, type: 'bounce', side: 'above' },
    { time: T0 + 12 * DAY, type: 'false_break', side: 'above' },
  ],
  zones: [{ from: T0 + 8 * DAY, to: T0 + 10 * DAY, low: 108, high: 112 }],
}

describe('levels chart', () => {
  const svg = buildLevelsSvg({ title: 'BTCUSDT 1d', candles: CANDLES, levels: [LEVEL] })

  it('draws a major level from its birth with its label', () => {
    const line = /<line data-role="level-major"[^>]*x1="([\d.]+)"/.exec(svg)

    expect(Number(line?.[1])).toBeGreaterThan(100)
    expect(svg).toContain('110')
    expect(svg).toContain('отскоков 3')
  })

  it('draws a local level dashed', () => {
    const local = buildLevelsSvg({ title: 't', candles: CANDLES, levels: [{ ...LEVEL, class: 'local' }] })

    expect(/<line data-role="level-local"[^>]*stroke-dasharray/.test(local)).toBe(true)
  })

  it('a traded level looks different and is labelled', () => {
    const traded = buildLevelsSvg({ title: 't', candles: CANDLES, levels: [{ ...LEVEL, status: 'traded' }] })

    expect(traded).toContain('проторгован')
    expect(/<line data-role="level-major"[^>]*stroke-dasharray/.test(traded)).toBe(true)
    expect(svg).not.toContain('проторгован')
  })

  it('marks bounces, false breaks and zones', () => {
    expect(svg).toContain('data-role="bounce"')
    expect(svg).toContain('data-role="false-break"')
    expect(svg).toContain('data-role="zone"')
  })

  it('does not draw a zone that ended before the visible candles', () => {
    const old = { from: T0 - 20 * DAY, to: T0 - 10 * DAY, low: 100, high: 120 }

    const chart = buildLevelsSvg({ title: 't', candles: CANDLES, levels: [{ ...LEVEL, zones: [old] }] })

    expect(chart).not.toContain('data-role="zone"')
  })

  it('does not stretch the scale for a far level, and skips it', () => {
    const far = buildLevelsSvg({ title: 't', candles: CANDLES, levels: [{ ...LEVEL, price: 5000 }] })

    expect(far).not.toContain('data-role="level-major"')
  })

  it('renders a PNG, also without levels and candles', () => {
    const signature = [0x89, 0x50, 0x4e, 0x47]

    expect([...renderLevelsPng({ title: 't', candles: CANDLES, levels: [LEVEL] }).slice(0, 4)]).toEqual(signature)
    expect([...renderLevelsPng({ title: 't', candles: [], levels: [] }).slice(0, 4)]).toEqual(signature)
  })
})
