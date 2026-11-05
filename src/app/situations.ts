// Прогон детектора зон по истории без Claude: час за часом, как бэктест, с тем же MarketData без будущих свечей.
// Показывает, где детектор позвал бы Claude и сколько таких ситуаций в месяц, чтобы оценить нагрузку на сессии и проверить места глазами.
// Пример: npm run situations -- BTCUSDT,ETHUSDT 2026-10-01 2026-11-01
import { mkdirSync, writeFileSync } from 'node:fs'
import { timeframeMs } from '../core/timeframes.js'
import type { Situation } from '../core/types.js'
import { renderLevelsPng } from '../features/chart/levels-chart.js'
import { ClampedMarketData } from '../features/market-data/clamped-market-data.js'
import { BybitClient } from '../features/market-data/bybit-client.js'
import { createDetector, createRawMarket, dataPath } from './compose.js'
import { loadConfig } from './config.js'
import { ManualClock } from './run-loop.js'

const HOUR = timeframeMs('1h')
const PART = { top: 'верх волны', middle: 'середина волны', bottom: 'низ волны' }
const TREND = { up: 'тренд вверх', down: 'тренд вниз', flat: 'флэт' }

const [symbolsArg, fromArg, toArg] = process.argv.slice(2)
if (!symbolsArg || !fromArg || !toArg) throw new Error('Пример: npm run situations -- BTCUSDT,ETHUSDT 2026-10-01 2026-11-01')
const from = Date.parse(fromArg)
const to = Date.parse(toArg)
if (Number.isNaN(from) || Number.isNaN(to) || from >= to) throw new Error(`Не понял период: ${fromArg} — ${toArg}`)

const config = loadConfig()
const clock = new ManualClock(from)
const raw = createRawMarket(config, new BybitClient(), Date.now)
const detector = createDetector(config, new ClampedMarketData(raw, clock))
const dir = dataPath(config, 'situations')
mkdirSync(dir, { recursive: true })
const counts: string[] = []

for (const symbol of symbolsArg.split(',')) {
  console.log(`\n${symbol}`)
  const found: Situation[] = []
  for (let now = Math.ceil(from / HOUR) * HOUR; now <= to; now += HOUR) {
    clock.set(now)
    const situation = await detector.detect({ symbol, now, candles: {} })
    if (!situation?.picture) continue
    found.push(situation)
    console.log(`  ${describe(situation)}`)
  }
  counts.push(`${symbol}: ${found.length}`)

  const candles = await raw.candles(symbol, '1h', to, Math.ceil((to - from) / HOUR))
  const marks = found.map((situation) => ({ time: situation.at - HOUR, price: situation.picture!.zone.price, label: shares(situation) }))
  const title = `${symbol} · 1h · ситуаций ${found.length} · ${fromArg} — ${toArg}`
  writeFileSync(`${dir}/${symbol}.png`, renderLevelsPng({ title, candles, levels: [], marks }))
}
console.log(`\nСитуаций за период: ${counts.join(', ')}`)
console.log(`Картинки: ${dir}`)

function describe(situation: Situation): string {
  const { zone, structure } = situation.picture!
  const reasons = zone.reasons
    .map((reason) => (reason.type === 'wave' ? PART[reason.part] : `уровень ${reason.class === 'major' ? 'основной' : 'локальный'}, отскоков ${reason.bounces}`))
    .join(' + ')
  const after = structure.previousTrend ? ` после тренда ${structure.previousTrend === 'up' ? 'вверх' : 'вниз'}` : ''
  return `${new Date(situation.at).toISOString().slice(0, 16)}  зона ${price(zone.price)} (${reasons})  ${shares(situation)}  ${TREND[structure.trend]}${after}`
}

/** Какая волна куда идёт и какую долю обычной прошла. */
function shares(situation: Situation): string {
  const { small, big } = situation.picture!.waves
  const arrow = (direction: string) => (direction === 'up' ? '↑' : '↓')
  return `мелкая ${arrow(small.current.direction)}${Math.round(small.current.share * 100)}%, крупная ${arrow(big.current.direction)}${Math.round(big.current.share * 100)}%`
}

function price(value: number): number {
  return Number(value.toPrecision(6))
}
