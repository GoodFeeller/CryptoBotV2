import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { loadConfig, type AppConfig } from '../../src/app/config.js'
import { runBacktest, type BacktestOptions, type RunDeps } from '../../src/app/run-backtest.js'
import { timeframeMs } from '../../src/core/timeframes.js'
import type { Candle, FundingRate, Instrument, Timeframe } from '../../src/core/types.js'
import type { ClaudeCall } from '../../src/features/claude/api-source.js'
import type { BybitApi } from '../../src/features/market-data/bybit-market-data.js'
import { EveryNCandlesDetector } from '../../src/features/signals/every-n-candles.js'
import { backtestWithSessions } from '../../src/app/run-sessions.js'

/** Конвейер проверяем на заглушке: на синтетических свечах детектор зон честно молчит. */
const placeholder = () => new EveryNCandlesDetector({ n: 4, timeframe: '1h' })

const HOUR = 3_600_000
const FROM = Date.UTC(2026, 0, 10)
const TO = FROM + 24 * HOUR
const NOW = Date.UTC(2026, 5, 1)
const USAGE = { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 }

class FakeApi implements BybitApi {
  /** Цены после этого момента отличаются: для проверки на заглядывание в будущее. */
  futureFrom = Number.POSITIVE_INFINITY

  async instruments(): Promise<Instrument[]> {
    return ['BTCUSDT', 'ETHUSDT'].map((symbol) => ({
      symbol,
      tickSize: 0.01,
      qtyStep: 0.001,
      minQty: 0.001,
      launchTime: 0,
      maxLeverage: 50,
    }))
  }

  async klines(symbol: string, tf: Timeframe, start: number, end: number): Promise<Candle[]> {
    const step = timeframeMs(tf)
    const phase = symbol === 'ETHUSDT' ? HOUR : 0
    const candles: Candle[] = []
    for (let openTime = start; openTime <= end; openTime += step) {
      const bump = openTime >= this.futureFrom ? 40 : 0
      const open = 100 + bump + 3 * Math.sin((openTime + phase) / (2 * HOUR))
      const close = 100 + bump + 3 * Math.sin((openTime + phase + step) / (2 * HOUR))
      candles.push({
        openTime,
        closeTime: openTime + step,
        open,
        close,
        high: Math.max(open, close) + 0.2,
        low: Math.min(open, close) - 0.2,
        volume: 10,
        turnover: 1000,
      })
    }
    return candles
  }

  async fundingRates(): Promise<FundingRate[]> {
    return [{ time: FROM + 8 * HOUR, rate: 0.0001 }]
  }
}

function testConfig(dir: string): AppConfig {
  const config = loadConfig()
  return {
    ...config,
    symbols: ['BTCUSDT', 'ETHUSDT'],
    paths: { data: dir },
    claude: { ...config.claude, windows: { '1h': 5 }, budgetUsd: 100 },
  }
}

