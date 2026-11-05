// Команда для проверки структуры глазами: печатает тренд старшего таймфрейма и рисует крупный зигзаг с двумя последними
// максимумами и минимумами. Пример: npm run structure -- BTCUSDT,ETHUSDT 2026-10-31T13:16Z. В логике бота это пока не участвует.
import { mkdirSync, writeFileSync } from 'node:fs'
import { computeAtr } from '../core/atr.js'
import { findPivots } from '../core/pivots.js'
import { renderLevelsPng, type ChartLine } from '../features/chart/levels-chart.js'
import { zigzagValues } from '../features/chart/zigzag.js'
import { BybitClient } from '../features/market-data/bybit-client.js'
import type { StructurePoint } from '../core/types.js'
import { structureSnapshot } from '../features/structure/structure.js'
import { createRawMarket, dataPath } from './compose.js'
import { loadConfig } from './config.js'

const TREND = { up: 'тренд вверх', down: 'тренд вниз', flat: 'флэт' }
const AFTER = { up: ' после тренда вверх', down: ' после тренда вниз' }
const BEYOND = { above_high: 'цена выше последнего максимума', below_low: 'цена ниже последнего минимума' }
const COLORS = { zigzag: '#ffffff', high: '#26a69a', low: '#ef5350' }
const CHART_CANDLES = 360

const config = loadConfig()
const symbols = process.argv[2] ? process.argv[2].split(',') : config.symbols
const at = process.argv[3] ? Date.parse(process.argv[3]) : Date.now()
if (Number.isNaN(at)) throw new Error(`Не понял дату: ${process.argv[3]}`)
const market = createRawMarket(config, new BybitClient(), () => at)
const { timeframe, historyCandles, ...options } = config.structure
const dir = dataPath(config, 'structure')
mkdirSync(dir, { recursive: true })

console.log(`Момент: ${new Date(at).toISOString()}, таймфрейм ${timeframe}, разворот ${options.swingAtr} ATR`)
for (const symbol of symbols) {
  const closed = (await market.candles(symbol, timeframe, at, historyCandles)).filter((candle) => candle.closeTime <= at)
  const snapshot = structureSnapshot(closed, at, options)
  if (!snapshot.ok) {
    console.log(`\n${symbol}: мало разворотов, максимумов ${snapshot.highs}, минимумов ${snapshot.lows}, нужно по ${snapshot.needed}`)
    continue
  }
  const summary = `${TREND[snapshot.trend]}${snapshot.previousTrend ? AFTER[snapshot.previousTrend] : ''}${snapshot.beyond ? `, ${BEYOND[snapshot.beyond]}` : ''}`
  console.log(`\n${symbol}: закрытие ${snapshot.close}, ${summary}`)
  console.log(`  максимумы ${price(snapshot.highs[0].price)} → ${price(snapshot.highs[1].price)}, минимумы ${price(snapshot.lows[0].price)} → ${price(snapshot.lows[1].price)}`)

  const shown = closed.slice(-CHART_CANDLES)
  const pivots = findPivots(closed, computeAtr(closed, options.atrPeriod), options.swingAtr)
  // Последний отрезок ведём до закрытия последней свечи: текущее движение ещё не стало разворотом.
  const points = [...pivots.map((pivot) => ({ time: closed[pivot.index]!.openTime, price: pivot.price })), { time: closed.at(-1)!.openTime, price: snapshot.close }]
  const from = (point: StructurePoint) => shown.map((candle) => (candle.openTime >= point.time ? point.price : undefined))
  const lines: ChartLine[] = [
    { label: 'крупные волны', color: COLORS.zigzag, values: zigzagValues(shown, points) },
    { label: 'макс 1', color: COLORS.high, values: from(snapshot.highs[0]) },
    { label: 'макс 2', color: COLORS.high, values: from(snapshot.highs[1]) },
    { label: 'мин 1', color: COLORS.low, values: from(snapshot.lows[0]) },
    { label: 'мин 2', color: COLORS.low, values: from(snapshot.lows[1]) },
  ]
  writeFileSync(`${dir}/${symbol}_${timeframe}.png`, renderLevelsPng({ title: `${symbol} · ${timeframe} · ${summary}`, candles: shown, levels: [], lines }))
}
console.log(`\nКартинки: ${dir}`)

function price(value: number): number {
  return Number(value.toPrecision(5))
}
