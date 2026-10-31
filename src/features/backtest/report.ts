// [REVIEW i-code#36] Отчёт прогона. В медиану входят только полные календарные месяцы: неполный месяц исказил бы её. Рядом с долей
// прибыльных сделок показана доля безубыточности, потому что близкий тейк поднимает винрейт, не делая стратегию прибыльной.
// Типы счётчиков описаны здесь структурно: импортировать фичи trading и claude отсюда нельзя.
import type { ClosedTrade } from '../../core/types.js'
import type { OrderRecord } from './simulated-broker.js'
import { verdict, type Verdict } from './verdict.js'

export type RunStatus = 'ok' | 'budget_exceeded' | 'advisor_failures' | 'needs_decisions'
export type DecisionSourceName = 'session' | 'api' | 'random-side'

export interface EquityPoint {
  time: number
  total: number
}

export interface ReportInput {
  status: RunStatus
  mode: 'research' | 'validation'
  isPlaceholder: boolean
  costsEnabled: boolean
  decisionSource: DecisionSourceName
  from: number
  to: number
  trades: ClosedTrade[]
  orders: OrderRecord[]
  equity: EquityPoint[]
  engine: {
    stopMoves: number
    takeMoves: number
    earlyCloses: number
    declined: number
    rejectedByRules: number
    riskHaltAt: number | null
  }
  advisor: { requests: number; failures: number; invalid: number; refusals: number }
  spend: { newUsd: number; totalUsd: number }
  gaps: number
  missed: { count: number; avgR: number }
}

export interface Report extends Pick<ReportInput, 'status' | 'mode' | 'decisionSource' | 'from' | 'to' | 'engine' | 'advisor' | 'spend' | 'gaps' | 'missed'> {
  verdict: Verdict
  months: { month: string; returnPct: number }[]
  fullMonths: number
  medianMonthlyPct: number
  maxDrawdownPct: number
  finalEquity: number
  trades: {
    count: number
    wins: number
    winRatePct: number
    breakevenWinRatePct: number
    avgWinR: number
    avgLossR: number
    avgR: number
    longs: number
    shorts: number
    avgLeverage: number
    avgNotional: number
  }
  orders: { placed: number; filled: number; fillRatePct: number; cancelled: Record<string, number> }
  costs: { fees: number; slippage: number; funding: number }
}

export function buildReport(input: ReportInput): Report {
  const months = fullMonthReturns(input.from, input.to, input.equity)
  const medianMonthlyPct = median(months.map((month) => month.returnPct))
  const maxDrawdownPct = maxDrawdown(input.equity)

  return {
    status: input.status,
    mode: input.mode,
    decisionSource: input.decisionSource,
    from: input.from,
    to: input.to,
    verdict:
      input.status === 'ok'
        ? verdict({
            mode: input.mode,
            isPlaceholder: input.isPlaceholder,
            fullMonths: months.length,
            costsEnabled: input.costsEnabled,
            medianMonthlyPct,
            maxDrawdownPct,
          })
        : 'N/A',
    months,
    fullMonths: months.length,
    medianMonthlyPct,
    maxDrawdownPct,
    finalEquity: input.equity.at(-1)?.total ?? 0,
    trades: tradeStats(input.trades),
    orders: orderStats(input.orders),
    costs: {
      fees: sum(input.trades.map((trade) => trade.fees)),
      slippage: sum(input.trades.map((trade) => trade.slippageCost)),
      funding: sum(input.trades.map((trade) => trade.funding)),
    },
    engine: input.engine,
    advisor: input.advisor,
    spend: input.spend,
    gaps: input.gaps,
    missed: input.missed,
  }
}

function fullMonthReturns(from: number, to: number, equity: EquityPoint[]): Report['months'] {
  const months: Report['months'] = []
  const first = new Date(from)
  for (let index = first.getUTCFullYear() * 12 + first.getUTCMonth(); ; index++) {
    const start = Date.UTC(Math.floor(index / 12), index % 12, 1)
    const end = Date.UTC(Math.floor((index + 1) / 12), (index + 1) % 12, 1)
    if (end > to) break
    if (start < from) continue

    const opening = lastAtOrBefore(equity, start)
    const closing = lastAtOrBefore(equity, end)
    if (opening === null || closing === null || opening <= 0) continue
    months.push({ month: new Date(start).toISOString().slice(0, 7), returnPct: (closing / opening - 1) * 100 })
  }
  return months
}

function lastAtOrBefore(equity: EquityPoint[], time: number): number | null {
  let found: number | null = null
  for (const point of equity) {
    if (point.time > time) break
    found = point.total
  }
  return found
}

function maxDrawdown(equity: EquityPoint[]): number {
  let peak = 0
  let worst = 0
  for (const { total } of equity) {
    peak = Math.max(peak, total)
    if (peak > 0) worst = Math.max(worst, ((peak - total) / peak) * 100)
  }
  return worst
}

function tradeStats(trades: ClosedTrade[]): Report['trades'] {
  const wins = trades.filter((trade) => trade.pnl > 0)
  const losses = trades.filter((trade) => trade.pnl <= 0)
  const avgWinR = average(wins.map((trade) => trade.r))
  const avgLossR = average(losses.map((trade) => trade.r))
  const reward = avgWinR + Math.abs(avgLossR)

  return {
    count: trades.length,
    wins: wins.length,
    winRatePct: trades.length ? (wins.length / trades.length) * 100 : 0,
    breakevenWinRatePct: reward > 0 ? (Math.abs(avgLossR) / reward) * 100 : 0,
    avgWinR,
    avgLossR,
    avgR: average(trades.map((trade) => trade.r)),
    longs: trades.filter((trade) => trade.side === 'long').length,
    shorts: trades.filter((trade) => trade.side === 'short').length,
    avgLeverage: average(trades.map((trade) => trade.leverage)),
    avgNotional: average(trades.map((trade) => trade.qty * trade.entryPrice)),
  }
}

function orderStats(orders: OrderRecord[]): Report['orders'] {
  const filled = orders.filter((record) => record.outcome === 'filled').length
  const cancelled: Record<string, number> = {}
  for (const { outcome } of orders) {
    if (outcome !== 'filled' && outcome !== 'open') cancelled[outcome] = (cancelled[outcome] ?? 0) + 1
  }
  return {
    placed: orders.length,
    filled,
    fillRatePct: orders.length ? (filled / orders.length) * 100 : 0,
    cancelled,
  }
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0)
}

function average(values: number[]): number {
  return values.length ? sum(values) / values.length : 0
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}
