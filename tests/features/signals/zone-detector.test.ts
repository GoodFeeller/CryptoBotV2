import { describe, expect, it } from 'vitest'
import type { MarketAnalysis, MarketData } from '../../../src/core/ports.js'
import type { Candle, EmaSnapshot, Level, StructureSnapshot, Timeframe, WaveDirection, WaveSnapshot } from '../../../src/core/types.js'
import { ZoneDetector, type ZoneDetectorOptions } from '../../../src/features/signals/zone-detector.js'

const HOUR = 3_600_000
const DAY = 24 * HOUR
const NOW = 1000 * HOUR
const OPTIONS: ZoneDetectorOptions = { zoneAtr: 0.5, exhaustedShare: 0.9, maxAsksPerVisit: 3, nearbyLevelsAtr: 3, history: { '1d': 600, '1h': 720 } }

/** Свечи с постоянным диапазоном у 110: ATR часовика 1, дневки 10. Последняя часовая закрывается в now и задаётся отдельно. */
function hourly(now: number, last: { low: number; high: number } | null): Candle[] {
  const flat = Array.from({ length: 50 }, (_, i) => {
    const openTime = now - (51 - i) * HOUR
    return { openTime, closeTime: openTime + HOUR, open: 109.8, high: 110.3, low: 109.3, close: 109.8, volume: 1, turnover: 1 }
  })
  if (!last) return flat
  return [...flat, { openTime: now - HOUR, closeTime: now, open: last.low, high: last.high, low: last.low, close: last.high, volume: 1, turnover: 1 }]
}

function daily(now: number): Candle[] {
  return Array.from({ length: 50 }, (_, i) => {
    const openTime = now - (50 - i) * DAY
    return { openTime, closeTime: openTime + DAY, open: 100, high: 105, low: 95, close: 100, volume: 1, turnover: 1 }
  })
}

function level(price: number, status: Level['status'] = 'active'): Level {
  return { class: 'major', price, status, origins: ['pivot'], bornAt: 0, bounces: 4, falseBreaks: 1, flips: 1, strength: 6, events: [], zones: [] }
}

function waves(direction: WaveDirection, start: number, length: number, share: number): WaveSnapshot {
  const extreme = direction === 'up' ? start + length : start - length
  return {
    ok: true,
    at: NOW,
    close: extreme,
    atr: 1,
    waves: [],
    average: { up: 10, down: 10 },
    averageAtr: { up: 10, down: 10 },
    current: { direction, start: { time: 0, price: start }, extreme: { time: 0, price: extreme }, length, lengthAtr: length, share },
    lastWave: { direction: 'down', top: 130, bottom: 70, middle: 100 },
  }
}

const QUIET = waves('up', 100, 5, 0.5)
const STRUCTURE: StructureSnapshot = {
  ok: true,
  at: NOW,
  close: 110,
  trend: 'flat',
  previousTrend: 'down',
  highs: [{ time: 0, price: 120 }, { time: 1, price: 115 }],
  lows: [{ time: 0, price: 90 }, { time: 1, price: 95 }],
  beyond: null,
}
const EMA: EmaSnapshot = { ok: true, at: NOW, close: 110, emas: [{ period: 20, value: 105, priceSide: 'above', distanceAtr: 5, slope: 'up' }], stack: 'up' }

interface Setup {
  levels?: Level[]
  small?: WaveSnapshot
  big?: WaveSnapshot
  structure?: StructureSnapshot
  dailyEma?: boolean
  last?: (now: number) => { low: number; high: number } | null
}

function detector(setup: Setup): ZoneDetector {
  const market: MarketData = {
    instrument: async () => {
      throw new Error('не нужен')
    },
    candles: async (_symbol: string, tf: Timeframe, endAt: number) =>
      tf === '1d' ? daily(endAt) : hourly(endAt, setup.last ? setup.last(endAt) : { low: 109.3, high: 110.3 }),
    fundingRates: async () => [],
  }
  const analysis: MarketAnalysis = {
    levels: () => setup.levels ?? [level(110)],
    ema: (candles) => (candles[0]!.closeTime - candles[0]!.openTime === DAY && setup.dailyEma === false ? { ok: false, reason: 'not_enough_candles', needed: 600, got: 50 } : EMA),
    waves: (_candles, _at, scale) => (scale === 'small' ? (setup.small ?? waves('up', 100, 10.3, 0.95)) : (setup.big ?? QUIET)),
    structure: () => setup.structure ?? STRUCTURE,
  }
  return new ZoneDetector({ market, analysis, options: OPTIONS })
}

