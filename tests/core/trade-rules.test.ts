import { describe, expect, it } from 'vitest'
import {
  lossAtStop,
  roundDownToStep,
  roundToStep,
  validateEntryPlan,
  validateReviewChange,
  type EntryPlan,
  type EntryRulesContext,
} from '../../src/core/trade-rules.js'
import type { Instrument, TradingCosts } from '../../src/core/types.js'

const COSTS: TradingCosts = {
  takerPct: 0.055,
  makerPct: 0.02,
  slippagePct: 0.05,
  limitFillThroughPct: 0.02,
  maintenanceMarginPct: 0.5,
}
const INSTRUMENT: Instrument = {
  symbol: 'BTCUSDT',
  tickSize: 0.01,
  qtyStep: 0.001,
  minQty: 0.001,
  launchTime: 0,
  maxLeverage: 50,
}
const CTX: EntryRulesContext = {
  currentPrice: 100,
  balance: 10_000,
  usedMargin: 0,
  maxLoss: 1000,
  minStopPct: 0.3,
  costs: COSTS,
  instrument: INSTRUMENT,
}
const LONG: EntryPlan = { side: 'long', entryPrice: 99, stop: 97, take: 103, leverage: 5, notionalPct: 20 }
const SHORT: EntryPlan = { side: 'short', entryPrice: 101, stop: 103, take: 97, leverage: 5, notionalPct: 20 }

function rejected(plan: Partial<EntryPlan>, ctx: Partial<EntryRulesContext> = {}, base = LONG): string {
  const result = validateEntryPlan({ ...base, ...plan }, { ...CTX, ...ctx })
  if (result.ok) throw new Error('ожидался отказ')
  return result.error
}

describe('rounding', () => {
  it('rounds down to the step without floating point noise', () => {
    expect(roundDownToStep(0.3, 0.1)).toBe(0.3)
    expect(roundDownToStep(1.2345, 0.001)).toBe(1.234)
    expect(roundDownToStep(0.999, 1)).toBe(0)
  })

  it('rounds to the nearest step', () => {
    expect(roundToStep(100.126, 0.01)).toBe(100.13)
  })
})

describe('lossAtStop', () => {
  it('includes the price move and all costs', () => {
    // 10 × 2 = 20 движение; вход maker 1000×0.02% = 0.2; выход 980 × (0.055% + 0.05%) = 1.029
    expect(lossAtStop({ qty: 10, entryPrice: 100, stop: 98, side: 'long' }, COSTS)).toBeCloseTo(21.229, 3)
  })

  it('is not negative when the stop is already in profit', () => {
    expect(lossAtStop({ qty: 10, entryPrice: 100, stop: 110, side: 'long' }, COSTS)).toBe(0)
  })
})

