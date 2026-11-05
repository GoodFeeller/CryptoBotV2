// Собирает модули анализа в MarketAnalysis для детектора: здесь, а не в фичах, потому что фичи не знают друг о друге.
// Настройки модулей берутся из конфига, детектор о них не знает.
import { lastAtr } from '../core/atr.js'
import type { MarketAnalysis } from '../core/ports.js'
import { emaSnapshot } from '../features/ema/ema.js'
import { combineLevels, findLevels, LOCAL_LEVELS, MAJOR_LEVELS } from '../features/levels/find-levels.js'
import { structureSnapshot } from '../features/structure/structure.js'
import { waveSnapshot } from '../features/waves/waves.js'
import type { AppConfig } from './config.js'

/** Локальный уровень ближе этого к основному не показывается, как в npm run levels. */
const SAME_LEVEL_ATR = 0.5

export function createMarketAnalysis(config: AppConfig): MarketAnalysis {
  const { swingAtr, historyCandles: _waveHistory, timeframes: _waveTimeframes, ...waveOptions } = config.waves
  const { timeframe: _structureTimeframe, historyCandles: _structureHistory, ...structureOptions } = config.structure
  const emaOptions = { periods: config.ema.periods, slopeBars: config.ema.slopeBars, atrPeriod: config.ema.atrPeriod, warmupFactor: config.ema.warmupFactor }

  return {
    levels: (daily, hourly) => {
      const major = findLevels(daily, MAJOR_LEVELS)
      const local = findLevels(hourly, LOCAL_LEVELS)
      return combineLevels(major, local, SAME_LEVEL_ATR * lastAtr(daily, MAJOR_LEVELS.atrPeriod))
    },
    ema: (candles, at) => emaSnapshot(candles, at, emaOptions),
    waves: (candles, at, scale) => waveSnapshot(candles, at, { ...waveOptions, swingAtr: swingAtr[scale] }),
    structure: (candles, at) => structureSnapshot(candles, at, structureOptions),
  }
}
