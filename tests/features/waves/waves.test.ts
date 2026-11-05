import { describe, expect, it } from 'vitest'
import type { Candle } from '../../../src/core/types.js'
import { waveSnapshot, type WaveOptions } from '../../../src/features/waves/waves.js'

const HOUR = 3_600_000
const T0 = Date.UTC(2026, 0, 1)
const OPTIONS: WaveOptions = { swingAtr: 1.5, atrPeriod: 5, sampleWaves: 6, minWaves: 3 }

/** Свечи по прямой между точками, по 5 свечей на отрезок, тени по 0.1: экстремумы волн на 0.1 дальше точек. */
function path(points: number[]): Candle[] {
  const closes: number[] = [points[0]!]
  for (let i = 1; i < points.length; i++) {
    for (let step = 1; step <= 5; step++) closes.push(points[i - 1]! + ((points[i]! - points[i - 1]!) * step) / 5)
  }
  return closes.map((close, i) => {
    const open = closes[i - 1] ?? close
    const openTime = T0 + i * HOUR
    return { openTime, closeTime: openTime + HOUR, open, close, high: Math.max(open, close) + 0.1, low: Math.min(open, close) - 0.1, volume: 1, turnover: 1 }
  })
}

const end = (candles: Candle[]): number => candles.at(-1)!.closeTime

// Волны вверх на 20, вниз на 15, и в конце незавершённая волна вверх от 120 до 130.
const ZIGZAG = path([100, 120, 105, 125, 110, 130, 115, 135, 120, 130])

describe('waveSnapshot', () => {
  it('measures the typical length of up and down waves separately', () => {
    const snapshot = waveSnapshot(ZIGZAG, end(ZIGZAG), OPTIONS)

    expect(snapshot.ok).toBe(true)
    if (!snapshot.ok) return
    expect(snapshot.average.up).toBeCloseTo(20.2, 6)
    expect(snapshot.average.down).toBeCloseTo(15.2, 6)
    expect(snapshot.waves.map((wave) => wave.direction)).toEqual(['down', 'up', 'down', 'up', 'down', 'up', 'down'])
  })

  it('tells how far the current wave has gone and what share of a typical wave that is', () => {
    const snapshot = waveSnapshot(ZIGZAG, end(ZIGZAG), OPTIONS)

    expect(snapshot.ok && snapshot.current.direction).toBe('up')
    expect(snapshot.ok && snapshot.current.start.price).toBeCloseTo(119.9, 6)
    expect(snapshot.ok && snapshot.current.length).toBeCloseTo(10.2, 6)
    expect(snapshot.ok && snapshot.current.share).toBeCloseTo(10.2 / 20.2, 6)
  })

  it('gives the top, bottom and middle of the last finished wave', () => {
    const snapshot = waveSnapshot(ZIGZAG, end(ZIGZAG), OPTIONS)

    expect(snapshot.ok && snapshot.lastWave).toEqual({ direction: 'down', top: 135.1, bottom: 119.9, middle: 127.5 })
  })

  it('gives lengths in ATR as well', () => {
    const snapshot = waveSnapshot(ZIGZAG, end(ZIGZAG), OPTIONS)

    expect(snapshot.ok && snapshot.current.lengthAtr).toBeCloseTo(snapshot.ok ? snapshot.current.length / snapshot.atr : 0, 9)
    expect(snapshot.ok && snapshot.averageAtr.up).toBeCloseTo(snapshot.ok ? snapshot.average.up / snapshot.atr : 0, 9)
  })

  it('one huge wave does not move the typical length', () => {
    const withSpike = path([100, 120, 105, 125, 110, 190, 175, 195, 180, 200, 185, 192])
    const snapshot = waveSnapshot(withSpike, end(withSpike), OPTIONS)

    expect(snapshot.ok && snapshot.average.up).toBeCloseTo(20.2, 6)
  })

  it('takes the middle wave by length, not the average', () => {
    // Волны вверх на 20.2, 30.2 и 15.2: медиана 20.2, а среднее было бы 21.9.
    const series = path([100, 110, 100, 120, 100, 130, 100, 115, 100, 108])
    const snapshot = waveSnapshot(series, end(series), OPTIONS)

    expect(snapshot.ok && snapshot.average.up).toBeCloseTo(20.2, 6)
  })

  it('takes only the last sampleWaves waves of each direction', () => {
    // Четыре ранние волны вверх на 40 и три поздние на 10. По всем семи медиана была бы 40, по трём последним 10.
    const series = path([100, 140, 125, 165, 150, 190, 175, 215, 205, 215, 205, 215, 205, 215, 205, 210])
    const snapshot = waveSnapshot(series, end(series), { ...OPTIONS, sampleWaves: 3 })

    expect(snapshot.ok && snapshot.average.up).toBeCloseTo(10.2, 6)
  })

  it('does not see candles that close after the moment', () => {
    const at = end(ZIGZAG)
    const withFuture = [...ZIGZAG, ...path([130, 60, 90]).map((candle) => ({ ...candle, openTime: candle.openTime + at - T0, closeTime: candle.closeTime + at - T0 }))]

    expect(waveSnapshot(withFuture, at, OPTIONS)).toEqual(waveSnapshot(ZIGZAG, at, OPTIONS))
  })

  it('refuses to answer without enough finished waves in each direction', () => {
    // Первое движение от начала графика не волна: его начало не разворот. Остаются вниз, вверх, вниз.
    const short = path([100, 120, 105, 125, 110, 118])

    expect(waveSnapshot(short, end(short), OPTIONS)).toEqual({ ok: false, reason: 'not_enough_waves', up: 1, down: 2, needed: 3 })
  })
})
