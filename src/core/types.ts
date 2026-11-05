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

export type LevelClass = 'major' | 'local'
export type LevelOrigin = 'pivot' | 'trend_break' | 'consolidation' | 'paranormal_bar'

export interface LevelEvent {
  time: number
  type: 'bounce' | 'false_break'
  /** С какой стороны от уровня была цена. */
  side: 'above' | 'below'
}

export interface LevelZone {
  from: number
  to: number
  low: number
  high: number
}

export interface Level {
  class: LevelClass
  price: number
  /** traded: цена долго ходила вокруг уровня, и пока не будет нового отскока, использовать его нельзя.
   * broken: уровень пробили, и с новой стороны от него ещё не было отскока. Использовать его тоже нельзя. */
  status: 'active' | 'traded' | 'broken'
  origins: LevelOrigin[]
  /** Момент, когда уровень стал известен. Раньше него уровень использовать нельзя. */
  bornAt: number
  /** Отскоки и ложные пробои: чем их больше, тем сильнее уровень. */
  bounces: number
  falseBreaks: number
  /** Сколько раз уровень сменил сторону: поддержка стала сопротивлением или наоборот. */
  flips: number
  strength: number
  events: LevelEvent[]
  zones: LevelZone[]
}

export interface Situation {
  symbol: string
  kind: string
  at: number
  /** Картина рынка. У заглушек null. */
  picture: MarketPicture | null
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

// Снимки модулей анализа. Модули считают их по свечам, детектор и Claude получают их через MarketAnalysis.

export interface EmaReading {
  period: number
  value: number
  /** С какой стороны EMA цена закрытия последней свечи. */
  priceSide: 'above' | 'below'
  /** Насколько цена от EMA, в ATR. Всегда не меньше нуля, сторону показывает priceSide. */
  distanceAtr: number
  slope: 'up' | 'down' | 'flat'
}

/** up: быстрые EMA выше медленных по порядку, down: наоборот, mixed: любой другой порядок. */
export type EmaStack = 'up' | 'down' | 'mixed'

export type EmaSnapshot =
  | { ok: true; at: number; close: number; emas: EmaReading[]; stack: EmaStack }
  | { ok: false; reason: 'not_enough_candles'; needed: number; got: number }

export type WaveDirection = 'up' | 'down'

export interface WavePoint {
  time: number
  price: number
}

export interface Wave {
  direction: WaveDirection
  from: WavePoint
  to: WavePoint
  length: number
}

export type WaveSnapshot =
  | {
      ok: true
      at: number
      close: number
      atr: number
      /** Завершённые волны от старых к новым. */
      waves: Wave[]
      /** Обычный размер волны в цене и в ATR. */
      average: Record<WaveDirection, number>
      averageAtr: Record<WaveDirection, number>
      /** Текущая волна: от последнего разворота до самой дальней цены после него. share это доля от обычного размера. */
      current: { direction: WaveDirection; start: WavePoint; extreme: WavePoint; length: number; lengthAtr: number; share: number }
      /** Верх, низ и середина последней завершённой волны: ключевые зоны по видео. */
      lastWave: { direction: WaveDirection; top: number; bottom: number; middle: number }
    }
  | { ok: false; reason: 'not_enough_waves'; up: number; down: number; needed: number }

export type Trend = 'up' | 'down' | 'flat'

export interface StructurePoint {
  time: number
  price: number
}

export type StructureSnapshot =
  | {
      ok: true
      at: number
      close: number
      trend: Trend
      /** Для флэта: последний тренд перед ним, null если тренда не было. Для тренда всегда null. */
      previousTrend: 'up' | 'down' | null
      /** Два последних максимума и минимума, старый первым. */
      highs: [StructurePoint, StructurePoint]
      lows: [StructurePoint, StructurePoint]
      /** Цена уже за последним максимумом или минимумом, а новый разворот ещё не подтверждён. */
      beyond: 'above_high' | 'below_low' | null
    }
  | { ok: false; reason: 'not_enough_pivots'; highs: number; lows: number; needed: 2 }

export type ZoneReason =
  | { type: 'level'; class: LevelClass; bounces: number; flips: number }
  | { type: 'wave'; part: 'top' | 'middle' | 'bottom' }

export interface PictureLevel {
  price: number
  class: LevelClass
  status: Level['status']
  bounces: number
  falseBreaks: number
  flips: number
}

export interface WavePicture {
  averageAtr: Record<WaveDirection, number>
  current: { direction: WaveDirection; startPrice: number; lengthAtr: number; share: number }
  lastWave: { direction: WaveDirection; top: number; middle: number; bottom: number }
}

/** Картина рынка в момент ситуации. Цены реальные, шкалу для Claude строит обезличивание. */
export interface MarketPicture {
  zone: { price: number; low: number; high: number; reasons: ZoneReason[] }
  /** Уровни рядом с ценой любого статуса. */
  levels: PictureLevel[]
  waves: Record<'small' | 'big', WavePicture>
  structure: { trend: Trend; previousTrend: 'up' | 'down' | null; beyond: 'above_high' | 'below_low' | null; highs: StructurePoint[]; lows: StructurePoint[] }
  /** Только таймфреймы, где снимок EMA получился: у молодых монет нет дневной EMA. */
  ema: Partial<Record<Timeframe, { stack: EmaStack; emas: EmaReading[] }>>
  /** ATR в процентах от цены. */
  atrPct: Partial<Record<Timeframe, number>>
}
