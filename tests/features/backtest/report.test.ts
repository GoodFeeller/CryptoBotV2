import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Candle, ClosedTrade, PendingOrder, TradingCosts } from '../../../src/core/types.js'
import { missedEntries } from '../../../src/features/backtest/missed-entries.js'
import { buildReport, type ReportInput } from '../../../src/features/backtest/report.js'
import { appendValidationLog, writeRun } from '../../../src/features/backtest/run-writer.js'
import type { OrderRecord } from '../../../src/features/backtest/simulated-broker.js'
import { verdict, type VerdictInput } from '../../../src/features/backtest/verdict.js'

const D = (month: number, day = 1) => Date.UTC(2026, month, day)
const COSTS: TradingCosts = { takerPct: 0, makerPct: 0, slippagePct: 0, limitFillThroughPct: 0, maintenanceMarginPct: 0.5 }

const TRADE: ClosedTrade = {
  id: 'p',
  symbol: 'BTCUSDT',
  side: 'long',
  kind: 'k',
  qty: 1,
  leverage: 5,
  entryPrice: 100,
  initialStop: 95,
  stop: 95,
  take: 110,
  openedAt: 0,
  reason: 'r',
  exitPrice: 110,
  closedAt: 1,
  closeReason: 'take',
  pnl: 10,
  r: 2,
  fees: 1,
  slippageCost: 0.5,
  funding: 0.25,
}

const ORDER: PendingOrder = {
  id: 'o',
  symbol: 'BTCUSDT',
  side: 'long',
  kind: 'k',
  price: 99,
  qty: 1,
  leverage: 5,
  stop: 95,
  take: 110,
  expiresAt: 0,
  reason: 'r',
  placedAt: 0,
}

function input(extra: Partial<ReportInput> = {}): ReportInput {
  return {
    status: 'ok',
    mode: 'research',
    isPlaceholder: false,
    costsEnabled: true,
    decisionSource: 'session',
    from: D(0),
    to: D(3),
    trades: [],
    orders: [],
    equity: [
      { time: D(0), total: 100 },
      { time: D(3), total: 100 },
    ],
    engine: { stopMoves: 0, takeMoves: 0, earlyCloses: 0, declined: 0, rejectedByRules: 0, riskHaltAt: null },
    advisor: { requests: 0, failures: 0, invalid: 0, refusals: 0 },
    spend: { newUsd: 0, totalUsd: 0 },
    gaps: 0,
    missed: { count: 0, avgR: 0 },
    ...extra,
  }
}

describe('verdict', () => {
  const PASSING: VerdictInput = {
    mode: 'validation',
    isPlaceholder: false,
    fullMonths: 6,
    costsEnabled: true,
    medianMonthlyPct: 60,
    maxDrawdownPct: 50,
  }

  it('passes exactly at the limits', () => {
    expect(verdict(PASSING)).toBe('PASS')
  })

  it('fails below the return or above the drawdown', () => {
    expect(verdict({ ...PASSING, medianMonthlyPct: 59.9 })).toBe('FAIL')
    expect(verdict({ ...PASSING, maxDrawdownPct: 50.1 })).toBe('FAIL')
  })

  it('is N/A when the conditions for a verdict are not met', () => {
    expect(verdict({ ...PASSING, mode: 'research' })).toBe('N/A')
    expect(verdict({ ...PASSING, isPlaceholder: true })).toBe('N/A')
    expect(verdict({ ...PASSING, fullMonths: 5 })).toBe('N/A')
    expect(verdict({ ...PASSING, costsEnabled: false })).toBe('N/A')
  })
})

