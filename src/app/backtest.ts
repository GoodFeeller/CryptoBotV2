import { parseArgs } from 'node:util'
import { loadConfig, loadDotEnv } from './config.js'
import { runBacktest, type BacktestOptions } from './run-backtest.js'

function parseDate(value: string, name: string): number {
  const time = Date.parse(`${value}T00:00:00Z`)
  if (Number.isNaN(time)) throw new Error(`--${name}: нужна дата вида 2026-01-31, получено ${value}`)
  return time
}

loadDotEnv()
const { values } = parseArgs({
  options: {
    from: { type: 'string' },
    to: { type: 'string' },
    mode: { type: 'string', default: 'research' },
    advisor: { type: 'string', default: 'session' },
    estimate: { type: 'boolean', default: false },
    config: { type: 'string' },
  },
})
if (!values.from || !values.to) throw new Error('Нужны --from и --to, например --from 2026-01-01 --to 2026-02-01')
if (values.mode !== 'research' && values.mode !== 'validation') throw new Error('--mode: research или validation')
const advisors: BacktestOptions['advisor'][] = ['session', 'claude', 'random-side']
const advisor = advisors.find((name) => name === values.advisor)
if (!advisor) throw new Error(`--advisor: ${advisors.join(', ')}`)

const result = await runBacktest(
  {
    from: parseDate(values.from, 'from'),
    to: parseDate(values.to, 'to'),
    mode: values.mode,
    advisor,
    estimate: values.estimate,
  },
  { config: loadConfig(values.config) },
)

if (result.estimate) {
  console.log(`Запросов к Claude: ${result.estimate.requests}, оценка: $${result.estimate.costUsd.toFixed(2)}`)
} else {
  console.log(`Статус: ${result.status}`)
  if (result.status === 'needs_decisions') {
    console.log(`Запросов ждут ответа: ${result.pending}. Папка: ${result.pendingDir}`)
    console.log('Ответы запишите в соседнюю папку answers с теми же именами файлов и запустите команду снова.')
  }
  const report = result.report
  if (report) {
    console.log(`Вердикт: ${report.verdict}`)
    console.log(`Медиана месяца: ${report.medianMonthlyPct.toFixed(2)}%, полных месяцев: ${report.fullMonths}`)
    console.log(`Максимальная просадка: ${report.maxDrawdownPct.toFixed(2)}%, капитал в конце: ${report.finalEquity.toFixed(2)}`)
    console.log(
      `Ордеров: ${report.orders.placed}, исполнено: ${report.orders.fillRatePct.toFixed(1)}%, сделок: ${report.trades.count}, ` +
        `прибыльных: ${report.trades.winRatePct.toFixed(1)}%, безубыточность: ${report.trades.breakevenWinRatePct.toFixed(1)}%, ` +
        `средний результат: ${report.trades.avgR.toFixed(2)}R`,
    )
    console.log(`Комиссии: ${report.costs.fees.toFixed(2)}, проскальзывание: ${report.costs.slippage.toFixed(2)}, фандинг: ${report.costs.funding.toFixed(2)}`)
    console.log(`Запросов: ${report.advisor.requests}, новые траты API: $${report.spend.newUsd.toFixed(2)}, дыр в данных: ${report.gaps}`)
  }
  if (result.dir) console.log(`Файлы: ${result.dir}`)
}
