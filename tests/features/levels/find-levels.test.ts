import { describe, expect, it } from 'vitest'
import type { Candle, Level } from '../../../src/core/types.js'
import {
  combineLevels,
  findLevels,
  MAJOR_LEVELS,
  type LevelOptions,
} from '../../../src/features/levels/find-levels.js'

const DAY = 86_400_000
const T0 = Date.UTC(2026, 0, 1)
const OPTIONS: LevelOptions = { ...MAJOR_LEVELS, maxLevels: 20, minBounces: 1 }

/** Свечи из цен закрытия: движение по прямой между точками, тени по 0.1. */
function path(points: number[], perLeg = 5): Candle[] {
  const closes: number[] = [points[0]!]
  for (let i = 1; i < points.length; i++) {
    for (let step = 1; step <= perLeg; step++) {
      closes.push(points[i - 1]! + ((points[i]! - points[i - 1]!) * step) / perLeg)
    }
  }
  return closes.map((close, i) => bar(i, closes[i - 1] ?? close, close))
}

function bar(index: number, open: number, close: number, wickUp = 0.1, wickDown = 0.1): Candle {
  const openTime = T0 + index * DAY
  return {
    openTime,
    closeTime: openTime + DAY,
    open,
    close,
    high: Math.max(open, close) + wickUp,
    low: Math.min(open, close) - wickDown,
    volume: 1,
    turnover: 1,
  }
}

function near(levels: Level[], price: number, tolerance = 2): Level | undefined {
  return levels.find((level) => Math.abs(level.price - price) <= tolerance)
}