describe('validateEntryPlan', () => {
  it('accepts a valid long and computes qty from notional', () => {
    const result = validateEntryPlan(LONG, CTX)

    expect(result).toMatchObject({ ok: true, qty: 20.202, entryPrice: 99, stop: 97, take: 103, leverage: 5 })
  })

  it('accepts a valid short', () => {
    expect(validateEntryPlan(SHORT, CTX).ok).toBe(true)
  })

  it('rounds prices to the tick', () => {
    expect(validateEntryPlan({ ...LONG, entryPrice: 99.004 }, CTX)).toMatchObject({ entryPrice: 99 })
  })

  it('has no fixed reward to risk: take closer than the stop is fine', () => {
    expect(validateEntryPlan({ ...LONG, stop: 97, take: 100 }, CTX).ok).toBe(true)
  })

  it('rejects an entry that would fill at once', () => {
    expect(rejected({ entryPrice: 100 })).toMatch(/вход/)
    expect(rejected({ entryPrice: 100 }, {}, SHORT)).toMatch(/вход/)
  })

  it('rejects stop and take on the wrong side', () => {
    expect(rejected({ stop: 100 })).toMatch(/стоп/i)
    expect(rejected({ take: 98 })).toMatch(/тейк/i)
    expect(rejected({ stop: 100 }, {}, SHORT)).toMatch(/стоп/i)
    expect(rejected({ take: 102 }, {}, SHORT)).toMatch(/тейк/i)
  })

  it('rejects a stop closer than minStopPct', () => {
    expect(rejected({ stop: 98.8 })).toMatch(/близко/)
  })

  it('rejects a take that does not cover costs', () => {
    expect(rejected({ take: 99.05 })).toMatch(/издержки/)
  })

  it('rejects zero, negative and non finite numbers', () => {
    expect(rejected({ entryPrice: 0 })).toBeTruthy()
    expect(rejected({ stop: -1 })).toBeTruthy()
    expect(rejected({ notionalPct: 0 })).toBeTruthy()
    expect(rejected({ leverage: Number.NaN })).toBeTruthy()
  })

  it('rejects leverage above the coin limit', () => {
    expect(rejected({ leverage: 51 })).toMatch(/плечо/i)
  })

  it('rejects when margin does not fit', () => {
    expect(rejected({ notionalPct: 100, leverage: 1 }, { usedMargin: 5000 })).toMatch(/маржи/)
  })

  it('rejects when liquidation comes before the stop', () => {
    expect(rejected({ stop: 89, leverage: 10 })).toMatch(/ликвидация/)
  })

  it('rejects when the loss at stop exceeds the allowance', () => {
    // 20% капитала = 2000 USDT, стоп ~2% = около 40 USDT
    expect(rejected({}, { maxLoss: 30 })).toMatch(/потеря/)
    expect(validateEntryPlan(LONG, { ...CTX, maxLoss: 50 }).ok).toBe(true)
  })

  it('rejects a size below the exchange minimum', () => {
    expect(rejected({ notionalPct: 0.0001 })).toMatch(/минимум/)
  })
})

describe('validateReviewChange', () => {
  const LONG_CTX = { side: 'long', currentPrice: 105, stop: 97, take: 110, tickSize: 0.01 } as const
  const SHORT_CTX = { side: 'short', currentPrice: 95, stop: 103, take: 90, tickSize: 0.01 } as const

  it('closeNow wins over other fields', () => {
    expect(validateReviewChange({ newStop: 1, newTake: 1, closeNow: true }, LONG_CTX)).toEqual({
      ok: true,
      newStop: null,
      newTake: null,
      closeNow: true,
    })
  })

  it('accepts a stop that reduces risk', () => {
    expect(validateReviewChange({ newStop: 100, newTake: null, closeNow: false }, LONG_CTX)).toMatchObject({
      ok: true,
      newStop: 100,
    })
    expect(validateReviewChange({ newStop: 100, newTake: null, closeNow: false }, SHORT_CTX)).toMatchObject({
      ok: true,
      newStop: 100,
    })
  })

  it('rejects a stop that increases risk', () => {
    expect(validateReviewChange({ newStop: 96, newTake: null, closeNow: false }, LONG_CTX).ok).toBe(false)
    expect(validateReviewChange({ newStop: 104, newTake: null, closeNow: false }, SHORT_CTX).ok).toBe(false)
  })

  it('rejects a stop beyond the current price', () => {
    expect(validateReviewChange({ newStop: 106, newTake: null, closeNow: false }, LONG_CTX).ok).toBe(false)
    expect(validateReviewChange({ newStop: 94, newTake: null, closeNow: false }, SHORT_CTX).ok).toBe(false)
  })

  it('moves the take either way but keeps it on the right side', () => {
    expect(validateReviewChange({ newStop: null, newTake: 106, closeNow: false }, LONG_CTX).ok).toBe(true)
    expect(validateReviewChange({ newStop: null, newTake: 120, closeNow: false }, LONG_CTX).ok).toBe(true)
    expect(validateReviewChange({ newStop: null, newTake: 104, closeNow: false }, LONG_CTX).ok).toBe(false)
    expect(validateReviewChange({ newStop: null, newTake: 96, closeNow: false }, SHORT_CTX).ok).toBe(false)
  })

  it('treats a repeated value as no change', () => {
    expect(validateReviewChange({ newStop: 97, newTake: 110, closeNow: false }, LONG_CTX)).toEqual({
      ok: true,
      newStop: null,
      newTake: null,
      closeNow: false,
    })
  })

  it('one invalid field rejects the whole answer', () => {
    expect(validateReviewChange({ newStop: 96, newTake: 120, closeNow: false }, LONG_CTX).ok).toBe(false)
  })
})
