import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { timeframeMs } from '../../../src/core/timeframes.js'
import type { Candle, FundingRate, Instrument, Timeframe } from '../../../src/core/types.js'
import { BybitMarketData, type BybitApi } from '../../../src/features/market-data/bybit-market-data.js'
import { CandleStore } from '../../../src/features/market-data/candle-store.js'

const HOUR = 3_600_000
const T0 = Date.UTC(2026, 0, 10)

function candle(openTime: number, tf: Timeframe = '1h'): Candle {
  return {
    openTime,
    closeTime: openTime + timeframeMs(tf),
    open: 1,
    high: 1,
    low: 1,
    close: 1,
    volume: 1,
    turnover: 1,
  }
}

function instrument(symbol: string, launchTime = 0): Instrument {
  return { symbol, tickSize: 0.01, qtyStep: 0.001, minQty: 0.001, launchTime, maxLeverage: 100 }
}

class FakeApi implements BybitApi {
  klineCalls = 0
  fundingCalls = 0
  instrumentCalls = 0
  missing = new Set<number>()
  list: Instrument[] = [instrument('BTCUSDT')]
  rates: FundingRate[] = []

  async instruments(): Promise<Instrument[]> {
    this.instrumentCalls++
    return this.list
  }

  async klines(_symbol: string, tf: Timeframe, start: number, end: number): Promise<Candle[]> {
    this.klineCalls++
    const result: Candle[] = []
    for (let time = start; time <= end; time += timeframeMs(tf)) {
      if (!this.missing.has(time)) result.push(candle(time, tf))
    }
    return result
  }

  async fundingRates(_symbol: string, from: number, to: number): Promise<FundingRate[]> {
    this.fundingCalls++
    return this.rates.filter((rate) => rate.time >= from && rate.time <= to)
  }
}

