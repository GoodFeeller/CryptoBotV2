import { describe, expect, it } from 'vitest'
import type { Candle } from '../../../src/core/types.js'
import { computeEma, emaSnapshot, type EmaOptions } from '../../../src/features/ema/ema.js'

const HOUR = 3_600_000
const T0 = Date.UTC(2026, 0, 1)
const OPTIONS: EmaOptions = { periods: [2, 4, 8], slopeBars: 3, atrPeriod: 5, warmupFactor: 3 }

/** Свечи из цен закрытия: открытие на предыдущем закрытии, тени по 0.5. */
function candles(closes: number[]): Candle[] {
  return closes.map((close, i) => {
    const open = closes[i - 1] ?? close
    const openTime = T0 + i * HOUR
    return { openTime, closeTime: openTime + HOUR, open, close, high: Math.max(open, close) + 0.5, low: Math.min(open, close) - 0.5, volume: 1, turnover: 1 }
  })
}

const rising = (count: number) => Array.from({ length: count }, (_, i) => 100 + i)
const falling = (count: number) => Array.from({ length: count }, (_, i) => 200 - i)

describe('computeEma', () => {
  it('starts from the simple average of the first period and then smooths', () => {
    // Период 3: начало = (2 + 4 + 6) / 3 = 4, вес 2 / (3 + 1) = 0.5. Дальше 4 + 0.5·(8 − 4) = 6 и 6 + 0.5·(4 − 6) = 5.
    expect(computeEma([2, 4, 6, 8, 4], 3)).toEqual([undefined, undefined, 4, 6, 5])
  })

  it('has no value while there are fewer values than the period', () => {
    expect(computeEma([1, 2], 3)).toEqual([undefined, undefined])
  })
})

describe('emaSnapshot', () => {
  it('in a steady rise price is above every EMA, all rise, and the fast ones are on top', () => {
    const snapshot = emaSnapshot(candles(rising(40)), T0 + 40 * HOUR, OPTIONS)

    expect(snapshot.ok).toBe(true)
    if (!snapshot.ok) return
    expect(snapshot.stack).toBe('up')
    expect(snapshot.emas.map((ema) => ema.period)).toEqual([2, 4, 8])
    for (const ema of snapshot.emas) {
      expect(ema.priceSide).toBe('above')
      expect(ema.slope).toBe('up')
      expect(ema.distanceAtr).toBeGreaterThan(0)
    }
  })

  it('in a steady fall everything is the other way round', () => {
    const snapshot = emaSnapshot(candles(falling(40)), T0 + 40 * HOUR, OPTIONS)

    expect(snapshot.ok && snapshot.stack).toBe('down')
    expect(snapshot.ok && snapshot.emas.every((ema) => ema.priceSide === 'below' && ema.slope === 'down')).toBe(true)
  })

  it('a turn that only the fast EMA has followed gives a mixed stack', () => {
    // После роста до 139 откат к 136: EMA 2 уже ниже EMA 4, но EMA 4 ещё выше EMA 8.
    const snapshot = emaSnapshot(candles([...rising(40), 136]), T0 + 41 * HOUR, OPTIONS)

    expect(snapshot.ok && snapshot.stack).toBe('mixed')
  })

  it('measures distance from the last close in ATR', () => {
    const series = candles(rising(40))
    const snapshot = emaSnapshot(series, T0 + 40 * HOUR, OPTIONS)
    const slow = computeEma(series.map((candle) => candle.close), 8).at(-1)!

    // Каждая свеча: тело 1 и тени по 0.5, поэтому истинный диапазон 2, и ATR к концу серии почти ровно 2.
    expect(snapshot.ok && snapshot.emas[2]!.distanceAtr).toBeCloseTo((139 - slow) / 2, 2)
    expect(snapshot.ok && snapshot.close).toBe(139)
  })

  it('does not see candles that close after the moment', () => {
    const past = candles(rising(40))
    const withFuture = candles([...rising(40), 10, 5, 1])
    const at = T0 + 40 * HOUR

    expect(emaSnapshot(withFuture, at, OPTIONS)).toEqual(emaSnapshot(past, at, OPTIONS))
  })

  it('a candle still open at the moment is not used', () => {
    const series = candles(rising(40))

    const { at: _openAt, ...whileOpen } = emaSnapshot(series, T0 + 40 * HOUR - 1, OPTIONS) as { at: number }
    const { at: _closedAt, ...beforeIt } = emaSnapshot(series.slice(0, 39), T0 + 39 * HOUR, OPTIONS) as { at: number }

    expect(whileOpen).toEqual(beforeIt)
  })

  it('refuses to answer without enough history for the slowest EMA', () => {
    // Нужно warmupFactor × 8 = 24 свечи, чтобы начальное значение почти не влияло на результат.
    expect(emaSnapshot(candles(rising(23)), T0 + 23 * HOUR, OPTIONS)).toEqual({ ok: false, reason: 'not_enough_candles', needed: 24, got: 23 })
    expect(emaSnapshot(candles(rising(24)), T0 + 24 * HOUR, OPTIONS).ok).toBe(true)
  })
})
