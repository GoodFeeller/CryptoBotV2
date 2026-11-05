import { describe, expect, it } from 'vitest'
import type { Candle, Level, WaveSnapshot } from '../../../src/core/types.js'
import { buildZones, inOuterHalf, touches, type Zone } from '../../../src/features/signals/zones.js'

function level(price: number, status: Level['status'] = 'active'): Level {
  return { class: 'major', price, status, origins: ['pivot'], bornAt: 0, bounces: 3, falseBreaks: 0, flips: 1, strength: 5, events: [], zones: [] }
}

function bigWaves(top: number, bottom: number): WaveSnapshot {
  const point = { time: 0, price: 0 }
  return {
    ok: true,
    at: 0,
    close: 0,
    atr: 1,
    waves: [],
    average: { up: 10, down: 10 },
    averageAtr: { up: 10, down: 10 },
    current: { direction: 'up', start: point, extreme: point, length: 0, lengthAtr: 0, share: 0 },
    lastWave: { direction: 'up', top, bottom, middle: (top + bottom) / 2 },
  }
}

const NO_WAVES: WaveSnapshot = { ok: false, reason: 'not_enough_waves', up: 0, down: 0, needed: 3 }

function candle(low: number, high: number): Candle {
  return { openTime: 0, closeTime: 1, open: low, high, low, close: high, volume: 1, turnover: 1 }
}

describe('buildZones', () => {
  it('active levels become zones, traded and broken do not', () => {
    const zones = buildZones([level(100), level(120, 'traded'), level(140, 'broken')], NO_WAVES, 1, 0.5)

    expect(zones).toEqual([{ price: 100, low: 99.5, high: 100.5, reasons: [{ type: 'level', class: 'major', bounces: 3, flips: 1 }] }])
  })

  it('wave top, middle and bottom become zones', () => {
    const zones = buildZones([], bigWaves(120, 80), 1, 0.5)

    expect(zones.map((zone) => [zone.price, zone.reasons])).toEqual([
      [80, [{ type: 'wave', part: 'bottom' }]],
      [100, [{ type: 'wave', part: 'middle' }]],
      [120, [{ type: 'wave', part: 'top' }]],
    ])
  })

  it('a level on the wave middle is one zone with two reasons', () => {
    const zones = buildZones([level(100.2)], bigWaves(120, 80), 1, 0.5)
    const middle = zones.find((zone) => zone.reasons.length === 2)!

    expect(zones).toHaveLength(3)
    expect(middle.low).toBeCloseTo(99.5, 9)
    expect(middle.high).toBeCloseTo(100.7, 9)
    expect(middle.price).toBeCloseTo(100.1, 9)
  })

  it('zones farther apart than their widths stay separate', () => {
    expect(buildZones([level(100), level(101.5)], NO_WAVES, 1, 0.5)).toHaveLength(2)
  })
})

describe('touches', () => {
  const zone: Zone = { price: 100, low: 99.5, high: 100.5, reasons: [] }

  it('is true when the candle range crosses the zone', () => {
    expect(touches(zone, candle(100.2, 103))).toBe(true)
    expect(touches(zone, candle(97, 99.8))).toBe(true)
    expect(touches(zone, candle(97, 103))).toBe(true)
  })

  it('is false when the candle is entirely above or below', () => {
    expect(touches(zone, candle(100.6, 103))).toBe(false)
    expect(touches(zone, candle(97, 99.4))).toBe(false)
  })
})

describe('inOuterHalf', () => {
  const at = (price: number): Zone => ({ price, low: price - 0.5, high: price + 0.5, reasons: [] })

  it('for an up wave the zone must be in the upper half', () => {
    const wave = { direction: 'up' as const, start: { time: 0, price: 100 }, length: 20 }

    expect(inOuterHalf(at(115), wave)).toBe(true)
    expect(inOuterHalf(at(105), wave)).toBe(false)
  })

  it('for a down wave the zone must be in the lower half', () => {
    const wave = { direction: 'down' as const, start: { time: 0, price: 100 }, length: 20 }

    expect(inOuterHalf(at(85), wave)).toBe(true)
    expect(inOuterHalf(at(95), wave)).toBe(false)
  })

  it('a zero-length wave has no outer half', () => {
    expect(inOuterHalf(at(100), { direction: 'up', start: { time: 0, price: 100 }, length: 0 })).toBe(false)
  })
})
