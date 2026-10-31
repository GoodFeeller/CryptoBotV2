import { beforeEach, describe, expect, it } from 'vitest'
import type { Candle, ClosedTrade, LimitOrder, Position, Side, TradingCosts } from '../../../src/core/types.js'
import { SimulatedBroker } from '../../../src/features/backtest/simulated-broker.js'

const STEP = 300_000
const T0 = Date.UTC(2026, 0, 1)
const COSTS: TradingCosts = {
  takerPct: 0.055,
  makerPct: 0.02,
  slippagePct: 0.05,
  limitFillThroughPct: 0.02,
  maintenanceMarginPct: 0.5,
}

function order(side: Side, extra: Partial<LimitOrder> = {}): LimitOrder {
  const long = side === 'long'
  return {
    symbol: 'BTCUSDT',
    side,
    kind: 'test',
    price: 100,
    qty: 10,
    leverage: 5,
    stop: long ? 95 : 105,
    take: long ? 110 : 90,
    expiresAt: T0 + 100 * STEP,
    reason: 'because',
    ...extra,
  }
}

describe('SimulatedBroker', () => {
  let now: number
  let index: number
  let broker: SimulatedBroker

  /** Подаёт следующую свечу: [open, high, low, close]. */
  function feed(open: number, high: number, low: number, close: number): void {
    const openTime = T0 + index * STEP
    index++
    now = openTime + STEP
    const candle: Candle = { openTime, closeTime: now, open, high, low, close, volume: 1, turnover: 1 }
    broker.feed('BTCUSDT', candle)
  }

  async function closed(): Promise<ClosedTrade> {
    const event = (await broker.poll()).find((e) => e.type === 'closed')
    if (event?.type !== 'closed') throw new Error('сделка не закрыта')
    return event.trade
  }

  async function position(): Promise<Position> {
    const [found] = await broker.openPositions()
    if (!found) throw new Error('нет позиции')
    return found
  }

  /** Открывает лонг или шорт от 100 и очищает события. */
  async function open(side: Side, extra: Partial<LimitOrder> = {}): Promise<void> {
    await broker.placeLimit(order(side, extra))
    if (side === 'long') feed(100.5, 100.5, 99.9, 100)
    else feed(99.5, 100.1, 99.5, 100)
    await broker.poll()
  }

  beforeEach(() => {
    now = T0
    index = 0
    broker = new SimulatedBroker({ initialBalance: 10_000, costs: COSTS, clock: { now: () => now } })
  })

  describe('limit entry', () => {
    it('does not fill on a plain touch', async () => {
      await broker.placeLimit(order('long'))
      feed(101, 101, 100, 100.5)

      expect(await broker.openPositions()).toEqual([])
    })

    it('fills when price passes the order by limitFillThroughPct, with maker fee', async () => {
      await broker.placeLimit(order('long'))
      feed(101, 101, 99.97, 100.5)

      const events = await broker.poll()
      expect(events[0]?.type).toBe('filled')
      expect((await position()).entryPrice).toBe(100)
      expect((await broker.equity()).unrealized).toBeCloseTo(5 - 0.2, 6) // (100.5−100)×10 − maker 0.02% от 1000
    })

    it('fills a short mirrored', async () => {
      await broker.placeLimit(order('short'))
      feed(99, 100.03, 99, 99.5)

      expect((await position()).side).toBe('short')
    })

    it('rejects a post-only order crossing on its first candle', async () => {
      await broker.placeLimit(order('long'))
      feed(99.9, 101, 99.8, 100)

      expect(await broker.poll()).toMatchObject([{ type: 'cancelled', reason: 'post_only' }])
    })

    it('fills a resting order at its price when a later candle gaps through', async () => {
      await broker.placeLimit(order('long'))
      feed(101, 101, 100.5, 100.5)
      feed(98, 99, 97.5, 98.5)

      expect((await position()).entryPrice).toBe(100)
    })

    it('cancels an expired order', async () => {
      await broker.placeLimit(order('long', { expiresAt: T0 + STEP }))
      feed(101, 101, 100.5, 100.5)
      feed(100.5, 100.5, 99, 99.5)

      expect(await broker.poll()).toMatchObject([{ type: 'cancelled', reason: 'expired' }])
      expect(await broker.openPositions()).toEqual([])
    })

    it('cancels when price reached the take before entry', async () => {
      await broker.placeLimit(order('long'))
      feed(101, 110, 100.5, 105)

      expect(await broker.poll()).toMatchObject([{ type: 'cancelled', reason: 'take_reached' }])
    })

    it('treats touching both the order and its take as filled', async () => {
      await broker.placeLimit(order('long'))
      feed(105, 110, 99.9, 105)

      expect((await broker.poll())[0]?.type).toBe('filled')
    })

    it('fill and stop in the same candle: filled and closed by stop', async () => {
      await broker.placeLimit(order('long'))
      feed(101, 101, 94, 96)

      const events = await broker.poll()
      expect(events.map((e) => e.type)).toEqual(['filled', 'closed'])
      expect(events[1]).toMatchObject({ trade: { closeReason: 'stop', entryPrice: 100 } })
    })

    it('fill and take in the same candle: take is not counted', async () => {
      await broker.placeLimit(order('long', { take: 105 }))
      feed(100.5, 106, 99.9, 104)
      expect(await broker.openPositions()).toHaveLength(1)

      await broker.poll()
      feed(104, 106, 104, 105)
      expect(await closed()).toMatchObject({ closeReason: 'take', exitPrice: 105 })
    })
  })

  describe('exits', () => {
    it('stop and take in the same candle: stop', async () => {
      await open('long')
      feed(100, 111, 94, 100)

      expect(await closed()).toMatchObject({ closeReason: 'stop' })
    })

    it('stop fills with slippage and taker fee', async () => {
      await open('long')
      feed(100, 100, 94, 96)

      const trade = await closed()
      const exit = 95 * (1 - 0.0005)
      expect(trade.exitPrice).toBeCloseTo(exit, 6)
      const fees = 1000 * 0.0002 + exit * 10 * 0.00055
      expect(trade.fees).toBeCloseTo(fees, 6)
      expect(trade.pnl).toBeCloseTo((exit - 100) * 10 - fees, 6)
      expect(trade.r).toBeCloseTo(trade.pnl / 50, 6)
      expect(trade.slippageCost).toBeCloseTo((95 - exit) * 10, 6)
    })

    it('stop gap fills at the open when it is worse', async () => {
      await open('long')
      feed(90, 91, 89, 90)

      expect((await closed()).exitPrice).toBeCloseTo(90 * (1 - 0.0005), 6)
    })

    it('take fills at its price with maker fee and no slippage; a gap does not improve it', async () => {
      await open('long')
      feed(120, 121, 119, 120)

      const trade = await closed()
      expect(trade).toMatchObject({ closeReason: 'take', exitPrice: 110, slippageCost: 0 })
      expect(trade.fees).toBeCloseTo(1000 * 0.0002 + 1100 * 0.0002, 6)
    })

    it('short exits mirrored', async () => {
      await open('short')
      feed(100, 106, 99, 104)
      const stopped = await closed()
      expect(stopped.exitPrice).toBeCloseTo(105 * 1.0005, 6)
      expect(stopped.pnl).toBeLessThan(0)

      await open('short')
      feed(100, 100, 89, 95)
      const taken = await closed()
      expect(taken).toMatchObject({ closeReason: 'take', exitPrice: 90 })
      expect(taken.pnl).toBeGreaterThan(0)
    })

    it('amend takes effect on the next candle and R stays based on the initial stop', async () => {
      await open('long')
      await broker.amend((await position()).id, { stop: 98 })
      feed(100, 100, 97, 98)

      const trade = await closed()
      expect(trade.closeReason).toBe('stop')
      expect(trade.initialStop).toBe(95)
      expect(trade.stop).toBe(98)
      expect(trade.r).toBeCloseTo(trade.pnl / 50, 6)
    })

    it('close is queued and fills on the next open with slippage and taker fee', async () => {
      await open('long')
      await broker.close((await position()).id, 'advisor')
      expect(await broker.poll()).toEqual([])

      feed(102, 103, 101, 102)

      const trade = await closed()
      expect(trade).toMatchObject({ closeReason: 'advisor' })
      expect(trade.exitPrice).toBeCloseTo(102 * (1 - 0.0005), 6)
    })

    it('closeAll closes positions and cancels orders', async () => {
      await open('long')
      await broker.placeLimit(order('long', { symbol: 'ETHUSDT' }))

      broker.closeAll('end_of_run')

      const events = await broker.poll()
      expect(events.map((e) => e.type).sort()).toEqual(['cancelled', 'closed'])
      expect(events.find((e) => e.type === 'closed')).toMatchObject({ trade: { closeReason: 'end_of_run' } })
      expect(await broker.openPositions()).toEqual([])
      expect(await broker.pendingOrders()).toEqual([])
    })
  })

  describe('funding', () => {
    it('long pays a positive rate, short receives it', async () => {
      await open('long')
      broker.feedFunding('BTCUSDT', { time: now, rate: 0.001 })
      await broker.close((await position()).id, 'advisor')
      feed(100, 100, 100, 100)
      expect((await closed()).funding).toBeCloseTo(1, 6)

      await open('short')
      broker.feedFunding('BTCUSDT', { time: now, rate: 0.001 })
      await broker.close((await position()).id, 'advisor')
      feed(100, 100, 100, 100)
      const trade = await closed()
      expect(trade.funding).toBeCloseTo(-1, 6)
      expect(trade.pnl).toBeGreaterThan(-1)
    })

    it('funding of another coin is ignored', async () => {
      await open('long')
      broker.feedFunding('ETHUSDT', { time: now, rate: 0.5 })
      await broker.close((await position()).id, 'advisor')
      feed(100, 100, 100, 100)

      expect((await closed()).funding).toBe(0)
    })
  })

  describe('equity', () => {
    it('total includes unrealized, balance only closed trades, margin counts orders and positions', async () => {
      await open('long')
      await broker.placeLimit(order('long', { symbol: 'ETHUSDT', qty: 10, price: 100, leverage: 2 }))
      feed(100, 102, 100, 102)

      const equity = await broker.equity()
      expect(equity.balance).toBe(10_000)
      expect(equity.unrealized).toBeCloseTo(20 - 0.2, 6)
      expect(equity.total).toBeCloseTo(10_019.8, 6)
      expect(equity.usedMargin).toBeCloseTo(200 + 500, 6)
    })

    it('balance changes after a close', async () => {
      await open('long')
      feed(100, 100, 94, 96)
      const trade = await closed()

      expect((await broker.equity()).balance).toBeCloseTo(10_000 + trade.pnl, 6)
    })

    it('keeps order history and closed trades', async () => {
      await open('long')
      feed(100, 100, 94, 96)
      await broker.placeLimit(order('long'))
      feed(99, 101, 98, 100)

      expect(broker.closedTrades()).toHaveLength(1)
      expect(broker.orderHistory().map((r) => r.outcome)).toEqual(['filled', 'post_only'])
      expect(broker.orderHistory()[0]?.firstCandleOpen).toBe(100.5)
    })
  })

  it('throws on an unknown id', async () => {
    await expect(broker.amend('nope', { stop: 1 })).rejects.toThrow(/nope/)
    await expect(broker.close('nope', 'advisor')).rejects.toThrow(/nope/)
  })
})
