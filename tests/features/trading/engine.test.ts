import { beforeEach, describe, expect, it } from 'vitest'
import { FatalRunError } from '../../../src/core/errors.js'
import type { Broker, MarketData, Notifier, TradeAdvisor } from '../../../src/core/ports.js'
import type {
  BrokerEvent,
  Candle,
  ClosedTrade,
  EntryDecision,
  Equity,
  LimitOrder,
  PendingOrder,
  Position,
  ReviewDecision,
  Situation,
} from '../../../src/core/types.js'
import { DrawdownGate } from '../../../src/features/risk/drawdown-gate.js'
import { TradingEngine, type EngineConfig } from '../../../src/features/trading/engine.js'

const HOUR = 3_600_000
const T0 = Date.UTC(2026, 0, 10, 12)
const INSTRUMENT = { symbol: 'X', tickSize: 0.01, qtyStep: 0.001, minQty: 0.001, launchTime: 0, maxLeverage: 50 }

const ENTER: EntryDecision = {
  enter: true,
  side: 'long',
  entryPrice: 99,
  leverage: 5,
  notionalPct: 20,
  stop: 97,
  take: 104,
  reason: 'отбой',
}

const POSITION: Position = {
  id: 'p1',
  symbol: 'BTCUSDT',
  side: 'long',
  kind: 'test',
  qty: 1,
  leverage: 5,
  entryPrice: 99,
  initialStop: 97,
  stop: 97,
  take: 104,
  openedAt: T0 - HOUR,
  reason: 'r',
}

const CONFIG: EngineConfig = {
  symbols: ['BTCUSDT', 'ETHUSDT'],
  executionTimeframe: '5m',
  signalTimeframe: '1h',
  windows: { '1h': 3 },
  maxPositions: 5,
  limitOrderTtlHours: 4,
  minStopPct: 0.3,
  costs: { takerPct: 0.055, makerPct: 0.02, slippagePct: 0.05, limitFillThroughPct: 0.02, maintenanceMarginPct: 0.5 },
}

class Harness {
  log: string[] = []
  events: BrokerEvent[] = []
  positions: Position[] = []
  orders: PendingOrder[] = []
  placed: LimitOrder[] = []
  amended: unknown[] = []
  closes: unknown[] = []
  cancelled: unknown[] = []
  notes: { type: string; event: any }[] = []
  entryRequests: any[] = []
  reviewRequests: any[] = []
  entry: EntryDecision = ENTER
  review: ReviewDecision = { newStop: null, newTake: null, closeNow: false, reason: 'ok' }
  situations: Record<string, boolean> = { BTCUSDT: true }
  emptySymbols = new Set<string>()
  failingSymbols = new Set<string>()
  balance = 10_000
  total = 10_000
  notifierFails = false
  chartFails = false

  broker: Broker = {
    equity: async (): Promise<Equity> => {
      this.log.push('equity')
      return { balance: this.balance, unrealized: this.total - this.balance, total: this.total, usedMargin: 0 }
    },
    openPositions: async () => this.positions,
    pendingOrders: async () => this.orders,
    placeLimit: async (order) => {
      this.placed.push(order)
      return { ...order, id: 'o1', placedAt: 0 }
    },
    cancelOrder: async (id, reason) => {
      this.cancelled.push([id, reason])
    },
    amend: async (id, change) => {
      this.amended.push([id, change])
      return { ...POSITION, ...change }
    },
    close: async (id, reason) => {
      this.closes.push([id, reason])
    },
    poll: async () => {
      this.log.push('poll')
      const events = this.events
      this.events = []
      return events
    },
  }

  market: MarketData = {
    instrument: async (symbol) => ({ ...INSTRUMENT, symbol }),
    candles: async (symbol, tf, endAt, limit) => {
      if (this.failingSymbols.has(symbol)) throw new Error(`нет данных ${symbol}`)
      if (this.emptySymbols.has(symbol)) return []
      const candle: Candle = { openTime: endAt - 1, closeTime: endAt, open: 100, high: 100, low: 100, close: 100, volume: 1, turnover: 1 }
      return Array.from({ length: limit }, () => candle)
    },
    fundingRates: async () => [],
  }

