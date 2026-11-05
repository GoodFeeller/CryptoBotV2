import { parseArgs } from 'node:util'
import { loadConfig, loadDotEnv } from './config.js'
import { printResult, withSymbols } from './print-result.js'
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
    symbols: { type: 'string' },
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
  { config: withSymbols(loadConfig(values.config), values.symbols) },
)

printResult(result)
