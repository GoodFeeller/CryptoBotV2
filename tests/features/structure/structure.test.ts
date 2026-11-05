import { describe, expect, it } from 'vitest'
import type { Candle } from '../../../src/core/types.js'
import { structureSnapshot, type StructureOptions } from '../../../src/features/structure/structure.js'

const HOUR = 3_600_000
const T0 = Date.UTC(2026, 0, 1)
const OPTIONS: StructureOptions = { swingAtr: 1.5, atrPeriod: 5 }

/** Свечи по прямой между точками, по 5 свечей на отрезок, тени по 0.1. */
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

const snapshotOf = (points: number[]) => {
  const candles = path(points)
  return structureSnapshot(candles, candles.at(-1)!.closeTime, OPTIONS)
}

describe('structureSnapshot', () => {
  it('higher highs and higher lows are an up trend', () => {
    const snapshot = snapshotOf([100, 120, 110, 130, 120, 140, 130, 136])

    expect(snapshot.ok && snapshot.trend).toBe('up')
    expect(snapshot.ok && snapshot.highs.map((point) => point.price)).toEqual([130.1, 140.1])
    expect(snapshot.ok && snapshot.lows.map((point) => point.price)).toEqual([119.9, 129.9])
  })

  it('lower highs and lower lows are a down trend', () => {
    expect(snapshotOf([200, 180, 190, 170, 180, 160, 170, 164]).ok && snapshotOf([200, 180, 190, 170, 180, 160, 170, 164])).toMatchObject({ trend: 'down' })
  })

  it('falling highs with rising lows are a flat, and it remembers the trend before it', () => {
    // Сначала тренд вниз: максимумы 190 → 180, минимумы 160 → 150. Потом максимумы 172 → 168, а минимумы 156 → 158.
    const snapshot = snapshotOf([200, 170, 190, 160, 180, 150, 172, 156, 168, 158, 165])

    expect(snapshot.ok && snapshot.trend).toBe('flat')
    expect(snapshot.ok && snapshot.previousTrend).toBe('down')
  })

  it('the trend before a flat is the latest one, not the first', () => {
    // Тренд вверх до 140, потом тренд вниз до 105, потом флэт.
    const snapshot = snapshotOf([100, 120, 110, 130, 120, 140, 125, 135, 115, 125, 105, 118, 108, 115, 110, 114])

    expect(snapshot.ok && snapshot.trend).toBe('flat')
    expect(snapshot.ok && snapshot.previousTrend).toBe('down')
  })

  it('a flat with no trend before it has no previous trend', () => {
    const snapshot = snapshotOf([100, 130, 105, 125, 110, 120, 112, 118])

    expect(snapshot.ok && snapshot.trend).toBe('flat')
    expect(snapshot.ok && snapshot.previousTrend).toBeNull()
  })

  it('tells when price is already beyond the last low or high', () => {
    // Тренд вверх, потом обвал ниже последнего минимума 129.9: новый минимум ещё не подтверждён разворотом.
    const crashed = snapshotOf([100, 120, 110, 130, 120, 140, 130, 136, 115])
    const inside = snapshotOf([100, 120, 110, 130, 120, 140, 130, 136])

    expect(crashed.ok && crashed.beyond).toBe('below_low')
    expect(inside.ok && inside.beyond).toBeNull()
    expect(snapshotOf([200, 180, 190, 170, 180, 160, 170, 164, 185]).ok && snapshotOf([200, 180, 190, 170, 180, 160, 170, 164, 185])).toMatchObject({ beyond: 'above_high' })
  })

  it('does not see candles that close after the moment', () => {
    const candles = path([100, 120, 110, 130, 120, 140, 130, 136])
    const at = candles.at(-1)!.closeTime
    const future = path([136, 60, 200]).map((candle) => ({ ...candle, openTime: candle.openTime + at - T0, closeTime: candle.closeTime + at - T0 }))

    expect(structureSnapshot([...candles, ...future], at, OPTIONS)).toEqual(structureSnapshot(candles, at, OPTIONS))
  })

  it('refuses to answer without two highs and two lows', () => {
    expect(snapshotOf([100, 120, 110, 130, 125])).toEqual({ ok: false, reason: 'not_enough_pivots', highs: 2, lows: 1, needed: 2 })
  })
})
