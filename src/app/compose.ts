// [REVIEW i-code#39] Общая сборка для бэктеста и live: здесь один раз решается, какие реализации подставить, а отличия режимов
// передаются параметрами. Настоящий детектор подключается в createDetector, движок и симулятор при этом не меняются.
import { join } from 'node:path'
import type { ChartRenderer, Clock, MarketData, Notifier, SignalDetector, TradeAdvisor } from '../core/ports.js'
import { SimulatedBroker } from '../features/backtest/simulated-broker.js'
import { BybitMarketData, type BybitApi } from '../features/market-data/bybit-market-data.js'
import { CandleStore } from '../features/market-data/candle-store.js'
import { ClampedMarketData } from '../features/market-data/clamped-market-data.js'
import { DrawdownGate } from '../features/risk/drawdown-gate.js'
import { EveryNCandlesDetector } from '../features/signals/every-n-candles.js'
import { TradingEngine, type EngineConfig } from '../features/trading/engine.js'
import type { AppConfig } from './config.js'

/** Заглушка сигналов срабатывает раз в столько сигнальных свечей. */
const PLACEHOLDER_EVERY_N_CANDLES = 4

export function createDetector(config: AppConfig): SignalDetector {
  return new EveryNCandlesDetector({ n: PLACEHOLDER_EVERY_N_CANDLES, timeframe: config.timeframes.signal })
}

export function createRawMarket(config: AppConfig, api: BybitApi, now: () => number): BybitMarketData {
  return new BybitMarketData({ api, store: new CandleStore(config.paths.data), now })
}

export function engineConfig(config: AppConfig): EngineConfig {
  return {
    symbols: config.symbols,
    executionTimeframe: config.timeframes.execution,
    signalTimeframe: config.timeframes.signal,
    windows: config.claude.windows,
    maxPositions: config.trading.maxPositions,
    limitOrderTtlHours: config.trading.limitOrderTtlHours,
    minStopPct: config.trading.minStopPct,
    costs: config.costs,
  }
}

export interface TradingParts {
  broker: SimulatedBroker
  engine: TradingEngine
  market: MarketData
}

/** Движок получает только данные, ограниченные часами. */
export function createTrading(
  config: AppConfig,
  deps: { raw: MarketData; clock: Clock; advisor: TradeAdvisor; notifier: Notifier; chart: ChartRenderer },
): TradingParts {
  const market = new ClampedMarketData(deps.raw, deps.clock)
  const broker = new SimulatedBroker({
    initialBalance: config.backtest.initialBalance,
    costs: config.costs,
    clock: deps.clock,
  })
  const engine = new TradingEngine({
    market,
    detector: createDetector(config),
    advisor: deps.advisor,
    gate: new DrawdownGate({ maxDrawdownHaltPct: config.risk.maxDrawdownHaltPct }),
    broker,
    notifier: deps.notifier,
    chart: deps.chart,
    config: engineConfig(config),
  })
  return { broker, engine, market }
}

export function dataPath(config: AppConfig, ...parts: string[]): string {
  return join(config.paths.data, ...parts)
}