  advisor: TradeAdvisor = {
    decideEntry: async (request) => {
      this.log.push('decideEntry')
      this.entryRequests.push(request)
      return this.entry
    },
    reviewTrade: async (request) => {
      this.log.push('reviewTrade')
      this.reviewRequests.push(request)
      return this.review
    },
  }

  notifier: Notifier = {
    tradeOpened: async (event) => this.note('opened', event),
    tradeClosed: async (event) => this.note('closed', event),
    tradeEdited: async (event) => this.note('edited', event),
    error: async (event) => this.note('error', event),
  }

  gate = new DrawdownGate({ maxDrawdownHaltPct: 40 })

  engine = new TradingEngine({
    market: this.market,
    detector: {
      isPlaceholder: true,
      detect: async (ctx) => {
        this.log.push('detect')
        if (!this.situations[ctx.symbol]) return null
        const situation: Situation = { symbol: ctx.symbol, kind: 'test', at: ctx.now, picture: null }
        return situation
      },
    },
    advisor: this.advisor,
    gate: this.gate,
    broker: this.broker,
    notifier: this.notifier,
    chart: {
      render: async () => {
        if (this.chartFails) throw new Error('картинка')
        return new Uint8Array([1])
      },
    },
    config: CONFIG,
  })

  private async note(type: string, event: unknown): Promise<void> {
    this.notes.push({ type, event })
    if (this.notifierFails) throw new Error('Telegram')
  }

  placedOrder(): PendingOrder {
    return {
      id: 'o1',
      symbol: 'SOLUSDT',
      side: 'long',
      kind: 'test',
      price: 99,
      qty: 1,
      leverage: 5,
      stop: 97,
      take: 104,
      expiresAt: T0 + 4 * HOUR,
      reason: 'r',
      placedAt: T0 - HOUR,
    }
  }

  noted(type: string): any[] {
    return this.notes.filter((note) => note.type === type).map((note) => note.event)
  }
}

