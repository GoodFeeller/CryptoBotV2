import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Candle } from '../../../src/core/types.js'
import { CandleStore } from '../../../src/features/market-data/candle-store.js'

const HOUR = 3_600_000
const JAN_31_23 = Date.UTC(2026, 0, 31, 23)
const FEB_1_00 = Date.UTC(2026, 1, 1, 0)

function candle(openTime: number, close = 1): Candle {
  return { openTime, closeTime: openTime + HOUR, open: 1, high: 1, low: 1, close, volume: 1, turnover: 1 }
}

describe('CandleStore', () => {
  let root: string
  let store: CandleStore

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cryptobot-store-'))
    store = new CandleStore(root)
  })

  it('returns candles sorted across a month boundary', () => {
    store.writeCandles('BTCUSDT', '1h', [candle(FEB_1_00), candle(JAN_31_23)])

    const result = store.readCandles('BTCUSDT', '1h', JAN_31_23, FEB_1_00 + HOUR)

    expect(result.map((c) => c.openTime)).toEqual([JAN_31_23, FEB_1_00])
  })

  it('reads only the requested range', () => {
    store.writeCandles('BTCUSDT', '1h', [candle(JAN_31_23), candle(FEB_1_00)])

    expect(store.readCandles('BTCUSDT', '1h', FEB_1_00, FEB_1_00 + HOUR)).toHaveLength(1)
  })

  it('merges repeated writes without duplicates, newest value wins', () => {
    store.writeCandles('BTCUSDT', '1h', [candle(FEB_1_00, 1)])
    store.writeCandles('BTCUSDT', '1h', [candle(FEB_1_00, 2)])

    const result = store.readCandles('BTCUSDT', '1h', FEB_1_00, FEB_1_00 + HOUR)

    expect(result).toEqual([candle(FEB_1_00, 2)])
  })

  it('ignores a corrupt line', () => {
    store.writeCandles('BTCUSDT', '1h', [candle(FEB_1_00)])
    appendFileSync(join(root, 'candles', 'BTCUSDT', '1h', '2026-02.jsonl'), '{"openTime":\n')

    expect(new CandleStore(root).readCandles('BTCUSDT', '1h', FEB_1_00, FEB_1_00 + HOUR)).toHaveLength(1)
  })

  it('reads a file from disk once, and sees its own writes', () => {
    store.writeCandles('BTCUSDT', '1h', [candle(FEB_1_00, 1)])
    store.readCandles('BTCUSDT', '1h', FEB_1_00, FEB_1_00 + HOUR)
    rmSync(join(root, 'candles'), { recursive: true })

    expect(store.readCandles('BTCUSDT', '1h', FEB_1_00, FEB_1_00 + HOUR)).toHaveLength(1)

    mkdirSync(join(root, 'candles'))
    store.writeCandles('BTCUSDT', '1h', [candle(FEB_1_00, 2)])

    expect(store.readCandles('BTCUSDT', '1h', FEB_1_00, FEB_1_00 + HOUR)).toEqual([candle(FEB_1_00, 2)])
  })

  it('a write does not erase what another process added to the file', () => {
    const other = new CandleStore(root)
    other.readCandles('BTCUSDT', '1h', FEB_1_00, FEB_1_00 + HOUR)
    store.writeCandles('BTCUSDT', '1h', [candle(FEB_1_00)])

    other.writeCandles('BTCUSDT', '1h', [candle(FEB_1_00 + HOUR)])

    expect(new CandleStore(root).readCandles('BTCUSDT', '1h', FEB_1_00, FEB_1_00 + 2 * HOUR)).toHaveLength(2)
  })

  it('keeps known missing candles between instances', () => {
    store.addMissing('BTCUSDT', '1h', [FEB_1_00])

    expect(new CandleStore(root).readMissing('BTCUSDT', '1h').has(FEB_1_00)).toBe(true)
  })

  it('remembers funding rates and the covered period', () => {
    store.writeFunding('BTCUSDT', [{ time: FEB_1_00, rate: 0.0001 }], { from: JAN_31_23, to: FEB_1_00 + HOUR })

    expect(store.fundingCoverage('BTCUSDT')).toEqual({ from: JAN_31_23, to: FEB_1_00 + HOUR })
    expect(store.readFunding('BTCUSDT', FEB_1_00, FEB_1_00 + 1)).toEqual([{ time: FEB_1_00, rate: 0.0001 }])
    expect(store.readFunding('BTCUSDT', FEB_1_00 + 1, FEB_1_00 + HOUR)).toEqual([])
  })

  it('reports no funding coverage when nothing is stored', () => {
    expect(store.fundingCoverage('BTCUSDT')).toBeNull()
  })
})
