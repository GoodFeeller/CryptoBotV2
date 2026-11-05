// [REVIEW i-code#31] Движок: один и тот же в бэктесте и live, знает только интерфейсы core. Шаг строго по порядку: исполнения →
// просадка → разборы → новые входы, поэтому решение видит уже закрытые за эту свечу сделки. Ответ советника проверяется здесь,
// при любом советнике. Уведомления и картинка не могут прервать торговлю. Заявка попадает к брокеру сразу, а симулятор
// рассматривает её только со следующей свечи, что и даёт «исполнение на следующем открытии» из спеки.
import type {
  Broker,
  ChartRenderer,
  MarketData,
  Notifier,
  PriceChange,
  RiskGate,
  SignalDetector,
  TradeAdvisor,
} from '../../core/ports.js'
import { FatalRunError } from '../../core/errors.js'
import { isCloseOf } from '../../core/timeframes.js'
import { lossAtStop, validateEntryPlan, validateReviewChange } from '../../core/trade-rules.js'
import type {
  CandleWindows,
  ClosedTrade,
  Equity,
  Exposure,
  PendingOrder,
  Position,
  Timeframe,
  TradingCosts,
} from '../../core/types.js'

const HOUR_MS = 3_600_000
const CHART_CANDLES = 100

export interface EngineConfig {
  symbols: string[]
  executionTimeframe: Timeframe
  signalTimeframe: Timeframe
  windows: Partial<Record<Timeframe, number>>
  maxPositions: number
  limitOrderTtlHours: number
  minStopPct: number
  costs: TradingCosts
}

export interface EngineDeps {
  market: MarketData
  detector: SignalDetector
  advisor: TradeAdvisor
  gate: RiskGate
  broker: Broker
  notifier: Notifier
  chart: ChartRenderer
  config: EngineConfig
}

export interface EngineStats {
  stopMoves: number
  takeMoves: number
  earlyCloses: number
  /** Советник решил не входить. */
  declined: number
  /** Решение советника не прошло проверку кода. */
  rejectedByRules: number
  riskHaltAt: number | null
}

export class TradingEngine {
  private readonly counters: EngineStats = {
    stopMoves: 0,
    takeMoves: 0,
    earlyCloses: 0,
    declined: 0,
    rejectedByRules: 0,
    riskHaltAt: null,
  }

  constructor(private readonly deps: EngineDeps) {}

  /** Обрабатывает момент закрытия свечи исполнения. */
  async step(now: number): Promise<void> {
    await this.processBrokerEvents(now)
    await this.updateRisk(now)
    await this.reviewPositions(now)
    if (isCloseOf(this.deps.config.signalTimeframe, now) && this.deps.gate.canOpen().allowed) {
      await this.lookForEntries(now)
    }
  }

  stats(): EngineStats {
    return { ...this.counters }
  }

  private async processBrokerEvents(now: number): Promise<void> {
    for (const event of await this.deps.broker.poll()) {
      if (event.type === 'filled') {
        const chart = await this.renderChart(event.position, now)
        await this.safely(() => this.deps.notifier.tradeOpened({ position: event.position, chart }))
      } else if (event.type === 'closed') {
        const chart = await this.renderChart(event.trade, now)
        await this.safely(() => this.deps.notifier.tradeClosed({ trade: event.trade, chart }))
      }
    }
  }

  private async updateRisk(now: number): Promise<void> {
    const { gate, broker } = this.deps
    gate.update(await broker.equity())

    const gateResult = gate.canOpen()
    if (gateResult.allowed || this.counters.riskHaltAt !== null) return

    this.counters.riskHaltAt = now
    for (const order of await broker.pendingOrders()) await broker.cancelOrder(order.id, 'risk_halt')
    await this.reportError(
      'защита от просадки',
      `просадка ${gateResult.drawdownPct.toFixed(1)}% достигла предела`,
      'новые сделки остановлены, ордера отменены, открытые сделки ведутся дальше',
    )
  }

  private async reviewPositions(now: number): Promise<void> {
    for (const position of await this.deps.broker.openPositions()) {
      const held = now - position.openedAt
      if (held <= 0 || held % HOUR_MS !== 0) continue
      await this.reviewPosition(position, now)
    }
  }

  private async reviewPosition(position: Position, now: number): Promise<void> {
    const { market, advisor, broker } = this.deps
    const where = `разбор сделки ${position.symbol}`
    const keep = 'стоп и тейк оставлены прежними'

    try {
      const currentPrice = await this.currentPrice(position.symbol, now)
      if (currentPrice === null) return

      const decision = await advisor.reviewTrade({
        position,
        currentPrice,
        now,
        candles: await this.loadWindows(position.symbol, now),
      })
      if ('failed' in decision) return await this.reportError(where, decision.message, keep)

      const { tickSize } = await market.instrument(position.symbol)
      const check = validateReviewChange(decision, {
        side: position.side,
        currentPrice,
        stop: position.stop,
        take: position.take,
        tickSize,
      })
      if (!check.ok) {
        this.counters.rejectedByRules++
        return await this.reportError(where, check.error, keep)
      }

      if (check.closeNow) {
        await broker.close(position.id, 'advisor')
        this.counters.earlyCloses++
        return
      }
      await this.applyChange(position, check.newStop, check.newTake, decision.reason)
    } catch (error) {
      if (error instanceof FatalRunError) throw error
      await this.reportError(where, messageOf(error), keep)
    }
  }

