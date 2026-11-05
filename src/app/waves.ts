// Команда для проверки волн глазами: печатает обычный размер мелких и крупных волн и сколько прошла текущая, рисует оба зигзага.
// Пример: npm run waves -- BTCUSDT,ETHUSDT 2026-10-31T13:16Z. Без даты берётся текущий момент. В логике бота это пока не участвует.
import { mkdirSync, writeFileSync } from 'node:fs'
import type { Candle } from '../core/types.js'
import { renderLevelsPng, type ChartLine } from '../features/chart/levels-chart.js'
import { BybitClient } from '../features/market-data/bybit-client.js'
import { waveSnapshot, type WavePoint } from '../features/waves/waves.js'
import { createRawMarket, dataPath } from './compose.js'
import { loadConfig } from './config.js'

const DIRECTION = { up: 'вверх', down: 'вниз' }
const SCALES = { small: 'мелкие', big: 'крупные' } as const
const COLORS = { small: '#ffeb3b', big: '#ffffff', top: '#26a69a', middle: '#ff9800', bottom: '#ef5350' }
const CHART_CANDLES = 360

const config = loadConfig()
const symbols = process.argv[2] ? process.argv[2].split(',') : config.symbols
const at = process.argv[3] ? Date.parse(process.argv[3]) : Date.now()
if (Number.isNaN(at)) throw new Error(`Не понял дату: ${process.argv[3]}`)
const market = createRawMarket(config, new BybitClient(), () => at)
const { timeframes, historyCandles, swingAtr, ...rest } = config.waves
const dir = dataPath(config, 'waves')
mkdirSync(dir, { recursive: true })

console.log(`Момент: ${new Date(at).toISOString()}`)
for (const symbol of symbols) {
  for (const tf of timeframes) {
    const closed = (await market.candles(symbol, tf, at, historyCandles)).filter((candle) => candle.closeTime <= at)
    const shown = closed.slice(-CHART_CANDLES)
    const lines: ChartLine[] = []
    const titleParts: string[] = []
    console.log(`\n${symbol} ${tf}: закрытие ${closed.at(-1)?.close}`)

    for (const scale of ['small', 'big'] as const) {
      const snapshot = waveSnapshot(closed, at, { ...rest, swingAtr: swingAtr[scale] })
      if (!snapshot.ok) {
        console.log(`  ${SCALES[scale]}: мало волн, вверх ${snapshot.up}, вниз ${snapshot.down}, нужно по ${snapshot.needed}`)
        continue
      }
      const { average, averageAtr, current, lastWave } = snapshot
      const percent = Math.round(current.share * 100)
      console.log(`  ${SCALES[scale]} (разворот ${swingAtr[scale]} ATR): обычная волна вверх ${price(average.up)} (${averageAtr.up.toFixed(1)} ATR), вниз ${price(average.down)} (${averageAtr.down.toFixed(1)} ATR)`)
      console.log(`    текущая ${DIRECTION[current.direction]} от ${price(current.start.price)}: прошла ${price(current.length)} (${current.lengthAtr.toFixed(1)} ATR), это ${percent}% обычной`)
      console.log(`    последняя волна ${DIRECTION[lastWave.direction]}: верх ${price(lastWave.top)}, середина ${price(lastWave.middle)}, низ ${price(lastWave.bottom)}`)

      const points = [snapshot.waves[0]!.from, ...snapshot.waves.map((wave) => wave.to), current.extreme]
      lines.push({ label: `${SCALES[scale]} волны`, color: COLORS[scale], values: zigzag(shown, points) })
      titleParts.push(`${SCALES[scale]} ↑${price(average.up)} ↓${price(average.down)}, текущая ${DIRECTION[current.direction]} ${percent}%`)
      // Верх, середину и низ рисуем только для крупной волны, как в видео: так картинка не перегружена.
      if (scale === 'big') {
        const since = snapshot.waves.at(-1)!.from.time
        const flat = (value: number) => shown.map((candle) => (candle.openTime >= since ? value : undefined))
        lines.push(
          { label: 'верх волны', color: COLORS.top, values: flat(lastWave.top) },
          { label: 'середина', color: COLORS.middle, values: flat(lastWave.middle) },
          { label: 'низ волны', color: COLORS.bottom, values: flat(lastWave.bottom) },
        )
      }
    }
    const title = `${symbol} · ${tf} · ${titleParts.join(' · ')}`
    writeFileSync(`${dir}/${symbol}_${tf}.png`, renderLevelsPng({ title, candles: shown, levels: [], lines }))
  }
}
console.log(`\nКартинки: ${dir}`)

/** Ломаная через развороты: значения по свечам, между разворотами по прямой. Развороты левее картинки тянут линию от края. */
function zigzag(candles: Candle[], points: WavePoint[]): (number | undefined)[] {
  const values: (number | undefined)[] = candles.map(() => undefined)
  const first = candles[0]?.openTime ?? 0
  const position = (time: number) => (time < first ? -1 - candles.length : candles.findIndex((candle) => candle.openTime === time))
  for (let k = 1; k < points.length; k++) {
    const from = position(points[k - 1]!.time)
    const to = position(points[k]!.time)
    if (to < 0) continue
    const start = from < 0 ? indexBefore(points[k - 1]!.time, candles) : from
    for (let i = Math.max(start, 0); i <= to; i++) {
      values[i] = points[k - 1]!.price + ((points[k]!.price - points[k - 1]!.price) * (i - start)) / Math.max(to - start, 1)
    }
  }
  return values
}

/** Положение свечи левее картинки в индексах картинки: отрицательное число. */
function indexBefore(time: number, candles: Candle[]): number {
  const step = candles.length > 1 ? candles[1]!.openTime - candles[0]!.openTime : 1
  return Math.round((time - candles[0]!.openTime) / step)
}

function price(value: number): number {
  return Number(value.toPrecision(5))
}
