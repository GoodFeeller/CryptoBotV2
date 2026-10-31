import { describe, expect, it } from 'vitest'
import { isCloseOf, timeframeMs } from '../../src/core/timeframes.js'

describe('timeframeMs', () => {
  it('returns duration in milliseconds', () => {
    expect(timeframeMs('5m')).toBe(300_000)
    expect(timeframeMs('1h')).toBe(3_600_000)
    expect(timeframeMs('4h')).toBe(14_400_000)
    expect(timeframeMs('1d')).toBe(86_400_000)
  })
})

describe('isCloseOf', () => {
  it('is true at the hour boundary', () => {
    expect(isCloseOf('1h', Date.UTC(2026, 0, 1, 5))).toBe(true)
  })

  it('is false inside the hour', () => {
    expect(isCloseOf('1h', Date.UTC(2026, 0, 1, 5, 5))).toBe(false)
  })

  it('aligns 4h candles to UTC boundaries', () => {
    expect(isCloseOf('4h', Date.UTC(2026, 0, 1, 4))).toBe(true)
    expect(isCloseOf('4h', Date.UTC(2026, 0, 1, 5))).toBe(false)
  })

  it('aligns 1d candles to UTC midnight', () => {
    expect(isCloseOf('1d', Date.UTC(2026, 0, 2))).toBe(true)
    expect(isCloseOf('1d', Date.UTC(2026, 0, 2, 12))).toBe(false)
  })
})
