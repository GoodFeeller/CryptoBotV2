// [REVIEW i-code#38] Цикл бэктеста: подаёт брокеру свечи по одной и передвигает часы. История загружается один раз заранее, потому что
// чтение на каждом шаге заняло бы часы; будущее при этом недоступно движку: он получает только ClampedMarketData, а брокер
// видит ровно текущую свечу. Порядок внутри шага: часы → фандинг → свеча → движок → снимок капитала.
import type { Clock, MarketData } from '../core/ports.js'
import { timeframeMs } from '../core/timeframes.js'
import type { Candle, FundingRate, Timeframe } from '../core/types.js'
import type { EquityPoint } from '../features/backtest/report.js'
import type { SimulatedBroker } from '../features/backtest/simulated-broker.js'
import type { TradingEngine } from '../features/trading/engine.js'

export class ManualClock implements Clock {
  constructor(private time: number) {}

  now(): number {
    return this.time
  }

  set(time: number): void {
    this.time = time
  }
}

export interface SimulationOptions<Stop extends string> {
  from: number
  to: number
  symbols: string[]
  executionTimeframe: Timeframe
  market: MarketData
  clock: ManualClock
  broker: SimulatedBroker
  engine: TradingEngine
  /** Проверяется после каждого шага: причина остановки или null. */
  shouldStop: () => Stop | null
}

export interface SimulationResult<Stop extends string> {
  stoppedBy: Stop | null
  equity: EquityPoint[]
}

export async function simulate<Stop extends string>(options: SimulationOptions<Stop>): Promise<SimulationResult<Stop>> {
  const { from, to, symbols, executionTimeframe, clock, broker, engine, shouldStop } = options
  const step = timeframeMs(executionTimeframe)
  const history = await Promise.all(symbols.map((symbol) => loadHistory(symbol, options)))
  const equity: EquityPoint[] = [{ time: from, total: (await broker.equity()).total }]

  for (let time = from + step; time <= to; time += step) {
    clock.set(time)
    for (const { symbol, candles, funding } of history) {
      for (let rate = funding[0]; rate && rate.time <= time; rate = funding[0]) {
        broker.feedFunding(symbol, rate)
        funding.shift()
      }
      const candle = candles.get(time)
      if (candle) broker.feed(symbol, candle)
    }
    await engine.step(time)
    equity.push({ time, total: (await broker.equity()).total })

    const stoppedBy = shouldStop()
    if (stoppedBy) return { stoppedBy, equity }
  }

  broker.closeAll('end_of_run')
  equity.push({ time: to, total: (await broker.equity()).total })
  return { stoppedBy: null, equity }
}

async function loadHistory<Stop extends string>(
  symbol: string,
  options: SimulationOptions<Stop>,
): Promise<{ symbol: string; candles: Map<number, Candle>; funding: FundingRate[] }> {
  const { from, to, executionTimeframe, market } = options
  const count = Math.ceil((to - from) / timeframeMs(executionTimeframe))
  const candles = await market.candles(symbol, executionTimeframe, to, count)
  const funding = await market.fundingRates(symbol, from, to)
  return { symbol, candles: new Map(candles.map((candle) => [candle.closeTime, candle])), funding: [...funding] }
}