describe('BybitMarketData', () => {
  let root: string
  let api: FakeApi
  let now: number
  let data: BybitMarketData

  function create(): BybitMarketData {
    return new BybitMarketData({ api, store: new CandleStore(root), now: () => now })
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cryptobot-md-'))
    api = new FakeApi()
    now = T0 + 100 * HOUR
    data = create()
  })

  describe('candles', () => {
    it('returns the last limit candles closed by endAt', async () => {
      const result = await data.candles('BTCUSDT', '1h', T0 + 10 * HOUR, 3)

      expect(result.map((c) => c.closeTime)).toEqual([T0 + 8 * HOUR, T0 + 9 * HOUR, T0 + 10 * HOUR])
    })

    it('never returns a candle closing after endAt', async () => {
      const result = await data.candles('BTCUSDT', '1h', T0 + 10 * HOUR + 1, 3)

      expect(result.at(-1)?.closeTime).toBe(T0 + 10 * HOUR)
    })

    it('does not return or store a candle that is not closed yet', async () => {
      now = T0 + 10 * HOUR + 30 * 60_000

      const result = await data.candles('BTCUSDT', '1h', T0 + 12 * HOUR, 5)

      expect(result.at(-1)?.closeTime).toBe(T0 + 10 * HOUR)

      now = T0 + 12 * HOUR
      const later = await data.candles('BTCUSDT', '1h', T0 + 12 * HOUR, 1)
      expect(later[0]?.closeTime).toBe(T0 + 12 * HOUR)
    })

    it('does not touch the network for a stored closed period', async () => {
      await data.candles('BTCUSDT', '1h', T0 + 10 * HOUR, 3)
      await create().candles('BTCUSDT', '1h', T0 + 10 * HOUR, 3)

      expect(api.klineCalls).toBe(1)
    })

    it('loads ahead, so a moving window does not need a request for every new candle', async () => {
      for (let hour = 10; hour < 40; hour++) {
        await data.candles('BTCUSDT', '1h', T0 + hour * HOUR, 3)
      }

      expect(api.klineCalls).toBe(1)
    })

    it('loading ahead does not reveal candles after endAt', async () => {
      await data.candles('BTCUSDT', '1h', T0 + 50 * HOUR, 3)

      const earlier = await data.candles('BTCUSDT', '1h', T0 + 10 * HOUR, 3)

      expect(earlier.at(-1)?.closeTime).toBe(T0 + 10 * HOUR)
    })

    it('refetches when a stored file is corrupt', async () => {
      await data.candles('BTCUSDT', '1h', T0 + 10 * HOUR, 3)
      writeFileSync(join(root, 'candles', 'BTCUSDT', '1h', '2026-01.jsonl'), 'not json\n')

      const result = await create().candles('BTCUSDT', '1h', T0 + 10 * HOUR, 3)

      expect(result).toHaveLength(3)
      expect(api.klineCalls).toBe(2)
    })

    it('records a gap, does not fill it and does not refetch it', async () => {
      api.missing.add(T0 + 8 * HOUR)

      const first = await data.candles('BTCUSDT', '1h', T0 + 10 * HOUR, 3)
      const second = await create().candles('BTCUSDT', '1h', T0 + 10 * HOUR, 3)

      expect(first.map((c) => c.openTime)).toEqual([T0 + 7 * HOUR, T0 + 9 * HOUR])
      expect(second).toEqual(first)
      expect(api.klineCalls).toBe(1)
      expect(data.dataGaps()).toEqual([{ symbol: 'BTCUSDT', timeframe: '1h', openTime: T0 + 8 * HOUR }])
    })

    it('does not report empty candles after the last one as a gap and does not refetch them', async () => {
      api.missing = new Set([T0 + 8 * HOUR, T0 + 9 * HOUR])

      const result = await data.candles('BTCUSDT', '1h', T0 + 10 * HOUR, 4)
      await create().candles('BTCUSDT', '1h', T0 + 10 * HOUR, 4)

      expect(result.map((c) => c.openTime)).toEqual([T0 + 6 * HOUR, T0 + 7 * HOUR])
      expect(data.dataGaps()).toEqual([])
      expect(api.klineCalls).toBe(1)
    })

    it('does not remember a just closed candle as missing', async () => {
      now = T0 + 10 * HOUR + 1000
      api.missing.add(T0 + 9 * HOUR)
      await data.candles('BTCUSDT', '1h', T0 + 10 * HOUR, 1)

      api.missing.clear()
      const later = await data.candles('BTCUSDT', '1h', T0 + 10 * HOUR, 1)

      expect(later).toHaveLength(1)
    })

    it('does not ask for candles before the coin was launched', async () => {
      api.list = [instrument('BTCUSDT', T0 + 8 * HOUR)]

      const result = await data.candles('BTCUSDT', '1h', T0 + 10 * HOUR, 5)

      expect(result.map((c) => c.openTime)).toEqual([T0 + 8 * HOUR, T0 + 9 * HOUR])
      expect(data.dataGaps()).toEqual([])
    })

    it('returns an empty list when the coin was not launched yet', async () => {
      api.list = [instrument('BTCUSDT', T0 + 50 * HOUR)]

      await expect(data.candles('BTCUSDT', '1h', T0 + 10 * HOUR, 5)).resolves.toEqual([])
    })
  })

  describe('instrument', () => {
    it('loads instruments once', async () => {
      await data.instrument('BTCUSDT')
      await data.instrument('BTCUSDT')

      expect(api.instrumentCalls).toBe(1)
    })

    it('throws for an unknown symbol', async () => {
      await expect(data.instrument('NOPEUSDT')).rejects.toThrow(/NOPEUSDT/)
    })
  })

  describe('fundingRates', () => {
    it('stores a closed period', async () => {
      api.rates = [{ time: T0, rate: 0.0001 }]

      await data.fundingRates('BTCUSDT', T0, T0 + HOUR)
      const again = await create().fundingRates('BTCUSDT', T0, T0 + HOUR)

      expect(again).toEqual(api.rates)
      expect(api.fundingCalls).toBe(1)
    })

    it('does not treat the future as covered', async () => {
      now = T0 + HOUR

      await data.fundingRates('BTCUSDT', T0, T0 + 10 * HOUR)
      now = T0 + 10 * HOUR
      api.rates = [{ time: T0 + 8 * HOUR, rate: 0.0002 }]
      const later = await data.fundingRates('BTCUSDT', T0, T0 + 10 * HOUR)

      expect(later).toEqual(api.rates)
    })
  })
})
