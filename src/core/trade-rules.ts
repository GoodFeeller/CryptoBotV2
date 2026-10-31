// [REVIEW i-code#18] Правила, которые код применяет к любому решению советника: Claude, сессии или случайного выбора.
// Они лежат в core, а не в фиче claude, потому что движок обязан проверять решение независимо от того, кто его принял,
// а импортировать фичи ему нельзя. Это чистые функции без зависимостей, поэтому граница core не нарушена.
import type { Instrument, Side, TradingCosts } from './types.js'

export interface EntryPlan {
  side: Side
  entryPrice: number
  stop: number
  take: number
  leverage: number
  notionalPct: number
}

export interface EntryRulesContext {
  currentPrice: number
  balance: number
  usedMargin: number
  /** Сколько ещё можно потерять, USDT. */
  maxLoss: number
  minStopPct: number
  costs: TradingCosts
  instrument: Instrument
}

export type EntryCheck =
  | { ok: true; side: Side; entryPrice: number; stop: number; take: number; leverage: number; qty: number }
  | { ok: false; error: string }

export interface ReviewChange {
  newStop: number | null
  newTake: number | null
  closeNow: boolean
}

export interface ReviewContext {
  side: Side
  currentPrice: number
  stop: number
  take: number
  tickSize: number
}

export type ReviewCheck = ({ ok: true } & ReviewChange) | { ok: false; error: string }

export function roundDownToStep(value: number, step: number): number {
  return clean(Math.floor(value / step + 1e-9) * step, step)
}

export function roundToStep(value: number, step: number): number {
  return clean(Math.round(value / step) * step, step)
}

/** Убирает хвост вроде 0.30000000000000004. */
function clean(value: number, step: number): number {
  const decimals = Math.max(0, Math.ceil(-Math.log10(step)) + 1)
  return Number(value.toFixed(decimals))
}

/** Потеря при срабатывании стопа, USDT, вместе с издержками. Подтянутый в прибыль стоп даёт 0. */
export function lossAtStop(
  trade: { qty: number; entryPrice: number; stop: number; side: Side },
  costs: TradingCosts,
): number {
  const { qty, entryPrice, stop, side } = trade
  const move = side === 'long' ? entryPrice - stop : stop - entryPrice
  const entryFee = (qty * entryPrice * costs.makerPct) / 100
  const exitCost = (qty * stop * (costs.takerPct + costs.slippagePct)) / 100
  return Math.max(0, qty * move + entryFee + exitCost)
}

export function validateEntryPlan(plan: EntryPlan, ctx: EntryRulesContext): EntryCheck {
  const { side, leverage, notionalPct } = plan
  const { currentPrice, balance, usedMargin, maxLoss, minStopPct, costs, instrument } = ctx
  const numbers = [plan.entryPrice, plan.stop, plan.take, leverage, notionalPct]
  if (!numbers.every((value) => Number.isFinite(value) && value > 0)) {
    return fail('цены, плечо и сумма должны быть положительными числами')
  }

  const entryPrice = roundToStep(plan.entryPrice, instrument.tickSize)
  const stop = roundToStep(plan.stop, instrument.tickSize)
  const take = roundToStep(plan.take, instrument.tickSize)
  const long = side === 'long'

  if (long ? entryPrice >= currentPrice : entryPrice <= currentPrice) {
    return fail('вход исполнился бы сразу: лимитный ордер должен быть лонг ниже цены, шорт выше')
  }
  if (long ? stop >= entryPrice : stop <= entryPrice) return fail('стоп не с той стороны от входа')
  if (long ? take <= entryPrice : take >= entryPrice) return fail('тейк не с той стороны от входа')

  const stopPct = (Math.abs(entryPrice - stop) / entryPrice) * 100
  if (stopPct < minStopPct) return fail(`стоп слишком близко: ${stopPct.toFixed(3)}%, минимум ${minStopPct}%`)

  const takePct = (Math.abs(take - entryPrice) / entryPrice) * 100
  if (takePct <= costs.makerPct * 2 + costs.slippagePct) return fail('тейк не окупает издержки')

  if (leverage > instrument.maxLeverage) return fail(`плечо ${leverage} выше предела монеты ${instrument.maxLeverage}`)
  if (stopPct >= 100 / leverage - costs.maintenanceMarginPct) return fail('ликвидация наступит раньше стопа')

  const qty = roundDownToStep((balance * notionalPct) / 100 / entryPrice, instrument.qtyStep)
  if (qty < instrument.minQty) return fail(`объём ${qty} ниже минимума биржи ${instrument.minQty}`)

  if ((qty * entryPrice) / leverage > balance - usedMargin) return fail('не хватает маржи')

  const loss = lossAtStop({ qty, entryPrice, stop, side }, costs)
  if (loss > maxLoss) return fail(`потеря при стопе ${loss.toFixed(2)} больше допустимой ${maxLoss.toFixed(2)}`)

  return { ok: true, side, entryPrice, stop, take, leverage, qty }
}

export function validateReviewChange(change: ReviewChange, ctx: ReviewContext): ReviewCheck {
  if (change.closeNow) return { ok: true, newStop: null, newTake: null, closeNow: true }

  const { side, currentPrice, stop, take, tickSize } = ctx
  const long = side === 'long'
  const newStop = changed(change.newStop, stop, tickSize)
  const newTake = changed(change.newTake, take, tickSize)

  if (newStop !== null) {
    if (long ? newStop < stop : newStop > stop) return fail('новый стоп увеличивает риск')
    if (long ? newStop >= currentPrice : newStop <= currentPrice) return fail('новый стоп за текущей ценой')
  }
  if (newTake !== null && (long ? newTake <= currentPrice : newTake >= currentPrice)) {
    return fail('новый тейк за текущей ценой')
  }
  return { ok: true, newStop, newTake, closeNow: false }
}

/** Округлённое новое значение или null, если значение не задано либо не изменилось. */
function changed(value: number | null, current: number, tickSize: number): number | null {
  if (value === null) return null
  const rounded = roundToStep(value, tickSize)
  return rounded === current ? null : rounded
}

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error }
}
