import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig, type AppConfig } from '../../src/app/config.js'
import { createLiveContext, runLiveCycle, sendNotifyTest } from '../../src/app/run-live.js'
import type { Notifier } from '../../src/core/ports.js'
import { timeframeMs } from '../../src/core/timeframes.js'
import type { Candle, Instrument, Timeframe } from '../../src/core/types.js'
import type { ClaudeCall } from '../../src/features/claude/api-source.js'
import type { BybitApi } from '../../src/features/market-data/bybit-market-data.js'

const HOUR = 3_600_000
const T0 = Date.UTC(2026, 0, 10, 12)
const USAGE = { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 }

class FakeApi implements BybitApi {
  failing = false

  async instruments(): Promise<Instrument[]> {
    return [{ symbol: 'BTCUSDT', tickSize: 0.01, qtyStep: 0.001, minQty: 0.001, launchTime: 0, maxLeverage: 50 }]
  }

  async klines(_symbol: string, tf: Timeframe, start: number, end: number): Promise<Candle[]> {
    if (this.failing) throw new Error('Bybit недоступен')
    const step = timeframeMs(tf)
    const candles: Candle[] = []
    for (let openTime = start; openTime <= end; openTime += step) {
      candles.push({ openTime, closeTime: openTime + step, open: 100, high: 101, low: 99, close: 100, volume: 1, turnover: 1 })
    }
    return candles
  }

  async fundingRates() {
    return []
  }
}

function recordingNotifier() {
  const sent: { type: string; event: any }[] = []
  const notifier: Notifier = {
    tradeOpened: async (event) => void sent.push({ type: 'opened', event }),
    tradeClosed: async (event) => void sent.push({ type: 'closed', event }),
    tradeEdited: async (event) => void sent.push({ type: 'edited', event }),
    error: async (event) => void sent.push({ type: 'error', event }),
  }
  return { sent, notifier }
}

function setup(call: ClaudeCall) {
  const dir = mkdtempSync(join(tmpdir(), 'cryptobot-live-'))
  const base = loadConfig()
  const config: AppConfig = {
    ...base,
    symbols: ['BTCUSDT'],
    paths: { data: dir },
    claude: { ...base.claude, windows: { '1h': 3 } },
  }
  const api = new FakeApi()
  const { sent, notifier } = recordingNotifier()
  let now = T0
  const context = createLiveContext({ config, api, call, notifier, now: () => now })
  return { context, api, sent, setNow: (value: number) => (now = value) }
}

describe('live cycle', () => {
  const decline: ClaudeCall = async () => ({
    parsed: { enter: false, side: null, entryPrice: null, leverage: null, notionalPct: null, stop: null, take: null, reason: 'нет' },
    usage: USAGE,
    stopReason: 'end_turn',
    model: 'm',
  })

  it('does not use the response cache: the same request goes to the API again', async () => {
    let calls = 0
    const { context, setNow } = setup(async (request) => {
      calls++
      return decline(request)
    })
    // Заглушка детектора срабатывает раз в 24 часа
    const fire = Math.ceil(T0 / (24 * HOUR)) * 24 * HOUR

    setNow(fire)
    await runLiveCycle(context, fire)
    await runLiveCycle(context, fire)

    expect(calls).toBe(2)
  })

  it('reports a cycle error and the next cycle works', async () => {
    const { context, api, sent, setNow } = setup(decline)
    api.failing = true
    setNow(T0)

    await expect(runLiveCycle(context, T0)).resolves.toBeUndefined()
    expect(sent.some((item) => item.type === 'error')).toBe(true)

    api.failing = false
    await expect(runLiveCycle(context, T0 + HOUR)).resolves.toBeUndefined()
  })
})

describe('notify test', () => {
  it('sends all 4 types with real candles', async () => {
    const { sent, notifier } = recordingNotifier()
    const api = new FakeApi()

    await sendNotifyTest({
      notifier,
      chart: { render: async () => new Uint8Array([1]) },
      market: {
        instrument: async () => {
          throw new Error('не используется')
        },
        candles: (symbol, tf, endAt, limit) => api.klines(symbol, tf, endAt - limit * timeframeMs(tf), endAt - timeframeMs(tf)),
        fundingRates: async () => [],
      },
      now: T0,
    })

    expect(sent.map((item) => item.type)).toEqual(['opened', 'closed', 'edited', 'error'])
    expect(sent[0]?.event.chart).toEqual(new Uint8Array([1]))
    expect(sent[0]?.event.position.entryPrice).toBeLessThan(100)
  })
})
