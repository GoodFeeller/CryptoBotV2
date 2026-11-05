// [REVIEW i-code#41] Бумажный режим: настоящие свечи, Claude и Telegram, но сделки идут через симулятор, поэтому средств не касается.
// Кеша ответов нет: каждый рынок новый. Ошибка цикла уходит в Telegram и не останавливает бота, а исчерпанный лимит
// расходов останавливает: дальше бот вёл бы сделки без советника. Открытые сделки теряются при перезапуске, это снимем на этапе демо-счёта.
import { FatalRunError } from '../core/errors.js'
import type { ChartRenderer, MarketData, Notifier, SignalDetector } from '../core/ports.js'
import { timeframeMs } from '../core/timeframes.js'
import type { ClosedTrade, Position } from '../core/types.js'
import type { SimulatedBroker } from '../features/backtest/simulated-broker.js'
import { SvgChartRenderer } from '../features/chart/svg-chart.js'
import { createAnthropicCall } from '../features/claude/anthropic-call.js'
import { ApiDecisionSource, type ClaudeCall } from '../features/claude/api-source.js'
import { DecisionAdvisor } from '../features/claude/decision-advisor.js'
import type { BybitApi } from '../features/market-data/bybit-market-data.js'
import type { TradingEngine } from '../features/trading/engine.js'
import { createRawMarket, createTrading } from './compose.js'
import { requireSecret, type AppConfig } from './config.js'

const AFTER_CLOSE_DELAY_MS = 15_000
const CHART_CANDLES = 100
const NOTIFY_TEST_SYMBOL = 'BTCUSDT'

export interface LiveDeps {
  config: AppConfig
  api: BybitApi
  call: ClaudeCall
  notifier: Notifier
  now: () => number
  makeDetector?: (market: MarketData) => SignalDetector
}

export interface LiveContext {
  config: AppConfig
  market: MarketData
  broker: SimulatedBroker
  engine: TradingEngine
  notifier: Notifier
  lastFed: Map<string, number>
  lastFunding: Map<string, number>
}

export function createLiveContext(deps: LiveDeps): LiveContext {
  const { config, api, call, notifier, now } = deps
  const { model, promptVersion, pricing, budgetUsd } = config.claude
  const source = new ApiDecisionSource({ call, cache: null, model, promptVersion, pricing, budgetUsd })
  const { broker, engine, market } = createTrading(config, {
    raw: createRawMarket(config, api, now),
    clock: { now },
    advisor: new DecisionAdvisor(source, promptVersion),
    notifier,
    chart: new SvgChartRenderer(),
    ...(deps.makeDetector ? { makeDetector: deps.makeDetector } : {}),
  })
  return { config, market, broker, engine, notifier, lastFed: new Map(), lastFunding: new Map() }
}

/** Один цикл на закрытии свечи исполнения. */
export async function runLiveCycle(context: LiveContext, closeTime: number): Promise<void> {
  const { config, market, broker, engine, notifier, lastFed, lastFunding } = context
  try {
    for (const symbol of config.symbols) {
      const since = lastFunding.get(symbol) ?? closeTime
      for (const rate of await market.fundingRates(symbol, since, closeTime)) broker.feedFunding(symbol, rate)
      lastFunding.set(symbol, closeTime)

      const [candle] = await market.candles(symbol, config.timeframes.execution, closeTime, 1)
      if (candle && lastFed.get(symbol) !== candle.closeTime) {
        broker.feed(symbol, candle)
        lastFed.set(symbol, candle.closeTime)
      }
    }
    await engine.step(closeTime)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const fatal = error instanceof FatalRunError
    await notifier
      .error({ where: 'цикл live', message, action: fatal ? 'бот остановлен' : 'следующий цикл запустится как обычно' })
      .catch((sendError: unknown) => console.error(`Уведомление не отправлено: ${String(sendError)}`))
    if (fatal) throw error
  }
}

/** Бесконечный цикл: просыпается вскоре после закрытия каждой свечи исполнения. */
export async function startLive(config: AppConfig, api: BybitApi, notifier: Notifier): Promise<void> {
  const { model, effort, maxTokens } = config.claude
  const call = createAnthropicCall({ apiKey: requireSecret('ANTHROPIC_API_KEY'), model, effort, maxTokens })
  const context = createLiveContext({ config, api, call, notifier, now: Date.now })
  const step = timeframeMs(config.timeframes.execution)

  for (;;) {
    const closeTime = (Math.floor(Date.now() / step) + 1) * step
    await new Promise((resolve) => setTimeout(resolve, closeTime + AFTER_CLOSE_DELAY_MS - Date.now()))
    await runLiveCycle(context, closeTime)
  }
}

/** Отправляет все 4 типа сообщений на настоящих свечах, ордера не участвуют. */
export async function sendNotifyTest(deps: {
  notifier: Notifier
  chart: ChartRenderer
  market: MarketData
  now: number
}): Promise<void> {
  const { notifier, chart, market, now } = deps
  const candles = await market.candles(NOTIFY_TEST_SYMBOL, '1h', now, CHART_CANDLES)
  const price = candles.at(-1)?.close
  if (price === undefined) throw new Error(`Нет свечей ${NOTIFY_TEST_SYMBOL}`)

  const position: Position = {
    id: 'test',
    symbol: NOTIFY_TEST_SYMBOL,
    side: 'long',
    kind: 'проверка сообщений',
    qty: 1,
    leverage: 5,
    entryPrice: round(price * 0.99),
    initialStop: round(price * 0.97),
    stop: round(price * 0.97),
    take: round(price * 1.03),
    openedAt: now,
    reason: 'это проверка, настоящей сделки нет',
  }
  const trade: ClosedTrade = {
    ...position,
    exitPrice: position.take,
    closedAt: now,
    closeReason: 'take',
    pnl: position.take - position.entryPrice,
    r: (position.take - position.entryPrice) / (position.entryPrice - position.stop),
    fees: 0,
    slippageCost: 0,
    funding: 0,
  }
  const base = { symbol: position.symbol, side: position.side, candles, entryPrice: position.entryPrice, stop: position.stop, take: position.take }

  await notifier.tradeOpened({ position, chart: await chart.render(base) })
  await notifier.tradeClosed({
    trade,
    chart: await chart.render({ ...base, exit: { price: trade.exitPrice, time: candles.at(-1)?.openTime ?? now } }),
  })
  await notifier.tradeEdited({
    position,
    changes: { stop: { was: position.stop, now: position.entryPrice } },
    reason: 'это проверка, настоящей сделки нет',
  })
  await notifier.error({ where: 'проверка сообщений', message: 'это проверка', action: 'ничего делать не нужно' })
}

function round(value: number): number {
  return Number(value.toFixed(2))
}