describe('runBacktest', () => {
  let dir: string
  let api: FakeApi
  let config: AppConfig

  function run(options: Partial<BacktestOptions> = {}, deps: Partial<RunDeps> = {}) {
    return runBacktest(
      { from: FROM, to: TO, mode: 'research', advisor: 'random-side', estimate: false, ...options },
      { config, api, now: () => NOW, runId: 'test', makeDetector: placeholder, ...deps },
    )
  }

  const declineAll: ClaudeCall = async () => ({
    parsed: { enter: false, side: null, entryPrice: null, leverage: null, notionalPct: null, stop: null, take: null, reason: 'нет' },
    usage: USAGE,
    stopReason: 'end_turn',
    model: 'm',
  })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cryptobot-e2e-'))
    api = new FakeApi()
    config = testConfig(dir)
  })

  it('runs end to end and writes a report with N/A for a placeholder detector', async () => {
    const result = await run()

    expect(result.status).toBe('ok')
    expect(result.report?.verdict).toBe('N/A')
    expect(result.report?.orders.placed).toBeGreaterThan(0)
    expect(result.report?.trades.count).toBeGreaterThan(0)
    expect(result.report?.decisionSource).toBe('random-side')
    expect(existsSync(join(result.dir!, 'report.json'))).toBe(true)
    expect(readFileSync(join(result.dir!, 'trades.csv'), 'utf8')).toContain('BTCUSDT')
  })

  it('is reproducible: two runs give the same report', async () => {
    const first = await run()
    const second = await run({}, { runId: 'again' })

    expect(second.report).toEqual(first.report)
  })

  it('has no look-ahead: changing candles after T changes no decision before T', async () => {
    const T = FROM + 12 * HOUR
    const recording = () => {
      const bodies: string[] = []
      const call: ClaudeCall = async (request) => {
        bodies.push(JSON.stringify(request.body))
        return declineAll(request)
      }
      return { bodies, call }
    }
    const fresh = () => {
      dir = mkdtempSync(join(tmpdir(), 'cryptobot-e2e-'))
      config = testConfig(dir)
      api = new FakeApi()
    }

    const untilT = recording()
    fresh()
    await run({ to: T, advisor: 'claude' }, { call: untilT.call })

    const changed = recording()
    fresh()
    api.futureFrom = T
    await run({ advisor: 'claude' }, { call: changed.call })

    expect(untilT.bodies.length).toBeGreaterThan(0)
    expect(changed.bodies.slice(0, untilT.bodies.length)).toEqual(untilT.bodies)
    expect(changed.bodies.length).toBeGreaterThan(untilT.bodies.length)
  })

  it('a repeat run through the API spends no new money', async () => {
    const first = await run({ advisor: 'claude' }, { call: declineAll })
    let called = false
    const second = await run(
      { advisor: 'claude' },
      {
        call: async (request) => {
          called = true
          return declineAll(request)
        },
      },
    )

    expect(first.report?.spend.newUsd).toBeGreaterThan(0)
    expect(called).toBe(false)
    expect(second.report?.spend.newUsd).toBe(0)
    expect(second.report?.spend.totalUsd).toBeCloseTo(first.report!.spend.totalUsd, 9)
  })

  it('stops with budget_exceeded and gives no verdict', async () => {
    config = { ...config, claude: { ...config.claude, budgetUsd: 0 } }

    const result = await run({ advisor: 'claude' }, { call: declineAll })

    expect(result.status).toBe('budget_exceeded')
    expect(result.report?.verdict).toBe('N/A')
  })

  it('stops with advisor_failures when more than 1% of requests fail', async () => {
    const result = await run(
      { advisor: 'claude' },
      {
        call: async () => {
          throw new Error('API')
        },
      },
    )

    expect(result.status).toBe('advisor_failures')
    expect(result.report?.verdict).toBe('N/A')
  })

  it('estimate never calls the API and writes no files', async () => {
    const result = await run(
      { advisor: 'claude', estimate: true },
      {
        call: async () => {
          throw new Error('не должен вызываться')
        },
      },
    )

    expect(result.estimate?.requests).toBeGreaterThan(0)
    expect(result.estimate?.costUsd).toBeGreaterThan(0)
    expect(result.dir).toBeNull()
    expect(existsSync(join(dir, 'runs'))).toBe(false)
  })

  it('only validation runs go to the validation log', async () => {
    await run()
    expect(existsSync(join(dir, 'runs', 'validation-log.csv'))).toBe(false)

    await run({ mode: 'validation' })
    expect(readFileSync(join(dir, 'runs', 'validation-log.csv'), 'utf8')).toContain('test')
  })

  describe('session decisions', () => {
    const pendingDir = () => join(dir, 'decisions', config.claude.promptVersion, 'pending')
    const answersDir = () => join(dir, 'decisions', config.claude.promptVersion, 'answers')

    function answerPending(): number {
      const files = readdirSync(pendingDir())
      for (const file of files) {
        const request = JSON.parse(readFileSync(join(pendingDir(), file), 'utf8'))
        const answer =
          request.kind === 'entry'
            ? { enter: true, side: 'long', entryPrice: 99, leverage: 5, notionalPct: 20, stop: 97, take: 102, reason: 'тест' }
            : { newStop: null, newTake: null, closeNow: false, reason: 'тест' }
        writeFileSync(join(answersDir(), file), JSON.stringify(answer))
      }
      return files.length
    }

    it('stops at the first step without answers and writes all its requests', async () => {
      const result = await run({ advisor: 'session' })

      expect(result.status).toBe('needs_decisions')
      expect(result.pending).toBe(2)
      expect(readdirSync(pendingDir())).toHaveLength(2)
      expect(readFileSync(join(pendingDir(), readdirSync(pendingDir())[0]!), 'utf8')).not.toContain('BTCUSDT')
      expect(result.dir).toBeNull()
    })

    it('a rerun with answers goes on until the end, and a repeat gives the same report', async () => {
      let result = await run({ advisor: 'session' })
      let rounds = 0
      while (result.status === 'needs_decisions') {
        answerPending()
        result = await run({ advisor: 'session' })
        rounds++
        expect(rounds).toBeLessThan(400)
      }

      expect(rounds).toBeGreaterThan(1)
      expect(result.status).toBe('ok')
      expect(result.report?.decisionSource).toBe('session')
      expect(result.report?.advisor.requests).toBeGreaterThan(0)

      const repeat = await run({ advisor: 'session' }, { runId: 'again' })
      expect(repeat.report).toEqual(result.report)
    }, 60_000)
  })

  describe('backtestWithSessions', () => {
    const answer = async (input: { prompt: string }) =>
      'situation' in JSON.parse(input.prompt)
        ? { enter: true, side: 'long', entryPrice: 99, leverage: 5, notionalPct: 20, stop: 97, take: 102, reason: 'тест' }
        : { newStop: null, newTake: null, closeNow: false, reason: 'тест' }

    it('answers pending requests with sessions until the run reaches the end', async () => {
      const cycles: number[] = []
      const result = await backtestWithSessions(
        { from: FROM, to: TO, mode: 'research' },
        { config, api, now: () => NOW, runId: 'test', makeDetector: placeholder },
        { runner: answer, concurrency: 2, maxCycles: 400, onCycle: (pending) => cycles.push(pending) },
      )

      expect(result.status).toBe('ok')
      expect(result.report?.decisionSource).toBe('session')
      expect(cycles.length).toBeGreaterThan(1)
    }, 60_000)

    it('a failed session stops the run with its error', async () => {
      const failing = async () => {
        throw new Error('лимит подписки')
      }

      await expect(
        backtestWithSessions(
          { from: FROM, to: TO, mode: 'research' },
          { config, api, now: () => NOW, runId: 'test', makeDetector: placeholder },
          { runner: failing, concurrency: 1, maxCycles: 400 },
        ),
      ).rejects.toThrow('лимит подписки')
    })
  })

  it('a missing API key stops the claude mode before the run', async () => {
    await expect(run({ advisor: 'claude' }, { env: {} })).rejects.toThrow(/ANTHROPIC_API_KEY/)
  })
})