const ask = (d: ZoneDetector, now = NOW, symbol = 'BTCUSDT') => d.detect({ symbol, now, candles: {} })

describe('ZoneDetector', () => {
  it('is a real detector', () => {
    expect(detector({}).isPlaceholder).toBe(false)
  })

  it('a touch at the end of an exhausted small wave gives a zone situation', async () => {
    const situation = await ask(detector({}))

    expect(situation?.kind).toBe('zone')
    expect(situation?.picture?.zone).toEqual({ price: 110, low: 109.5, high: 110.5, reasons: [{ type: 'level', class: 'major', bounces: 4, flips: 1 }] })
    expect(situation?.picture?.waves.small.current).toEqual({ direction: 'up', startPrice: 100, lengthAtr: 10.3, share: 0.95 })
    expect(situation?.picture?.structure).toMatchObject({ trend: 'flat', previousTrend: 'down' })
    expect(situation?.picture?.atrPct['1h']).toBeCloseTo((1 / 110.3) * 100, 6)
  })

  it('a touch without an exhausted wave gives nothing', async () => {
    expect(await ask(detector({ small: QUIET }))).toBeNull()
  })

  it('big wave exhaustion alone is enough', async () => {
    expect(await ask(detector({ small: QUIET, big: { ...waves('up', 100, 10.3, 0.95), lastWave: { direction: 'down', top: 130, bottom: 70, middle: 100 } } }))).not.toBeNull()
  })

  it('a zone in the inner half of the wave gives nothing', async () => {
    expect(await ask(detector({ levels: [level(104)], last: () => ({ low: 103.7, high: 104.3 }) }))).toBeNull()
  })

  it('traded and broken levels are not zones but are in the picture', async () => {
    expect(await ask(detector({ levels: [level(110, 'traded')] }))).toBeNull()

    const situation = await ask(detector({ levels: [level(110), level(112, 'broken'), level(200)] }))
    expect(situation?.picture?.levels.map((item) => [item.price, item.status])).toEqual([
      [110, 'active'],
      [112, 'broken'],
    ])
  })

  it('asks at most 3 times in a row and resets after an hour without a touch', async () => {
    const touchedUnless = (gap: number) => (now: number) => (now === gap ? { low: 100, high: 100.4 } : { low: 109.3, high: 110.3 })
    const d = detector({ last: touchedUnless(NOW + 4 * HOUR) })
    const answers = []
    for (let hour = 0; hour <= 5; hour++) answers.push((await ask(d, NOW + hour * HOUR)) !== null)

    expect(answers).toEqual([true, true, true, false, false, true])
  })

  it('repeats of one coin do not affect another', async () => {
    const d = detector({})
    for (let hour = 0; hour < 4; hour++) await ask(d, NOW + hour * HOUR, 'BTCUSDT')

    expect(await ask(d, NOW + 3 * HOUR, 'ETHUSDT')).not.toBeNull()
  })

  it('a missing last hourly candle gives nothing', async () => {
    expect(await ask(detector({ last: () => null }))).toBeNull()
  })

  it('a young coin without daily EMA still gets situations, with 1h EMA only', async () => {
    const situation = await ask(detector({ dailyEma: false }))

    expect(Object.keys(situation?.picture?.ema ?? {})).toEqual(['1h'])
  })

  it('a zero-length current wave gives nothing', async () => {
    expect(await ask(detector({ small: waves('up', 110, 0, 1) }))).toBeNull()
  })

  it('without structure or without both wave scales there is nothing', async () => {
    const noWaves: WaveSnapshot = { ok: false, reason: 'not_enough_waves', up: 1, down: 1, needed: 3 }

    expect(await ask(detector({ structure: { ok: false, reason: 'not_enough_pivots', highs: 1, lows: 1, needed: 2 } }))).toBeNull()
    expect(await ask(detector({ small: noWaves, big: noWaves }))).toBeNull()
  })
})