describe('findLevels', () => {
  it('returns nothing without enough candles', () => {
    expect(findLevels([], OPTIONS)).toEqual([])
    expect(findLevels(path([100, 101], 2), OPTIONS)).toEqual([])
  })

  it('a straight trend has no levels', () => {
    expect(findLevels(path([100, 200], 40), OPTIONS)).toEqual([])
  })

  it('finds support and resistance of a range and counts bounces', () => {
    const levels = findLevels(path([100, 120, 100, 120, 100, 120, 100, 120]), OPTIONS)

    expect(near(levels, 100)?.bounces).toBe(3)
    expect(near(levels, 120)?.bounces).toBeGreaterThanOrEqual(3)
    expect(near(levels, 110)).toBeUndefined()
  })

  it('more bounces make a stronger level', () => {
    const levels = findLevels(path([100, 120, 100, 120, 100, 120, 105, 125, 110, 130]), OPTIONS)
    const strong = near(levels, 100)!
    const weak = near(levels, 105)

    expect(strong.bounces).toBeGreaterThan(weak?.bounces ?? 0)
    expect(strong.strength).toBeGreaterThan(weak?.strength ?? 0)
  })

  it('does not count a touch until price has left the level', () => {
    const base = path([100, 120, 100, 120, 100])
    const next = base.length
    // Цена дрожит у уровня и никуда не уходит
    const jitter = [100.2, 100.1, 100.3, 100.2].map((close, i) => bar(next + i, 100.2, close))

    const withJitter = near(findLevels([...base, ...jitter], OPTIONS), 100)

    expect(withJitter?.bounces).toBe(1)
  })

  it('a wick that stops short of the level is not a touch', () => {
    // Недолёт около 0.95 при ATR около 4.2: ближе 0.25 ATR, но дальше 0.2 ATR.
    const touched = near(findLevels(path([100, 120, 100, 120, 100, 120, 100, 120]), OPTIONS), 100, 0.5)!
    const short = near(findLevels(path([100, 120, 100, 120, 100, 120, 100.95, 120]), OPTIONS), 100, 0.5)!

    expect(short.bounces).toBe(touched.bounces - 1)
  })

  it('a false break keeps the level and is counted', () => {
    const before = path([100, 120, 100, 120])
    const dip = before.length
    const fall = [116, 112, 108, 104].map((close, i) => bar(dip + i, close + 4, close))
    const trap = bar(dip + 4, 104, 101, 0.1, 5) // тень до 96, закрытие над уровнем
    const away = [106, 111, 116, 120].map((close, i) => bar(dip + 5 + i, close - 5, close))

    const level = near(findLevels([...before, ...fall, trap, ...away], OPTIONS), 100)

    expect(level?.falseBreaks).toBe(1)
    expect(level?.events.some((event) => event.type === 'false_break')).toBe(true)
    expect(level?.bounces).toBe(2)
  })

  it('a close beyond the level with a return next candle is a false break', () => {
    const before = path([100, 120, 100, 120])
    const dip = before.length
    const fall = [116, 112, 108, 104, 100.5].map((close, i) => bar(dip + i, close + 4, close))
    const beyond = bar(dip + 5, 100.5, 96)
    const back = bar(dip + 6, 96, 102)
    const away = [107, 112, 117].map((close, i) => bar(dip + 7 + i, close - 5, close))

    const level = near(findLevels([...before, ...fall, beyond, back, ...away], OPTIONS), 100)

    expect(level?.falseBreaks).toBe(1)
    expect(level?.flips).toBe(0)
  })

  it('a broken support that holds from below becomes a mirror level', () => {
    const levels = findLevels(path([100, 120, 100, 120, 100, 80, 100, 80, 100, 80]), OPTIONS)
    const level = near(levels, 100)!

    expect(level.flips).toBe(1)
    expect(level.events.at(-1)?.side).toBe('below')
    expect(level.events[0]?.side).toBe('above')
  })

  it('a broken level without a bounce from the new side is broken', () => {
    const level = near(findLevels(path([100, 120, 100, 120, 100, 80, 70, 60]), OPTIONS), 100)!

    expect(level.status).toBe('broken')
  })

  it('price just past the level is a test, not yet a break', () => {
    const level = near(findLevels(path([100, 120, 100, 120, 100, 120, 100, 98]), OPTIONS), 100)!

    expect(level.status).toBe('active')
  })

  it('two closes above a resistance and a fall far below do not break it', () => {
    const base = path([120, 100, 120, 100, 116])
    const closes = [118, 122, 123, 118, 112, 106, 100, 94, 88, 82]
    const candles = [...base, ...closes.map((close, i) => bar(base.length + i, closes[i - 1] ?? 116, close))]
    const level = near(findLevels(candles, OPTIONS), 120)!

    expect(level.status).toBe('active')
  })

  it('three closes above a resistance and a fall far below break it', () => {
    const base = path([120, 100, 120, 100, 116])
    const closes = [118, 121.5, 123, 121.4, 117, 112, 106, 100, 94, 88, 82]
    const candles = [...base, ...closes.map((close, i) => bar(base.length + i, closes[i - 1] ?? 116, close))]
    const level = near(findLevels(candles, OPTIONS), 120)!

    expect(level.status).toBe('broken')
  })

  it('a far trip above a resistance and back down without a bounce leaves it broken', () => {
    const level = near(findLevels(path([120, 100, 120, 100, 120, 140, 100, 90, 80]), OPTIONS), 120)!

    expect(level.status).toBe('broken')
  })

  it('a bounce from the new side confirms a broken level', () => {
    const level = near(findLevels(path([100, 120, 100, 120, 100, 80, 100, 80]), OPTIONS), 100)!

    expect(level.status).toBe('active')
  })

  it('a mirror level is stronger than the same level without a flip', () => {
    const mirror = near(findLevels(path([100, 120, 100, 120, 100, 80, 100, 70]), OPTIONS), 100)!
    const plain = near(findLevels(path([100, 120, 100, 120, 100, 120, 100, 130]), OPTIONS), 100)!

    expect(mirror.flips).toBe(1)
    expect(mirror.strength - mirror.bounces).toBeGreaterThan(plain.strength - plain.bounces)
  })

  it('marks a turn that led to a new high as a trend break', () => {
    const levels = findLevels(path([100, 120, 110, 130, 115]), OPTIONS)

    expect(near(levels, 110)?.origins).toContain('trend_break')
  })

  it('marks repeated extremes at one price as a consolidation with a zone', () => {
    const start = path([120, 100], 8)
    const next = start.length
    const flat = [103, 101, 103, 101, 103, 101].map((close, i) => bar(next + i, 102, close, 0.1, Math.abs(close - 100)))
    const away = [108, 114, 120, 126].map((close, i) => bar(next + 6 + i, close - 6, close))

    const level = near(findLevels([...start, ...flat, ...away], OPTIONS), 100)

    expect(level?.origins).toContain('consolidation')
    expect(level?.zones.length).toBeGreaterThan(0)
  })

  it('does not draw a consolidation zone around a big move', () => {
    const start = path([120, 100], 8)
    const next = start.length
    const swings = [103, 101, 118, 101, 103, 101].map((close, i) => bar(next + i, 102, close, 0.1, Math.abs(Math.min(close, 102) - 100)))
    const away = [108, 114, 120, 126].map((close, i) => bar(next + 6 + i, close - 6, close))

    const level = near(findLevels([...start, ...swings, ...away], OPTIONS), 100)

    expect(level?.zones.every((zone) => zone.high < 110)).toBe(true)
  })

  it('marks a turn on a very long candle as paranormal', () => {
    const fall = path([140, 110], 15)
    const next = fall.length
    const long = bar(next, 110, 106, 0.1, 20) // тень до 86
    const away = [109, 113, 117, 121, 125].map((close, i) => bar(next + 1 + i, close - 4, close))

    const level = near(findLevels([...fall, long, ...away], OPTIONS), 86)

    expect(level?.origins).toContain('paranormal_bar')
  })

  it('merges close prices into one level', () => {
    const levels = findLevels(path([100, 120, 100.5, 120, 99.5, 120]), OPTIONS)

    expect(levels.filter((level) => Math.abs(level.price - 100) < 5)).toHaveLength(1)
    expect(near(levels, 100)?.price).toBeCloseTo(100, 0)
  })

  it('a level is born only after its turn is confirmed', () => {
    const candles = path([100, 120, 100, 120])
    const level = near(findLevels(candles, OPTIONS), 100)!
    const pivotOpen = candles.reduce((low, candle) => (candle.low < low.low ? candle : low)).openTime

    expect(level.bornAt).toBeGreaterThan(pivotOpen)
    for (const candle of [...candles].slice(0, 5)) expect(level.bornAt).toBeGreaterThan(candle.openTime)
  })

  it('does not see an unconfirmed turn at the right edge', () => {
    const candles = path([100, 120, 100, 120, 119], 5)

    expect(near(findLevels(candles, OPTIONS), 120)?.bounces).toBeGreaterThanOrEqual(1)
    expect(findLevels(path([100, 120], 5), OPTIONS).some((level) => Math.abs(level.price - 120) < 2)).toBe(false)
  })

  it('keeps only the strongest levels, spaced apart', () => {
    const candles = path([100, 120, 100, 120, 100, 120, 104, 124, 108, 128, 112, 132, 116, 136])

    const levels = findLevels(candles, { ...OPTIONS, maxLevels: 2, minBounces: 1 })

    expect(levels).toHaveLength(2)
    expect(levels[0]!.strength).toBeGreaterThanOrEqual(levels[1]!.strength)
    expect(Math.abs(levels[0]!.price - levels[1]!.price)).toBeGreaterThan(OPTIONS.minGapAtr)
  })

  it('drops levels below minBounces', () => {
    const levels = findLevels(path([100, 120, 90, 130, 80, 140, 70], 12), { ...OPTIONS, minBounces: 2 })

    expect(levels).toEqual([])
  })

  it('labels the class', () => {
    const levels = findLevels(path([100, 120, 100, 120, 100, 120]), OPTIONS)

    expect(levels[0]?.class).toBe('major')
  })
})

