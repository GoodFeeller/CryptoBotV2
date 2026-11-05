// [REVIEW i-code#44] Команда для проверки уровней глазами: две картинки на монету. На дневке только основные уровни, на часовике
// основные вместе с локальными. В логике бота это пока не участвует.
import { mkdirSync, writeFileSync } from 'node:fs'
import { renderLevelsPng } from '../features/chart/levels-chart.js'
import { lastAtr } from '../core/atr.js'
import { combineLevels, findLevels, LOCAL_LEVELS, MAJOR_LEVELS } from '../features/levels/find-levels.js'
import { BybitClient } from '../features/market-data/bybit-client.js'
import { createRawMarket, dataPath } from './compose.js'
import { loadConfig } from './config.js'

const MAJOR_CANDLES = 365
const LOCAL_CANDLES = 720
const LOCAL_CHART_CANDLES = 360
const SAME_LEVEL_ATR = 0.5

const config = loadConfig()
const symbols = process.argv[2] ? process.argv[2].split(',') : config.symbols
// Необязательная дата вторым аргументом рисует уровни так, как они выглядели в тот момент.
const now = process.argv[3] ? Date.parse(process.argv[3]) : Date.now()
if (Number.isNaN(now)) throw new Error(`Не понял дату: ${process.argv[3]}`)
const market = createRawMarket(config, new BybitClient(), () => now)
const dir = dataPath(config, 'levels')
mkdirSync(dir, { recursive: true })

for (const symbol of symbols) {
  const daily = await market.candles(symbol, '1d', now, MAJOR_CANDLES)
  const hourly = await market.candles(symbol, '1h', now, LOCAL_CANDLES)
  const major = findLevels(daily, MAJOR_LEVELS)
  const local = findLevels(hourly, LOCAL_LEVELS)
  const tolerance = SAME_LEVEL_ATR * lastAtr(daily, MAJOR_LEVELS.atrPeriod)
  const combined = combineLevels(major, local, tolerance)
  // Дневные проторговки на часовике выглядят огромными прямоугольниками, поэтому там их нет.
  const hourlyLevels = combined.map((level) => (level.class === 'major' ? { ...level, zones: [] } : level))

  writeFileSync(`${dir}/${symbol}_1d.png`, renderLevelsPng({ title: `${symbol} · 1d · основные`, candles: daily, levels: major }))
  writeFileSync(
    `${dir}/${symbol}_1h.png`,
    renderLevelsPng({ title: `${symbol} · 1h · основные и локальные`, candles: hourly.slice(-LOCAL_CHART_CANDLES), levels: hourlyLevels }),
  )

  console.log(`\n${symbol}: цена ${daily.at(-1)?.close}, дневных свечей ${daily.length}`)
  for (const level of combined) {
    console.log(
      `  ${level.class === 'major' ? 'основной ' : 'локальный'} ${level.price}  ${{ active: '', traded: 'ПРОТОРГОВАН ', broken: 'ПРОБИТ ' }[level.status]}отскоков ${level.bounces}, ложных ${level.falseBreaks}, зерк. ${level.flips}, сила ${level.strength}, ${level.origins.join('+')}`,
    )
  }
}
console.log(`\nКартинки: ${dir}`)
