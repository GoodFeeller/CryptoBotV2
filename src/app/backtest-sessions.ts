// npm run backtest:sessions -- --from 2026-10-01 --to 2026-11-01 --symbols BTCUSDT
// Бэктест, где на запросы отвечают изолированные сессии Claude Code (claude -p) вместо платного API. Ответы расходуют лимиты
// подписки Claude. После сбоя команду можно запустить снова: готовые ответы уже лежат в answers.
import { parseArgs } from 'node:util'
import { loadConfig, loadDotEnv } from './config.js'
import { printResult, withSymbols } from './print-result.js'
import { createCliRunner } from './session-answerer.js'
import { backtestWithSessions } from './run-sessions.js'

const MAX_CYCLES = 5000

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
    symbols: { type: 'string' },
    concurrency: { type: 'string', default: '4' },
    config: { type: 'string' },
  },
})
if (!values.from || !values.to) throw new Error('Нужны --from и --to, например --from 2026-10-01 --to 2026-11-01')
if (values.mode !== 'research' && values.mode !== 'validation') throw new Error('--mode: research или validation')
const concurrency = Number(values.concurrency)
if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('--concurrency: целое число от 1')

const config = withSymbols(loadConfig(values.config), values.symbols)
let cycles = 0
let answered = 0
const started = Date.now()
const result = await backtestWithSessions(
  { from: parseDate(values.from, 'from'), to: parseDate(values.to, 'to'), mode: values.mode },
  { config },
  {
    runner: createCliRunner({ model: config.claude.model }),
    concurrency,
    maxCycles: MAX_CYCLES,
    onCycle: (pending) => {
      cycles++
      answered += pending
      console.log(`Остановка ${cycles}: запросов ${pending}, всего отвечено ${answered}, прошло ${Math.round((Date.now() - started) / 60_000)} мин`)
    },
  },
)
printResult(result)