// Без интервала: края боковика в этих сериях не должны скрывать сам уровень.
const TRADED: LevelOptions = { ...OPTIONS, minGapAtr: 0 }

describe('traded levels', () => {
  /** Уровень у 100 и цена, которая долго ходит вокруг него. */
  function chopped(): Candle[] {
    const base = path([100, 120, 100, 120, 100])
    const next = base.length
    // Экстремумы разные: иначе край боковика сам стал бы уровнем
    const closes = [102, 98.8, 103.1, 97.4, 101.2, 99.1, 102.6, 96.6, 101.7, 98.2]
    return [...base, ...closes.map((close, i) => bar(next + i, closes[i - 1] ?? 100, close))]
  }

  function continued(candles: Candle[], closes: number[], wickDown = 0.1): Candle[] {
    const next = candles.length
    return [
      ...candles,
      ...closes.map((close, i) => bar(next + i, closes[i - 1] ?? candles.at(-1)!.close, close, 0.1, wickDown)),
    ]
  }

  it('a level with clean bounces is active', () => {
    expect(near(findLevels(path([100, 120, 100, 120, 100, 120]), TRADED), 100, 0.5)?.status).toBe('active')
  })

  it('long trading around the level makes it traded', () => {
    expect(near(findLevels(chopped(), TRADED), 100, 0.5)?.status).toBe('traded')
  })

  it('rare visits spread over time are not trading around the level', () => {
    const visits = path([100, 112, 101, 112, 101, 112, 101, 112, 101, 112, 101, 112, 101, 120], 4)

    expect(near(findLevels(visits, OPTIONS), 100, 3)?.status).toBe('active')
  })

  it('leaving the chop is not a confirmation', () => {
    const left = continued(chopped(), [104, 108, 112, 116, 120])

    expect(near(findLevels(left, TRADED), 100, 0.5)?.status).toBe('traded')
  })

  it('a new clean bounce confirms the level again', () => {
    const left = continued(chopped(), [104, 108, 112, 116, 120])
    const back = continued(left, [116, 112, 108, 104, 100.3, 104, 108, 112, 116, 120])

    expect(near(findLevels(back, TRADED), 100, 0.5)?.status).toBe('active')
  })

  it('a slow drift away from a touch is not a confirmation', () => {
    const slow = continued(chopped(), [101, 101.5, 102, 102.5, 103, 103.5, 104, 104.5, 105, 106, 107, 108])

    expect(near(findLevels(slow, TRADED), 100, 0.5)?.status).toBe('traded')
  })

  /** Медленные отскоки от 100.3: ровный дрейф по 1 за свечу. Длинные верхние тени держат ATR высоким, поэтому цена уходит дальше
   * 1 ATR, но не рывком на 2 ATR. Тени смотрят от уровня и не добавляют минимумов рядом с ним. С leave цена сначала уходит от
   * проторговки далеко и только потом возвращается к уровню. */
  function slowBounces(candles: Candle[], count: number, leave: boolean): Candle[] {
    const rise = [101.3, 102.3, 103.3, 104.3, 105.3, 106.3, 107.3, 108.3]
    const fall = [107.3, 106.3, 105.3, 104.3, 103.3, 102.3, 101.3, 100.3]
    const away = leave ? [104, 108, 112, 116, 120, 116, 112, 108, 104] : []
    const closes = [...away, 100.3, ...Array.from({ length: count }, () => [...rise, ...fall]).flat(), ...rise]
    const next = candles.length
    return [...candles, ...closes.map((close, i) => bar(next + i, closes[i - 1] ?? candles.at(-1)!.close, close, 3, 0.1))]
  }

  it('one slow bounce after a return is not a confirmation', () => {
    expect(near(findLevels(slowBounces(chopped(), 0, true), TRADED), 100, 0.5)?.status).toBe('traded')
  })

  it('two slow bounces on one side after a return confirm the level again', () => {
    expect(near(findLevels(slowBounces(chopped(), 1, true), TRADED), 100, 0.5)?.status).toBe('active')
  })

  it('slow bounces right after the chop, before price has left, are still the chop', () => {
    expect(near(findLevels(slowBounces(chopped(), 2, false), TRADED), 100, 0.5)?.status).toBe('traded')
  })
})

