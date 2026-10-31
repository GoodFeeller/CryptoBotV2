// [REVIEW i-code#20] Симулятор биржи: от его честности зависит вся достоверность бэктеста. Внутри свечи порядок цен неизвестен,
// поэтому каждое спорное правило решено против нас: стоп раньше тейка, в свече входа тейк не считается, касание ордера
// не исполняет его, гэп в нашу сторону не улучшает цену. Брокер не знает про будущее: свечи ему подаёт цикл прогона.
// Он же работает в бумажном режиме live, поэтому лежит здесь как единственная реализация Broker в базе.
import type { Broker, Clock } from '../../core/ports.js'
import type {
  BrokerEvent,
  CancelReason,
  Candle,
  ClosedTrade,
  CloseReason,
  Equity,
  FundingRate,
  LimitOrder,
  PendingOrder,
  Position,
  TradingCosts,
} from '../../core/types.js'

export interface OrderRecord {
  order: PendingOrder
  /** Цена открытия первой свечи после выставления. Нужна, чтобы оценить упущенный вход. */
  firstCandleOpen: number | null
  outcome: 'filled' | CancelReason | 'open'
}

export interface SimulatedBrokerOptions {
  initialBalance: number
  costs: TradingCosts
  clock: Clock
}

interface OpenState {
  position: Position
  fees: number
  funding: number
  closeRequest: CloseReason | null
}

export class SimulatedBroker implements Broker {
  private balance: number
  private nextId = 1
  private readonly orders = new Map<string, OrderRecord>()
  private readonly open = new Map<string, OpenState>()
  private readonly lastPrice = new Map<string, number>()
  private readonly history: OrderRecord[] = []
  private readonly closed: ClosedTrade[] = []
  private events: BrokerEvent[] = []

  constructor(private readonly options: SimulatedBrokerOptions) {
    this.balance = options.initialBalance
  }

  async equity(): Promise<Equity> {
    let unrealized = 0
    let usedMargin = 0
    for (const { position, fees, funding } of this.open.values()) {
      const price = this.lastPrice.get(position.symbol) ?? position.entryPrice
      unrealized += direction(position) * (price - position.entryPrice) * position.qty - fees - funding
      usedMargin += (position.qty * position.entryPrice) / position.leverage
    }
    for (const { order } of this.orders.values()) {
      usedMargin += (order.qty * order.price) / order.leverage
    }
    return { balance: this.balance, unrealized, total: this.balance + unrealized, usedMargin }
  }

  async openPositions(): Promise<Position[]> {
    return [...this.open.values()].map((state) => ({ ...state.position }))
  }

  async pendingOrders(): Promise<PendingOrder[]> {
    return [...this.orders.values()].map((record) => ({ ...record.order }))
  }

  async placeLimit(order: LimitOrder): Promise<PendingOrder> {
    const pending: PendingOrder = { ...order, id: `o${this.nextId++}`, placedAt: this.options.clock.now() }
    const record: OrderRecord = { order: pending, firstCandleOpen: null, outcome: 'open' }
    this.orders.set(pending.id, record)
    this.history.push(record)
    return { ...pending }
  }

  async cancelOrder(id: string, reason: CancelReason): Promise<void> {
    const record = this.orders.get(id)
    if (!record) throw new Error(`Ордер ${id} не найден`)
    this.cancel(record, reason)
  }

  async amend(id: string, change: { stop?: number; take?: number }): Promise<Position> {
    const state = this.requireOpen(id)
    state.position = { ...state.position, ...change }
    return { ...state.position }
  }

  async close(id: string, reason: CloseReason): Promise<void> {
    this.requireOpen(id).closeRequest = reason
  }

  async poll(): Promise<BrokerEvent[]> {
    const events = this.events
    this.events = []
    return events
  }

  /** Обрабатывает одну закрытую свечу монеты. Порядок шагов определяет исход спорных свечей. */
  feed(symbol: string, candle: Candle): void {
    this.executeCloseRequests(symbol, candle)
    this.processOrders(symbol, candle)
    this.processPositions(symbol, candle)
    this.lastPrice.set(symbol, candle.close)
  }

  feedFunding(symbol: string, rate: FundingRate): void {
    for (const state of this.open.values()) {
      if (state.position.symbol !== symbol) continue
      const price = this.lastPrice.get(symbol) ?? state.position.entryPrice
      state.funding += direction(state.position) * state.position.qty * price * rate.rate
    }
  }

  /** Конец прогона: ордера отменяются, позиции закрываются по последней цене как рыночные. */
  closeAll(reason: 'end_of_run'): void {
    for (const record of [...this.orders.values()]) this.cancel(record, reason)
    for (const state of [...this.open.values()]) {
      const { symbol, entryPrice } = state.position
      this.closeMarket(state, this.lastPrice.get(symbol) ?? entryPrice, reason)
    }
  }

