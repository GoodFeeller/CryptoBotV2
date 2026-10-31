import { describe, expect, it } from 'vitest'
import type { Candle, SignalContext, Situation } from '../../../src/core/types.js'
import { EveryNCandlesDetector } from '../../../src/features/signals/every-n-candles.js'
import { ScriptedSignalDetector } from '../../../src/features/signals/scripted.js'

const HOUR = 3_600_000

function context(hourNumber: number, withCandles = true): SignalContext {
  const closeTime = hourNumber * HOUR
  const candle: Candle = {
    openTime: closeTime - HOUR,
    closeTime,
    open: 1,
    high: 1,
    low: 1,
    close: 1,
    volume: 1,
    turnover: 1,
  }
  return { symbol: 'BTCUSDT', now: closeTime, candles: { '1h': withCandles ? [candle] : [] } }
}

describe('EveryNCandlesDetector', () => {
  const detector = new EveryNCandlesDetector({ n: 4, timeframe: '1h' })

  it('is a placeholder', () => {
    expect(detector.isPlaceholder).toBe(true)
  })

  it('fires every n candles', () => {
    const fired = [100, 101, 102, 103, 104].map((hour) => detector.detect(context(hour)) !== null)

    expect(fired).toEqual([true, false, false, false, true])
  })

  it('describes the situation only, without side or prices', () => {
    expect(detector.detect(context(100))).toEqual({
      symbol: 'BTCUSDT',
      kind: 'every-n-candles',
      at: 100 * HOUR,
      levels: [],
      indicators: {},
    })
  })

  it('returns null without candles', () => {
    expect(detector.detect(context(100, false))).toBeNull()
  })
})

describe('ScriptedSignalDetector', () => {
  const situation: Situation = { symbol: 'BTCUSDT', kind: 'test', at: 100 * HOUR, levels: [], indicators: {} }
  const detector = new ScriptedSignalDetector([situation])

  it('returns a matching situation', () => {
    expect(detector.detect(context(100))).toEqual(situation)
    expect(detector.isPlaceholder).toBe(true)
  })

  it('returns null for another time or coin', () => {
    expect(detector.detect(context(101))).toBeNull()
    expect(detector.detect({ ...context(100), symbol: 'ETHUSDT' })).toBeNull()
  })
})