describe('selection', () => {
  it('a dropped unreliable level does not let its weak neighbour in', () => {
    // 100 часто пробивают, 103 рядом с ним слабее и не должен занять его место
    const candles = path([100, 120, 100, 80, 100, 120, 100, 80, 103, 125, 103.5, 90], 8)
    const levels = findLevels(candles, { ...OPTIONS, minBounces: 1, maxFlipShare: 0 })

    expect(near(levels, 103, 1)?.flips ?? 0).toBe(0)
    expect(levels.every((level) => level.flips === 0)).toBe(true)
  })
})

describe('unreliable levels', () => {
  it('drops a level broken more often than it holds', () => {
    const levels = findLevels(path([100, 120, 100, 80, 100, 120, 100, 80, 100, 120, 100, 80], 8), OPTIONS)

    for (const level of levels) expect(level.flips / level.bounces).toBeLessThanOrEqual(OPTIONS.maxFlipShare)
  })
})

describe('combineLevels', () => {
  const level = (cls: Level['class'], price: number): Level => ({
    class: cls,
    price,
    status: 'active',
    origins: ['pivot'],
    bornAt: 0,
    bounces: 2,
    falseBreaks: 0,
    flips: 0,
    strength: 2,
    events: [],
    zones: [],
  })

  it('drops a local level next to a major one and keeps the others', () => {
    const result = combineLevels([level('major', 100)], [level('local', 100.4), level('local', 105)], 1)

    expect(result.map((item) => [item.class, item.price])).toEqual([
      ['major', 100],
      ['local', 105],
    ])
  })
})
