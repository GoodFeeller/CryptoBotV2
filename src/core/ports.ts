import type {
  BrokerEvent,
  CancelReason,
  Candle,
  ClosedTrade,
  EmaSnapshot,
  CloseReason,
  EntryDecision,
  EntryRequest,
  Equity,
  Exposure,
  FundingRate,
  GateResult,
  Instrument,
  Level,
  LimitOrder,
  PendingOrder,
  Position,
  ReviewDecision,
  ReviewRequest,
  Side,
  SignalContext,
  StructureSnapshot,
  Situation,
  Timeframe,
  WaveSnapshot,
} from './types.js'

export interface Clock {
  /** Текущее время, мс UTC. В бэктесте это момент закрытия обрабатываемой свечи. */
  now(): number
}

export interface MarketData {
  instrument(symbol: string): Promise<Instrument>
  /** Только свечи, закрытые не позже endAt. Незакрытую свечу не возвращает никогда. */
  candles(symbol: string, tf: Timeframe, endAt: number, limit: number): Promise<Candle[]>
  fundingRates(symbol: string, from: number, to: number): Promise<FundingRate[]>
}

export interface SignalDetector {
  /** true у заглушек: по их прогонам вердикт всегда N/A. */
  readonly isPlaceholder: boolean
  /** Асинхронный: настоящему детектору нужно загрузить свечи. */
  detect(ctx: SignalContext): Promise<Situation | null>
}

/** Модули анализа рынка. Каждый метод видит только свечи, закрытые к моменту at. */
export interface MarketAnalysis {
  /** Основные уровни по дневкам и локальные по часовикам, совпадающие локальные убраны. */
  levels(daily: Candle[], hourly: Candle[]): Level[]
  ema(candles: Candle[], at: number): EmaSnapshot
  waves(candles: Candle[], at: number, scale: 'small' | 'big'): WaveSnapshot
  structure(candles: Candle[], at: number): StructureSnapshot
}

export interface TradeAdvisor {
  decideEntry(req: EntryRequest): Promise<EntryDecision>
  reviewTrade(req: ReviewRequest): Promise<ReviewDecision>
}

export interface RiskGate {
  update(equity: Equity): void
  canOpen(): GateResult
  /** Сколько ещё можно потерять, USDT. Может быть отрицательным: тогда Claude не вызывается. */
  availableLoss(equity: Equity, exposures: Exposure[]): number
}

export interface Broker {
  equity(): Promise<Equity>
  openPositions(): Promise<Position[]>
  pendingOrders(): Promise<PendingOrder[]>
  /** Только post-only: ордер, который исполнился бы сразу, отклоняется. */
  placeLimit(order: LimitOrder): Promise<PendingOrder>
  cancelOrder(id: string, reason: CancelReason): Promise<void>
  amend(id: string, change: { stop?: number; take?: number }): Promise<Position>
  /** Ставит закрытие в очередь. Результат придёт событием из poll(). */
  close(id: string, reason: CloseReason): Promise<void>
  /** Отдаёт накопленные события и очищает очередь. */
  poll(): Promise<BrokerEvent[]>
}

export interface ChartInput {
  symbol: string
  side: Side
  candles: Candle[]
  entryPrice: number
  stop: number
  take: number
  /** Только у закрытой сделки. */
  exit?: { price: number; time: number }
}

export interface ChartRenderer {
  /** Возвращает PNG. */
  render(input: ChartInput): Promise<Uint8Array>
}

export interface TradeOpenedEvent {
  position: Position
  /** null, если картинка не построилась: сообщение всё равно уходит. */
  chart: Uint8Array | null
}

export interface TradeClosedEvent {
  trade: ClosedTrade
  chart: Uint8Array | null
}

export interface PriceChange {
  was: number
  now: number
}

export interface TradeEditedEvent {
  position: Position
  /** Только изменившиеся поля. */
  changes: { stop?: PriceChange; take?: PriceChange }
  reason: string
}

export interface ErrorEvent {
  where: string
  message: string
  /** Что бот сделал дальше. */
  action: string
}

export interface Notifier {
  tradeOpened(e: TradeOpenedEvent): Promise<void>
  tradeClosed(e: TradeClosedEvent): Promise<void>
  tradeEdited(e: TradeEditedEvent): Promise<void>
  error(e: ErrorEvent): Promise<void>
}
