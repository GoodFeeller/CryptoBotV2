// Команда для сверки EMA глазами: печатает положение EMA на момент времени и рисует картинки, чтобы сравнить с графиком биржи.
// Пример: npm run ema -- BTCUSDT,ETHUSDT 2026-10-31T13:16Z. Без даты берётся текущий момент. В логике бота это пока не участвует.
import { mkdirSync, writeFileSync } from 'node:fs'
import { renderLevelsPng } from '../features/chart/levels-chart.js'
import { computeEma, emaSnapshot } from '../features/ema/ema.js'
import { BybitClient } from '../features/market-data/bybit-client.js'
import { createRawMarket, dataPath } from './compose.js'
import { loadConfig } from './config.js'

const CHART_CANDLES = 300
const COLORS = ['#ffeb3b', '#4fc3f7', '#e040fb', '#ffffff']
const SIDE = { above: 'цена выше', below: 'цена ниже' }
const SLOPE = { up: 'растёт', down: 'падает', flat: 'ровно' }
const STACK = { up: 'вверх', down: 'вниз', mixed: 'смешанно' }

const config = loadConfig()
const symbols = process.argv[2] ? process.argv[2].split(',') : config.symbols
const at = process.argv[3] ? Date.parse(process.argv[3]) : Date.now()
if (Number.isNaN(at)) throw new Error(`Не понял дату: ${process.argv[3]}`)
const market = createRawMarket(config, new BybitClient(), () => at)
const options = { periods: config.ema.periods, slopeBars: config.ema.slopeBars, atrPeriod: config.ema.atrPeriod, warmupFactor: config.ema.warmupFactor }
const history = Math.ceil(options.warmupFactor * Math.max(...options.periods))
const dir = dataPath(config, 'ema')
mkdirSync(dir, { recursive: true })

console.log(`Момент: ${new Date(at).toISOString()}`)
for (const symbol of symbols) {
  for (const tf of config.ema.timeframes) {
    const candles = await market.candles(symbol, tf, at, history)
    const snapshot = emaSnapshot(candles, at, options)
    if (!snapshot.ok) {
      console.log(`\n${symbol} ${tf}: мало истории, нужно ${snapshot.needed} свечей, есть ${snapshot.got}`)
      continue
    }
    console.log(`\n${symbol} ${tf}: закрытие ${snapshot.close}, расположение EMA: ${STACK[snapshot.stack]}`)
    for (const ema of snapshot.emas) {
      const value = Number(ema.value.toPrecision(6))
      console.log(`  EMA ${String(ema.period).padEnd(3)} ${value}  ${SIDE[ema.priceSide]} на ${ema.distanceAtr.toFixed(2)} ATR, ${SLOPE[ema.slope]}`)
    }

    // EMA считается по всей истории, а рисуются только последние свечи: так линии с первой свечи картинки уже точные.
    const closes = candles.map((candle) => candle.close)
    const shown = candles.length - Math.min(CHART_CANDLES, candles.length)
    const lines = options.periods.map((period, i) => ({
      label: `EMA ${period}`,
      color: COLORS[i % COLORS.length]!,
      values: computeEma(closes, period).slice(shown),
    }))
    const title = `${symbol} · ${tf} · EMA ${STACK[snapshot.stack]} · ${new Date(at).toISOString().slice(0, 16)}`
    writeFileSync(`${dir}/${symbol}_${tf}.png`, renderLevelsPng({ title, candles: candles.slice(shown), levels: [], lines }))
  }
}
console.log(`\nКартинки: ${dir}`)
