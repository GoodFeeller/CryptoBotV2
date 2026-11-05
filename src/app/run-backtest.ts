// [REVIEW i-code#40] Сборка одного прогона. Режим советника выбирается флагом: session по умолчанию бесплатный, claude платный,
// random-side база для сравнения. Прогоны со статусом needs_decisions файлов не пишут: их десятки на один период. Порог сбоев
// проверяется и по ходу, и в конце, потому что прогон с частыми сбоями уже не отражает работу модели.
import { timeframeMs } from '../core/timeframes.js'
import { FatalRunError } from '../core/errors.js'
import type { MarketData, SignalDetector, TradeAdvisor } from '../core/ports.js'
import { missedEntries } from '../features/backtest/missed-entries.js'
import { buildReport, type DecisionSourceName, type Report, type RunStatus } from '../features/backtest/report.js'
import { appendValidationLog, writeRun } from '../features/backtest/run-writer.js'
import { NullChartRenderer } from '../features/chart/null-chart.js'
import { createAnthropicCall } from '../features/claude/anthropic-call.js'
import { ApiDecisionSource, type ClaudeCall } from '../features/claude/api-source.js'
import { DecisionAdvisor, type AdvisorStats } from '../features/claude/decision-advisor.js'
import { EstimatingAdvisor } from '../features/claude/estimating-advisor.js'
import { RandomSideAdvisor } from '../features/claude/random-side-advisor.js'
import { ResponseCache } from '../features/claude/response-cache.js'
import { SessionDecisionSource } from '../features/claude/session-source.js'
import { BybitClient } from '../features/market-data/bybit-client.js'
import type { BybitApi } from '../features/market-data/bybit-market-data.js'
import { NullNotifier } from '../features/telegram/null-notifier.js'
import { createRawMarket, createTrading, dataPath } from './compose.js'
import { loadConfig, requireSecret, type AppConfig } from './config.js'
import { ManualClock, simulate } from './run-loop.js'

const FAILURE_CHECK_MIN_REQUESTS = 100
const MAX_FAILURE_RATE = 0.01
const MISSED_ENTRY_WINDOW_MS = 7 * 86_400_000

export interface BacktestOptions {
  from: number
  to: number
  mode: 'research' | 'validation'
  advisor: 'session' | 'claude' | 'random-side'
  estimate: boolean
}

export interface RunDeps {
  config: AppConfig
  api: BybitApi
  call: ClaudeCall
  now: () => number
  runId: string
  makeDetector: (market: MarketData) => SignalDetector
  env: NodeJS.ProcessEnv
}

export interface BacktestResult {
  status: RunStatus
  report: Report | null
  dir: string | null
  /** Сколько запросов ждут ответа сессий и где они лежат. */
  pending: number
  pendingDir: string | null
  estimate: { requests: number; costUsd: number } | null
}

type StopReason = 'needs_decisions' | 'advisor_failures'

const NO_STATS: AdvisorStats = { requests: 0, failures: 0, invalid: 0, refusals: 0 }

