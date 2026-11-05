// Команда для проверки волн глазами: печатает обычный размер волн и сколько прошла текущая, рисует зигзаг по разворотам.
// Пример: npm run waves -- BTCUSDT,ETHUSDT 2026-10-31T13:16Z. Без даты берётся текущий момент. В логике бота это пока не участвует.
import { mkdirSync, writeFileSync } from 'node:fs'
import type { Candle } from '../core/types.js'
import { renderLevelsPng, type ChartLine } from '../features/chart/levels-chart.js'
import { BybitClient } from '../features/market-data/bybit-client.js'
import { waveSnapshot, type WavePoint } from '../features/waves/waves.js'
import { createRawMarket, dataPath } from './compose.js'
import { loadConfig } from './config.js'

const DIRECTION = { up: 'вверх', down: 'вниз' }
const COLORS = { zigzag: '#ffeb3b', top: '#26a69a', middle: '#ff9800', bottom: '#ef5350' }

const config = loadConfig()
const symbols = process.argv[2] ? process.argv[2].split(',') : config.symbols
const at = process.argv[3] ? Date.parse(process.argv[3]) : Date.now()
if (Number.isNaN(at)) throw new Error(`Не понял дату: ${process.argv[3]}`)
const market = createRawMarket(config, new BybitClient(), () => at)
const { timeframes, historyCandles, ...options } = config.waves
const dir = dataPath(config, 'waves')
mkdirSync(dir, { recursive: true })

console.log(`Момент: ${new Date(at).toISOString()}`)
for (const symbol of symbols) {
  for (const tf of timeframes) {
    const candles = await market.candles(symbol, tf, at, historyCandles)
    const snapshot = waveSnapshot(candles, at, options)
    if (!snapshot.ok) {
      console.log(`\n${symbol} ${tf}: мало волн, вверх ${snapshot.up}, вниз ${snapshot.down}, нужно по ${snapshot.needed}`)
      continue
    }
    const { average, averageAtr, current, lastWave } = snapshot
    const percent = Math.round(current.share * 100)
    console.log(`\n${symbol} ${tf}: закрытие ${snapshot.close}, ATR ${price(snapshot.atr)}`)
    console.log(`  обычная волна вверх ${price(average.up)} (${averageAtr.up.toFixed(1)} ATR), вниз ${price(average.down)} (${averageAtr.down.toFixed(1)} ATR)`)
    console.log(`  текущая волна ${DIRECTION[current.direction]} от ${price(current.start.price)}: прошла ${price(current.length)} (${current.lengthAtr.toFixed(1)} ATR), это ${percent}% обычной`)
    console.log(`  последняя волна ${DIRECTION[lastWave.direction]}: верх ${price(lastWave.top)}, середина ${price(lastWave.middle)}, низ ${price(lastWave.bottom)}`)

    const closed = candles.filter((candle) => candle.closeTime <= at)
    const points = [snapshot.waves[0]!.from, ...snapshot.waves.map((wave) => wave.to), current.extreme]
    const since = snapshot.waves.at(-1)!.from.time
    const flat = (value: number) => closed.map((candle) => (candle.openTime >= since ? value : undefined))
    const lines: ChartLine[] = [
      { label: 'волны', color: COLORS.zigzag, values: zigzag(closed, points) },
      { label: 'верх волны', color: COLORS.top, values: flat(lastWave.top) },
      { label: 'середина', color: COLORS.middle, values: flat(lastWave.middle) },
      { label: 'низ волны', color: COLORS.bottom, values: flat(lastWave.bottom) },
    ]
    const title = `${symbol} · ${tf} · обычная волна ↑${price(average.up)} ↓${price(average.down)} · текущая ${DIRECTION[current.direction]} ${percent}%`
    writeFileSync(`${dir}/${symbol}_${tf}.png`, renderLevelsPng({ title, candles: closed, levels: [], lines }))
  }
}
console.log(`\nКартинки: ${dir}`)

/** Ломаная через развороты: значения по свечам, между разворотами по прямой. */
function zigzag(candles: Candle[], points: WavePoint[]): (number | undefined)[] {
  const values: (number | undefined)[] = candles.map(() => undefined)
  const indexOf = (time: number) => candles.findIndex((candle) => candle.openTime === time)
  for (let k = 1; k < points.length; k++) {
    const from = indexOf(points[k - 1]!.time)
    const to = indexOf(points[k]!.time)
    for (let i = from; i <= to; i++) {
      values[i] = points[k - 1]!.price + ((points[k]!.price - points[k - 1]!.price) * (i - from)) / Math.max(to - from, 1)
    }
  }
  return values
}

function price(value: number): number {
  return Number(value.toPrecision(5))
}
