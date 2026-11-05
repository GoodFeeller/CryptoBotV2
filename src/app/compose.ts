// [REVIEW i-code#39] Общая сборка для бэктеста и live: здесь один раз решается, какие реализации подставить, а отличия режимов
// передаются параметрами. Детектор зон подключается в createDetector, движок и симулятор при этом не меняются.
import { join } from 'node:path'
import type { ChartRenderer, Clock, MarketData, Notifier, SignalDetector, TradeAdvisor } from '../core/ports.js'
import { SimulatedBroker } from '../features/backtest/simulated-broker.js'
import { BybitMarketData, type BybitApi } from '../features/market-data/bybit-market-data.js'
import { CandleStore } from '../features/market-data/candle-store.js'
import { ClampedMarketData } from '../features/market-data/clamped-market-data.js'
import { DrawdownGate } from '../features/risk/drawdown-gate.js'
import { ZoneDetector } from '../features/signals/zone-detector.js'
import { TradingEngine, type EngineConfig } from '../features/trading/engine.js'
import type { AppConfig } from './config.js'
import { createMarketAnalysis } from './market-analysis.js'

/** Детектору нужен тот же MarketData, что и движку: в бэктесте он не отдаёт будущих свечей. */
export function createDetector(config: AppConfig, market: MarketData): SignalDetector {
  return new ZoneDetector({ market, analysis: createMarketAnalysis(config), options: config.signals.zone })
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
  detector: SignalDetector
}

/** Движок получает только данные, ограниченные часами. */
export function createTrading(
  config: AppConfig,
  deps: {
    raw: MarketData
    clock: Clock
    advisor: TradeAdvisor
    notifier: Notifier
    chart: ChartRenderer
    /** Подмена детектора: интеграционные тесты проверяют конвейер на заглушке. */
    makeDetector?: (market: MarketData) => SignalDetector
  },
): TradingParts {
  const market = new ClampedMarketData(deps.raw, deps.clock)
  const detector = deps.makeDetector ? deps.makeDetector(market) : createDetector(config, market)
  const broker = new SimulatedBroker({
    initialBalance: config.backtest.initialBalance,
    costs: config.costs,
    clock: deps.clock,
  })
  const engine = new TradingEngine({
    market,
    detector,
    advisor: deps.advisor,
    gate: new DrawdownGate({ maxDrawdownHaltPct: config.risk.maxDrawdownHaltPct }),
    broker,
    notifier: deps.notifier,
    chart: deps.chart,
    config: engineConfig(config),
  })
  return { broker, engine, market, detector }
}

export function dataPath(config: AppConfig, ...parts: string[]): string {
  return join(config.paths.data, ...parts)
}
