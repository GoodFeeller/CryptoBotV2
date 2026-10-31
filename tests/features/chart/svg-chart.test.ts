import { describe, expect, it } from 'vitest'
import type { ChartInput } from '../../../src/core/ports.js'
import type { Candle } from '../../../src/core/types.js'
import { buildChartSvg, SvgChartRenderer } from '../../../src/features/chart/svg-chart.js'

const HOUR = 3_600_000
const T0 = Date.UTC(2026, 0, 1)

function candles(count: number): Candle[] {
  return Array.from({ length: count }, (_, i) => {
    const open = 100 + i
    return {
      openTime: T0 + i * HOUR,
      closeTime: T0 + (i + 1) * HOUR,
      open,
      high: open + 2,
      low: open - 2,
      close: open + (i % 2 === 0 ? 1 : -1),
      volume: 1,
      turnover: 1,
    }
  })
}

const INPUT: ChartInput = {
  symbol: 'BTCUSDT',
  side: 'long',
  candles: candles(20),
  entryPrice: 110,
  stop: 105,
  take: 125,
}
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47]

describe('svg chart', () => {
  it('renders a valid PNG', async () => {
    const png = await new SvgChartRenderer().render(INPUT)

    expect([...png.slice(0, 4)]).toEqual(PNG_SIGNATURE)
    expect(png.length).toBeGreaterThan(1000)
  })

  it('draws every candle and the three lines', () => {
    const svg = buildChartSvg(INPUT)

    expect(svg.match(/data-role="body"/g)).toHaveLength(20)
    for (const role of ['entry', 'stop', 'take']) expect(svg).toContain(`data-role="${role}"`)
    expect(svg).toContain('BTCUSDT')
  })

  it('shows an exit point only for a closed trade', () => {
    expect(buildChartSvg(INPUT)).not.toContain('data-role="exit"')
    expect(buildChartSvg({ ...INPUT, exit: { price: 124, time: T0 + 10 * HOUR } })).toContain('data-role="exit"')
  })

  it('keeps stop and take on the chart even when far from candles', () => {
    const svg = buildChartSvg({ ...INPUT, take: 500 })
    const y = Number(/data-role="take"[^>]*y1="([\d.]+)"/.exec(svg)?.[1])

    expect(y).toBeGreaterThanOrEqual(0)
  })

  it('renders with one candle and with flat prices', async () => {
    const flat: Candle = { ...candles(1)[0]!, open: 100, high: 100, low: 100, close: 100 }

    const png = await new SvgChartRenderer().render({ ...INPUT, candles: [flat], entryPrice: 100, stop: 100, take: 100 })

    expect([...png.slice(0, 4)]).toEqual(PNG_SIGNATURE)
  })

  it('renders without candles', async () => {
    const png = await new SvgChartRenderer().render({ ...INPUT, candles: [] })

    expect([...png.slice(0, 4)]).toEqual(PNG_SIGNATURE)
  })
})