export async function runBacktest(options: BacktestOptions, deps: Partial<RunDeps> = {}): Promise<BacktestResult> {
  const { from, to, mode, estimate } = options
  const config = deps.config ?? loadConfig()
  const now = deps.now ?? Date.now
  const clock = new ManualClock(from)
  const raw = createRawMarket(config, deps.api ?? new BybitClient(), now)
  const choice = createAdvisor(options, config, deps)
  const { broker, engine, detector } = createTrading(config, {
    raw,
    clock,
    advisor: choice.advisor,
    notifier: new NullNotifier(),
    chart: new NullChartRenderer(),
    ...(deps.makeDetector ? { makeDetector: deps.makeDetector } : {}),
  })

  let status: RunStatus = 'ok'
  let equity: { time: number; total: number }[] = []
  try {
    const result = await simulate<StopReason>({
      from,
      to,
      symbols: config.symbols,
      executionTimeframe: config.timeframes.execution,
      market: raw,
      clock,
      broker,
      engine,
      shouldStop: () => {
        if (choice.pendingCount() > 0) return 'needs_decisions'
        const failing = failureRate(choice.stats(), engine.stats().rejectedByRules)
        return choice.stats().requests >= FAILURE_CHECK_MIN_REQUESTS && failing > MAX_FAILURE_RATE ? 'advisor_failures' : null
      },
    })
    equity = result.equity
    status = result.stoppedBy ?? 'ok'
    if (status === 'ok' && failureRate(choice.stats(), engine.stats().rejectedByRules) > MAX_FAILURE_RATE) {
      status = 'advisor_failures'
    }
  } catch (error) {
    if (!(error instanceof FatalRunError)) throw error
    status = 'budget_exceeded'
  }

  const base = {
    status,
    pending: choice.pendingCount(),
    pendingDir: choice.pendingDir,
  }
  if (estimate) return { ...base, report: null, dir: null, estimate: choice.estimate() }

  const missed =
    status === 'ok'
      ? await missedEntries(
          broker.orderHistory(),
          async ({ order }) => {
            const end = Math.min(order.placedAt + MISSED_ENTRY_WINDOW_MS, to)
            const tf = config.timeframes.execution
            const count = Math.ceil((end - order.placedAt) / timeframeMs(tf))
            return count > 0 ? raw.candles(order.symbol, tf, end, count) : []
          },
          config.costs,
        )
      : { count: 0, avgR: 0 }

  const report = buildReport({
    status,
    mode,
    isPlaceholder: detector.isPlaceholder,
    costsEnabled: config.costs.takerPct > 0 && config.costs.slippagePct > 0,
    decisionSource: choice.source,
    from,
    to,
    trades: broker.closedTrades(),
    orders: broker.orderHistory(),
    equity,
    engine: engine.stats(),
    advisor: choice.stats(),
    spend: choice.spend(),
    gaps: raw.dataGaps().length,
    missed,
  })

  if (status === 'needs_decisions') return { ...base, report, dir: null, estimate: null }

  const runId = deps.runId ?? new Date(now()).toISOString().replace(/[:.]/g, '-')
  const dir = dataPath(config, 'runs', `${mode}-${options.advisor}-${runId}`)
  writeRun(dir, { report, trades: broker.closedTrades(), equity, config })
  if (mode === 'validation' && status === 'ok') {
    appendValidationLog(dataPath(config, 'runs', 'validation-log.csv'), runId, report)
  }
  return { ...base, report, dir, estimate: null }
}

interface AdvisorChoice {
  advisor: TradeAdvisor
  source: DecisionSourceName
  stats: () => AdvisorStats
  spend: () => { newUsd: number; totalUsd: number }
  pendingCount: () => number
  pendingDir: string | null
  estimate: () => { requests: number; costUsd: number } | null
}

function createAdvisor(options: BacktestOptions, config: AppConfig, deps: Partial<RunDeps>): AdvisorChoice {
  const { promptVersion, model, effort, maxTokens, pricing, budgetUsd, assumedOutputTokens } = config.claude
  const random = new RandomSideAdvisor(config.baseline)
  const common = {
    stats: () => NO_STATS,
    spend: () => ({ newUsd: 0, totalUsd: 0 }),
    pendingCount: () => 0,
    pendingDir: null,
    estimate: () => null,
  }

  if (options.estimate) {
    const advisor = new EstimatingAdvisor(random, { pricing, assumedOutputTokens, promptVersion })
    return { ...common, advisor, source: 'random-side', estimate: () => advisor.estimate() }
  }
  if (options.advisor === 'random-side') return { ...common, advisor: random, source: 'random-side' }

  if (options.advisor === 'session') {
    const session = new SessionDecisionSource(dataPath(config, 'decisions', promptVersion), promptVersion)
    session.clearPending()
    const advisor = new DecisionAdvisor(session, promptVersion)
    return {
      ...common,
      advisor,
      source: 'session',
      stats: () => advisor.stats(),
      pendingCount: () => session.pendingCount(),
      pendingDir: session.pendingDirectory(),
    }
  }

  const call =
    deps.call ??
    createAnthropicCall({ apiKey: requireSecret('ANTHROPIC_API_KEY', deps.env), model, effort, maxTokens })
  const api = new ApiDecisionSource({
    call,
    cache: new ResponseCache(dataPath(config, 'claude-cache')),
    model,
    promptVersion,
    pricing,
    budgetUsd,
  })
  const advisor = new DecisionAdvisor(api, promptVersion)
  return { ...common, advisor, source: 'api', stats: () => advisor.stats(), spend: () => api.spend() }
}

function failureRate(stats: AdvisorStats, rejectedByRules: number): number {
  if (stats.requests === 0) return 0
  return (stats.failures + stats.invalid + stats.refusals + rejectedByRules) / stats.requests
}