  private async applyChange(
    position: Position,
    newStop: number | null,
    newTake: number | null,
    reason: string,
  ): Promise<void> {
    const change: { stop?: number; take?: number } = {}
    const changes: { stop?: PriceChange; take?: PriceChange } = {}
    if (newStop !== null) {
      change.stop = newStop
      changes.stop = { was: position.stop, now: newStop }
      this.counters.stopMoves++
    }
    if (newTake !== null) {
      change.take = newTake
      changes.take = { was: position.take, now: newTake }
      this.counters.takeMoves++
    }
    if (newStop === null && newTake === null) return

    const updated = await this.deps.broker.amend(position.id, change)
    await this.safely(() => this.deps.notifier.tradeEdited({ position: updated, changes, reason }))
  }

  private async lookForEntries(now: number): Promise<void> {
    for (const symbol of this.deps.config.symbols) {
      try {
        await this.tryEntry(symbol, now)
      } catch (error) {
        if (error instanceof FatalRunError) throw error
        await this.reportError(`поиск входа ${symbol}`, messageOf(error), 'монета пропущена в этом шаге')
      }
    }
  }

  private async tryEntry(symbol: string, now: number): Promise<void> {
    const { market, detector, advisor, gate, broker, config } = this.deps
    const positions = await broker.openPositions()
    const orders = await broker.pendingOrders()
    if (positions.length + orders.length >= config.maxPositions) return
    if ([...positions, ...orders].some((item) => item.symbol === symbol)) return

    const candles = await this.loadWindows(symbol, now)
    const situation = await detector.detect({ symbol, now, candles })
    if (!situation) return

    const currentPrice = await this.currentPrice(symbol, now)
    if (currentPrice === null) return

    const equity = await broker.equity()
    const maxLoss = gate.availableLoss(equity, this.exposures(positions, orders))
    if (maxLoss <= 0 || equity.balance <= 0) return

    const decision = await advisor.decideEntry({
      situation,
      currentPrice,
      candles,
      maxLossPct: (maxLoss / equity.balance) * 100,
    })
    const where = `вход ${symbol}`
    const skip = 'сделка не открыта'
    if ('failed' in decision) return await this.reportError(where, decision.message, skip)
    if (!decision.enter) {
      this.counters.declined++
      return
    }

    const check = validateEntryPlan(decision, this.rulesContext(equity, currentPrice, maxLoss, await market.instrument(symbol)))
    if (!check.ok) {
      this.counters.rejectedByRules++
      return await this.reportError(where, check.error, skip)
    }

    await broker.placeLimit({
      symbol,
      side: check.side,
      kind: situation.kind,
      price: check.entryPrice,
      qty: check.qty,
      leverage: check.leverage,
      stop: check.stop,
      take: check.take,
      expiresAt: now + config.limitOrderTtlHours * HOUR_MS,
      reason: decision.reason,
    })
  }

  private rulesContext(
    equity: Equity,
    currentPrice: number,
    maxLoss: number,
    instrument: Awaited<ReturnType<MarketData['instrument']>>,
  ) {
    const { minStopPct, costs } = this.deps.config
    return { currentPrice, balance: equity.balance, usedMargin: equity.usedMargin, maxLoss, minStopPct, costs, instrument }
  }

  private exposures(positions: Position[], orders: PendingOrder[]): Exposure[] {
    const { costs } = this.deps.config
    return [
      ...positions.map((position) => ({ lossAtStop: lossAtStop(position, costs) })),
      ...orders.map((order) => ({ lossAtStop: lossAtStop({ ...order, entryPrice: order.price }, costs) })),
    ]
  }

  private async loadWindows(symbol: string, now: number): Promise<CandleWindows> {
    const windows: CandleWindows = {}
    for (const [timeframe, limit] of Object.entries(this.deps.config.windows) as [Timeframe, number][]) {
      windows[timeframe] = await this.deps.market.candles(symbol, timeframe, now, limit)
    }
    return windows
  }

  private async currentPrice(symbol: string, now: number): Promise<number | null> {
    const [last] = await this.deps.market.candles(symbol, this.deps.config.executionTimeframe, now, 1)
    return last?.close ?? null
  }

  private async renderChart(trade: Position | ClosedTrade, now: number): Promise<Uint8Array | null> {
    const { market, chart, config } = this.deps
    try {
      const candles = await market.candles(trade.symbol, config.signalTimeframe, now, CHART_CANDLES)
      return await chart.render({
        symbol: trade.symbol,
        side: trade.side,
        candles,
        entryPrice: trade.entryPrice,
        stop: trade.stop,
        take: trade.take,
        ...('exitPrice' in trade ? { exit: { price: trade.exitPrice, time: trade.closedAt } } : {}),
      })
    } catch (error) {
      console.error(`Картинка ${trade.symbol} не построена: ${messageOf(error)}`)
      return null
    }
  }

  private reportError(where: string, message: string, action: string): Promise<void> {
    return this.safely(() => this.deps.notifier.error({ where, message, action }))
  }

  /** Сбой уведомления пишется в лог и не прерывает торговлю. */
  private async safely(send: () => Promise<void>): Promise<void> {
    try {
      await send()
    } catch (error) {
      console.error(`Уведомление не отправлено: ${messageOf(error)}`)
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