describe('TradingEngine', () => {
  let h: Harness

  beforeEach(() => {
    h = new Harness()
  })

  describe('order of a step', () => {
    it('polls, updates risk, reviews, then looks for entries', async () => {
      h.positions = [POSITION]
      h.situations = { ETHUSDT: true }

      await h.engine.step(T0)

      const order = ['poll', 'equity', 'reviewTrade', 'detect', 'decideEntry']
      const seen = h.log.filter((entry, i) => order.includes(entry) && h.log.indexOf(entry) === i)
      expect(seen).toEqual(order)
    })
  })

  describe('entries', () => {
    it('looks for entries only on the signal timeframe close', async () => {
      await h.engine.step(T0 + 5 * 60_000)

      expect(h.log).not.toContain('detect')
    })

    it('sends the situation, candles, price and allowed loss', async () => {
      await h.engine.step(T0)

      expect(h.entryRequests[0]).toMatchObject({ currentPrice: 100, maxLossPct: 40 })
      expect(h.entryRequests[0].situation.symbol).toBe('BTCUSDT')
      expect(h.entryRequests[0].candles['1h']).toHaveLength(3)
    })

    it('places a limit order with the decision of the advisor', async () => {
      await h.engine.step(T0)

      expect(h.placed[0]).toMatchObject({
        symbol: 'BTCUSDT',
        side: 'long',
        kind: 'test',
        price: 99,
        qty: 20.202,
        leverage: 5,
        stop: 97,
        take: 104,
        expiresAt: T0 + 4 * HOUR,
        reason: 'отбой',
      })
    })

    it('does not ask the advisor when the coin is busy', async () => {
      h.positions = [{ ...POSITION, openedAt: T0 - 30 * 60_000 }]

      await h.engine.step(T0)

      expect(h.entryRequests).toEqual([])
    })

    it('a pending order blocks its coin and counts toward maxPositions', async () => {
      h.orders = [{ ...h.placedOrder(), symbol: 'BTCUSDT' }]
      await h.engine.step(T0)
      expect(h.entryRequests).toEqual([])

      const limited = new Harness()
      limited.situations = { BTCUSDT: true, ETHUSDT: true }
      limited.orders = Array.from({ length: 5 }, (_, i) => ({ ...limited.placedOrder(), symbol: `C${i}` }))
      await limited.engine.step(T0)
      expect(limited.entryRequests).toEqual([])
    })

    it('does not ask the advisor when no loss is available', async () => {
      h.orders = [{ ...h.placedOrder(), symbol: 'SOLUSDT', qty: 100_000, price: 100, stop: 90 }]

      await h.engine.step(T0)

      expect(h.entryRequests).toEqual([])
    })

    it('rejects a decision breaking the rules: no order, error, counted', async () => {
      h.entry = { ...ENTER, entryPrice: 101 } as EntryDecision

      await h.engine.step(T0)

      expect(h.placed).toEqual([])
      expect(h.noted('error')).toHaveLength(1)
      expect(h.engine.stats().rejectedByRules).toBe(1)
    })

    it('advisor refuses: no order and no error', async () => {
      h.entry = { enter: false, reason: 'нет' }

      await h.engine.step(T0)

      expect(h.placed).toEqual([])
      expect(h.noted('error')).toEqual([])
      expect(h.engine.stats().declined).toBe(1)
    })

    it('advisor failure: no order, error', async () => {
      h.entry = { failed: true, message: 'API' }

      await h.engine.step(T0)

      expect(h.placed).toEqual([])
      expect(h.noted('error')[0].message).toBe('API')
    })

    it('a size below the exchange minimum does not throw', async () => {
      h.balance = 0.001
      h.total = 0.001

      await expect(h.engine.step(T0)).resolves.toBeUndefined()
      expect(h.placed).toEqual([])
    })

    it('a coin with empty or failing candles is skipped, others go on', async () => {
      h.situations = { BTCUSDT: true, ETHUSDT: true }
      h.emptySymbols.add('BTCUSDT')
      await h.engine.step(T0)
      expect(h.placed.map((order) => order.symbol)).toEqual(['ETHUSDT'])

      const failing = new Harness()
      failing.situations = { BTCUSDT: true, ETHUSDT: true }
      failing.failingSymbols.add('BTCUSDT')
      await failing.engine.step(T0)
      expect(failing.placed.map((order) => order.symbol)).toEqual(['ETHUSDT'])
      expect(failing.noted('error')).toHaveLength(1)
    })

    it('a fatal error stops the step instead of skipping the coin', async () => {
      h.advisor.decideEntry = async () => {
        throw new FatalRunError('лимит')
      }

      await expect(h.engine.step(T0)).rejects.toBeInstanceOf(FatalRunError)
    })

    it('two entries in one step share the allowed loss', async () => {
      h.situations = { BTCUSDT: true, ETHUSDT: true }
      h.orders = []
      const placeLimit = h.broker.placeLimit.bind(h.broker)
      h.broker.placeLimit = async (order) => {
        const pending = await placeLimit(order)
        h.orders = [...h.orders, pending]
        return pending
      }

      await h.engine.step(T0)

      expect(h.entryRequests[1].maxLossPct).toBeLessThan(h.entryRequests[0].maxLossPct)
    })
  })

  describe('reviews', () => {
    beforeEach(() => {
      h.situations = {}
    })

    it('fires every 60 minutes from the fill, not between', async () => {
      h.positions = [{ ...POSITION, openedAt: T0 - HOUR }]
      await h.engine.step(T0)
      expect(h.reviewRequests).toHaveLength(1)

      h.positions = [{ ...POSITION, openedAt: T0 - 30 * 60_000 }]
      await h.engine.step(T0)
      expect(h.reviewRequests).toHaveLength(1)

      h.positions = [{ ...POSITION, openedAt: T0 }]
      await h.engine.step(T0)
      expect(h.reviewRequests).toHaveLength(1)
    })

    it('a position in a coin outside the list is still reviewed', async () => {
      h.positions = [{ ...POSITION, symbol: 'OLDUSDT' }]

      await h.engine.step(T0)

      expect(h.reviewRequests[0].position.symbol).toBe('OLDUSDT')
    })

    it('applies changes and reports was and now', async () => {
      h.positions = [POSITION]
      h.review = { newStop: 98, newTake: 106, closeNow: false, reason: 'подтянул' }

      await h.engine.step(T0)

      expect(h.amended).toEqual([['p1', { stop: 98, take: 106 }]])
      expect(h.noted('edited')[0]).toMatchObject({
        changes: { stop: { was: 97, now: 98 }, take: { was: 104, now: 106 } },
        reason: 'подтянул',
      })
      expect(h.engine.stats()).toMatchObject({ stopMoves: 1, takeMoves: 1 })
    })

    it('reports only the changed field', async () => {
      h.positions = [POSITION]
      h.review = { newStop: null, newTake: 106, closeNow: false, reason: 'r' }

      await h.engine.step(T0)

      expect(h.amended).toEqual([['p1', { take: 106 }]])
      expect(h.noted('edited')[0].changes).toEqual({ take: { was: 104, now: 106 } })
    })

    it('no change: no amend and no message', async () => {
      h.positions = [POSITION]

      await h.engine.step(T0)

      expect(h.amended).toEqual([])
      expect(h.noted('edited')).toEqual([])
    })

    it('closeNow asks the broker to close', async () => {
      h.positions = [POSITION]
      h.review = { newStop: 98, newTake: null, closeNow: true, reason: 'r' }

      await h.engine.step(T0)

      expect(h.closes).toEqual([['p1', 'advisor']])
      expect(h.amended).toEqual([])
      expect(h.engine.stats().earlyCloses).toBe(1)
    })

    it('failure or a broken rule: stop and take unchanged, error', async () => {
      h.positions = [POSITION]
      h.review = { failed: true, message: 'API' }
      await h.engine.step(T0)
      expect(h.amended).toEqual([])
      expect(h.noted('error')).toHaveLength(1)

      h.review = { newStop: 50, newTake: null, closeNow: false, reason: 'r' }
      await h.engine.step(T0)
      expect(h.amended).toEqual([])
      expect(h.noted('error')).toHaveLength(2)
      expect(h.engine.stats().rejectedByRules).toBe(1)
    })
  })

  describe('risk halt', () => {
    it('cancels orders once, stops entries, still reviews, reports once', async () => {
      h.positions = [POSITION]
      h.orders = [h.placedOrder()]
      await h.engine.step(T0 - HOUR)
      h.entryRequests = []
      h.reviewRequests = []
      h.total = 5000

      await h.engine.step(T0)
      await h.engine.step(T0 + HOUR)

      expect(h.cancelled).toEqual([['o1', 'risk_halt']])
      expect(h.entryRequests).toEqual([])
      expect(h.reviewRequests).toHaveLength(2)
      expect(h.noted('error')).toHaveLength(1)
      expect(h.engine.stats().riskHaltAt).toBe(T0)
    })
  })

  describe('notifications', () => {
    const TRADE: ClosedTrade = {
      ...POSITION,
      exitPrice: 104,
      closedAt: T0,
      closeReason: 'take',
      pnl: 5,
      r: 2.5,
      fees: 0,
      slippageCost: 0,
      funding: 0,
    }

    it('sends opened on a fill and closed on a close, with a chart', async () => {
      h.situations = {}
      h.events = [
        { type: 'filled', position: POSITION },
        { type: 'closed', trade: TRADE },
      ]

      await h.engine.step(T0 + 5 * 60_000)

      expect(h.noted('opened')[0]).toMatchObject({ position: POSITION, chart: new Uint8Array([1]) })
      expect(h.noted('closed')[0]).toMatchObject({ trade: TRADE, chart: new Uint8Array([1]) })
    })

    it('placement and cancellation send nothing', async () => {
      h.events = [{ type: 'cancelled', order: h.placedOrder(), reason: 'expired' }]

      await h.engine.step(T0)

      expect(h.placed).toHaveLength(1)
      expect(h.noted('opened')).toEqual([])
    })

    it('a failed chart still sends the message', async () => {
      h.situations = {}
      h.chartFails = true
      h.events = [{ type: 'filled', position: POSITION }]

      await h.engine.step(T0 + 5 * 60_000)

      expect(h.noted('opened')[0].chart).toBeNull()
    })

    it('a notifier failure does not break the step', async () => {
      h.notifierFails = true
      h.events = [{ type: 'filled', position: POSITION }]

      await expect(h.engine.step(T0)).resolves.toBeUndefined()
      expect(h.placed).toHaveLength(1)
    })
  })
})