  orderHistory(): OrderRecord[] {
    return this.history
  }

  closedTrades(): ClosedTrade[] {
    return this.closed
  }

  private executeCloseRequests(symbol: string, candle: Candle): void {
    for (const state of [...this.open.values()]) {
      if (state.position.symbol === symbol && state.closeRequest) {
        this.closeMarket(state, candle.open, state.closeRequest)
      }
    }
  }

  private processOrders(symbol: string, candle: Candle): void {
    const through = this.options.costs.limitFillThroughPct / 100

    for (const record of [...this.orders.values()]) {
      const { order } = record
      if (order.symbol !== symbol) continue
      const long = order.side === 'long'

      if (record.firstCandleOpen === null) {
        record.firstCandleOpen = candle.open
        if (long ? candle.open <= order.price : candle.open >= order.price) {
          this.cancel(record, 'post_only')
          continue
        }
      }
      if (order.expiresAt <= candle.openTime) {
        this.cancel(record, 'expired')
        continue
      }

      const filled = long ? candle.low <= order.price * (1 - through) : candle.high >= order.price * (1 + through)
      if (filled) this.fill(record, candle)
      else if (long ? candle.high >= order.take : candle.low <= order.take) this.cancel(record, 'take_reached')
    }
  }

  private processPositions(symbol: string, candle: Candle): void {
    for (const state of [...this.open.values()]) {
      const { position } = state
      if (position.symbol !== symbol) continue
      const long = position.side === 'long'
      const filledNow = position.openedAt === candle.closeTime

      if (long ? candle.low <= position.stop : candle.high >= position.stop) {
        // В свече входа цена сначала прошла ордер, поэтому открытие этой свечи к стопу не относится.
        const gapped = long ? Math.min(position.stop, candle.open) : Math.max(position.stop, candle.open)
        this.closeMarket(state, filledNow ? position.stop : gapped, 'stop')
      } else if (!filledNow && (long ? candle.high >= position.take : candle.low <= position.take)) {
        const fee = (position.qty * position.take * this.options.costs.makerPct) / 100
        this.finish(state, position.take, fee, 0, 'take')
      }
    }
  }

  private fill(record: OrderRecord, candle: Candle): void {
    const { order } = record
    const position: Position = {
      id: `p${this.nextId++}`,
      symbol: order.symbol,
      side: order.side,
      kind: order.kind,
      qty: order.qty,
      leverage: order.leverage,
      entryPrice: order.price,
      initialStop: order.stop,
      stop: order.stop,
      take: order.take,
      openedAt: candle.closeTime,
      reason: order.reason,
    }
    const fees = (order.qty * order.price * this.options.costs.makerPct) / 100
    this.open.set(position.id, { position, fees, funding: 0, closeRequest: null })
    this.orders.delete(order.id)
    record.outcome = 'filled'
    this.events.push({ type: 'filled', position: { ...position } })
  }

  private cancel(record: OrderRecord, reason: CancelReason): void {
    this.orders.delete(record.order.id)
    record.outcome = reason
    this.events.push({ type: 'cancelled', order: { ...record.order }, reason })
  }

  /** Рыночный выход: проскальзывание против нас и комиссия taker. */
  private closeMarket(state: OpenState, price: number, reason: CloseReason): void {
    const { position } = state
    const { takerPct, slippagePct } = this.options.costs
    const exit = price * (1 - (direction(position) * slippagePct) / 100)
    const fee = (position.qty * exit * takerPct) / 100
    this.finish(state, exit, fee, Math.abs(price - exit) * position.qty, reason)
  }

  private finish(state: OpenState, exit: number, exitFee: number, slippageCost: number, reason: CloseReason): void {
    const { position, funding } = state
    const fees = state.fees + exitFee
    const pnl = direction(position) * (exit - position.entryPrice) * position.qty - fees - funding
    const trade: ClosedTrade = {
      ...position,
      exitPrice: exit,
      closedAt: this.options.clock.now(),
      closeReason: reason,
      pnl,
      r: pnl / (position.qty * Math.abs(position.entryPrice - position.initialStop)),
      fees,
      slippageCost,
      funding,
    }
    this.balance += pnl
    this.open.delete(position.id)
    this.closed.push(trade)
    this.events.push({ type: 'closed', trade })
  }

  private requireOpen(id: string): OpenState {
    const state = this.open.get(id)
    if (!state) throw new Error(`Позиция ${id} не найдена`)
    return state
  }
}

function direction(position: Position): 1 | -1 {
  return position.side === 'long' ? 1 : -1
}