describe('buildReport', () => {
  it('excludes partial months from the median and the count', () => {
    const report = buildReport(
      input({
        from: D(0, 15),
        to: D(4, 10),
        equity: [
          { time: D(0, 15), total: 100 },
          { time: D(1), total: 200 }, // неполный январь: +100%
          { time: D(2), total: 220 }, // февраль +10%
          { time: D(3), total: 264 }, // март +20%
          { time: D(4), total: 396 }, // апрель +50%
          { time: D(4, 10), total: 800 }, // неполный май
        ],
      }),
    )

    expect(report.fullMonths).toBe(3)
    expect(report.months.map((m) => m.month)).toEqual(['2026-02', '2026-03', '2026-04'])
    expect(report.medianMonthlyPct).toBeCloseTo(20, 6)
  })

  it('takes the median of an even number of months', () => {
    const report = buildReport(
      input({
        to: D(2),
        equity: [
          { time: D(0), total: 100 },
          { time: D(1), total: 110 },
          { time: D(2), total: 143 },
        ],
      }),
    )

    expect(report.medianMonthlyPct).toBeCloseTo(20, 6)
  })

  it('computes max drawdown from peak to trough', () => {
    const report = buildReport(
      input({
        equity: [
          { time: 1, total: 100 },
          { time: 2, total: 200 },
          { time: 3, total: 120 },
          { time: 4, total: 300 },
          { time: 5, total: 270 },
        ],
      }),
    )

    expect(report.maxDrawdownPct).toBeCloseTo(40, 6)
  })

  it('computes trade stats and the breakeven win rate', () => {
    const report = buildReport(
      input({
        trades: [TRADE, TRADE, { ...TRADE, pnl: -5, r: -1, side: 'short' }],
      }),
    )

    expect(report.trades).toMatchObject({ count: 3, wins: 2, longs: 2, shorts: 1 })
    expect(report.trades.winRatePct).toBeCloseTo(66.667, 2)
    expect(report.trades.avgWinR).toBe(2)
    expect(report.trades.avgLossR).toBe(-1)
    expect(report.trades.avgR).toBe(1)
    expect(report.trades.breakevenWinRatePct).toBeCloseTo(33.333, 2)
    expect(report.trades.avgLeverage).toBe(5)
    expect(report.costs).toEqual({ fees: 3, slippage: 1.5, funding: 0.75 })
  })

  it('no trades gives zeros, not NaN', () => {
    const report = buildReport(input({ equity: [] }))

    expect(report.trades).toMatchObject({ count: 0, winRatePct: 0, avgR: 0, breakevenWinRatePct: 0 })
    expect(report.maxDrawdownPct).toBe(0)
    expect(report.medianMonthlyPct).toBe(0)
    expect(Object.values(report.trades).every(Number.isFinite)).toBe(true)
    expect(report.orders.fillRatePct).toBe(0)
  })

  it('reports fill rate and cancels by reason', () => {
    const record = (outcome: OrderRecord['outcome']): OrderRecord => ({ order: ORDER, firstCandleOpen: 100, outcome })

    const report = buildReport(input({ orders: [record('filled'), record('expired'), record('expired'), record('post_only')] }))

    expect(report.orders).toEqual({
      placed: 4,
      filled: 1,
      fillRatePct: 25,
      cancelled: { expired: 2, post_only: 1 },
    })
  })

  it('placeholder always gives N/A, and stopped runs give no verdict', () => {
    const months = Array.from({ length: 7 }, (_, i) => ({ time: D(i), total: 100 * 2 ** i }))
    const base = { mode: 'validation', from: D(0), to: D(6), equity: months } as const

    expect(buildReport(input({ ...base })).verdict).toBe('PASS')
    expect(buildReport(input({ ...base, isPlaceholder: true })).verdict).toBe('N/A')
    expect(buildReport(input({ ...base, status: 'needs_decisions' })).verdict).toBe('N/A')
    expect(buildReport(input({ ...base, status: 'budget_exceeded' })).verdict).toBe('N/A')
  })
})

describe('missedEntries', () => {
  function candle(open: number, high: number, low: number, close: number): Candle {
    return { openTime: 0, closeTime: 1, open, high, low, close, volume: 1, turnover: 1 }
  }

  const missed = (outcome: OrderRecord['outcome']): OrderRecord => ({
    order: ORDER,
    firstCandleOpen: 100,
    outcome,
  })

  it('counts only orders that were not filled', async () => {
    const result = await missedEntries([missed('filled'), missed('open')], async () => [], COSTS)

    expect(result.count).toBe(0)
  })

  it('uses the same stop and take from the first candle open', async () => {
    const result = await missedEntries([missed('expired')], async () => [candle(100, 110, 99, 105)], COSTS)

    // Вход 100, стоп 95, тейк 110: +10 при риске 5
    expect(result).toEqual({ count: 1, avgR: 2 })
  })

  it('stop and take in one candle count as a stop', async () => {
    const result = await missedEntries([missed('take_reached')], async () => [candle(100, 111, 94, 100)], COSTS)

    expect(result.avgR).toBe(-1)
  })

  it('closes by the last price when nothing is hit', async () => {
    const result = await missedEntries([missed('post_only')], async () => [candle(100, 102, 99, 102.5)], COSTS)

    expect(result.avgR).toBeCloseTo(0.5, 6)
  })

  it('skips an order without a first candle', async () => {
    const result = await missedEntries([{ order: ORDER, firstCandleOpen: null, outcome: 'risk_halt' }], async () => [], COSTS)

    expect(result).toEqual({ count: 0, avgR: 0 })
  })
})

describe('run writer', () => {
  it('writes report, trades, equity and config', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'cryptobot-run-')), 'run')
    const report = buildReport(input())

    writeRun(dir, { report, trades: [TRADE], equity: [{ time: 1, total: 100 }], config: { a: 1 } })

    expect(JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8')).verdict).toBe('N/A')
    expect(readFileSync(join(dir, 'trades.csv'), 'utf8').split('\n')[1]).toContain('BTCUSDT')
    expect(readFileSync(join(dir, 'equity.csv'), 'utf8')).toContain('1,100')
    expect(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'))).toEqual({ a: 1 })
  })

  it('a reason with a comma keeps the CSV valid', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'cryptobot-run-')), 'run')

    writeRun(dir, { report: buildReport(input()), trades: [{ ...TRADE, reason: 'a, "b"' }], equity: [], config: {} })

    expect(readFileSync(join(dir, 'trades.csv'), 'utf8')).toContain('"a, ""b"""')
  })

  it('appends to the validation log', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'cryptobot-log-')), 'sub', 'log.csv')
    const report = buildReport(input({ mode: 'validation' }))

    appendValidationLog(path, 'run1', report)
    appendValidationLog(path, 'run2', report)

    const lines = readFileSync(path, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(3)
    expect(lines[2]).toContain('run2')
  })
})
