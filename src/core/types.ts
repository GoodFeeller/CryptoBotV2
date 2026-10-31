import type { Timeframe } from './timeframes.js'

export type { Timeframe } from './timeframes.js'

export type Side = 'long' | 'short'
export type CandleWindows = Partial<Record<Timeframe, Candle[]>>

export interface Candle {
  openTime: number
  /** Начало следующей свечи, см. isCloseOf. */
  closeTime: number
  open: number
  high: number
  low: number
  close: number
  volume: number
  turnover: number
}

export interface FundingRate {
  time: number
  rate: number
}

export interface Instrument {
  symbol: string
  tickSize: number
  qtyStep: number
  minQty: number
  launchTime: number
  maxLeverage: number
}

export interface PriceLevel {
  price: number
  touches: number
}

export interface Situation {
  symbol: string
  kind: string
  at: number
  levels: PriceLevel[]
  /** Значения по имени. Имена индикаторов в единицах цены начинаются с `price:`, например `price:ema50`. */
  indicators: Record<string, number>
}

export interface SignalContext {
  symbol: string
  now: number
  candles: CandleWindows
}

export interface EntryRequest {
  situation: Situation
  currentPrice: number
  candles: CandleWindows
  /** Сколько ещё можно потерять, % капитала. */
  maxLossPct: number
}

export type EntryDecision =
  | { enter: false; reason: string }
  | {
      enter: true
      side: Side
      entryPrice: number
      leverage: number
      notionalPct: number
      stop: number
      take: number
      reason: string
    }
  | { failed: true; message: string }

export interface ReviewRequest {
  position: Position
  currentPrice: number
  now: number
  candles: CandleWindows
}

export type ReviewDecision =
  | { newStop: number | null; newTake: number | null; closeNow: boolean; reason: string }
  | { failed: true; message: string }

export interface Equity {
  /** Баланс закрытых сделок, от него считается объём. */
  balance: number
  unrealized: number
  /** balance + unrealized, от него считается просадка. */
  total: number
  /** Маржа открытых сделок и ордеров. */
  usedMargin: number
}

export interface LimitOrder {
  symbol: string
  side: Side
  kind: string
  price: number
  qty: number
  leverage: number
  stop: number
  take: number
  expiresAt: number
  reason: string
}

export interface PendingOrder extends LimitOrder {
  id: string
  placedAt: number
}

export interface Position {
  id: string
  symbol: string
  side: Side
  kind: string
  qty: number
  leverage: number
  entryPrice: number
  /** Стоп при открытии: не меняется и задаёт размер 1R, даже если текущий стоп подвинули. */
  initialStop: number
  stop: number
  take: number
  openedAt: number
  reason: string
}

export type CloseReason = 'stop' | 'take' | 'advisor' | 'end_of_run'
export type CancelReason = 'post_only' | 'expired' | 'take_reached' | 'risk_halt' | 'end_of_run'

export interface ClosedTrade extends Position {
  exitPrice: number
  closedAt: number
  closeReason: CloseReason
  /** Итог в USDT после комиссий, проскальзывания и фандинга. */
  pnl: number
  r: number
  fees: number
  slippageCost: number
  funding: number
}

export type BrokerEvent =
  | { type: 'filled'; position: Position }
  | { type: 'closed'; trade: ClosedTrade }
  | { type: 'cancelled'; order: PendingOrder; reason: CancelReason }

export interface TradingCosts {
  takerPct: number
  makerPct: number
  slippagePct: number
  limitFillThroughPct: number
  maintenanceMarginPct: number
}

export interface Exposure {
  /** Потеря при стопе одной сделки или ордера, USDT. */
  lossAtStop: number
}

export type SizingResult =
  | { ok: true; qty: number }
  | { ok: false; reason: 'below_min_qty' | 'no_margin' }

export type GateResult = { allowed: true } | { allowed: false; drawdownPct: number }
