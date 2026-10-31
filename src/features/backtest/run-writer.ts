import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ClosedTrade } from '../../core/types.js'
import type { EquityPoint, Report } from './report.js'

const TRADE_COLUMNS: (keyof ClosedTrade)[] = [
  'symbol',
  'side',
  'kind',
  'openedAt',
  'closedAt',
  'qty',
  'leverage',
  'entryPrice',
  'initialStop',
  'stop',
  'take',
  'exitPrice',
  'closeReason',
  'pnl',
  'r',
  'fees',
  'slippageCost',
  'funding',
  'reason',
]

const LOG_HEADER = 'run,from,to,status,verdict,medianMonthlyPct,maxDrawdownPct,trades'

export interface RunFiles {
  report: Report
  trades: ClosedTrade[]
  equity: EquityPoint[]
  config: unknown
}

export function writeRun(dir: string, files: RunFiles): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'report.json'), JSON.stringify(files.report, null, 2))
  writeFileSync(join(dir, 'config.json'), JSON.stringify(files.config, null, 2))
  writeFileSync(
    join(dir, 'trades.csv'),
    toCsv(
      TRADE_COLUMNS,
      files.trades.map((trade) => TRADE_COLUMNS.map((column) => trade[column])),
    ),
  )
  writeFileSync(
    join(dir, 'equity.csv'),
    toCsv(
      ['time', 'total'],
      files.equity.map((point) => [point.time, point.total]),
    ),
  )
}

/** Каждая проверка отрезка оставляет след: многократная проверка одного периода превращает её в подбор. */
export function appendValidationLog(path: string, runId: string, report: Report): void {
  mkdirSync(dirname(path), { recursive: true })
  if (!existsSync(path)) writeFileSync(path, `${LOG_HEADER}\n`)
  const row = [
    runId,
    report.from,
    report.to,
    report.status,
    report.verdict,
    report.medianMonthlyPct,
    report.maxDrawdownPct,
    report.trades.count,
  ]
  appendFileSync(path, `${row.join(',')}\n`)
}

function toCsv(header: readonly unknown[], rows: readonly (readonly unknown[])[]): string {
  return [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\n') + '\n'
}

function csvCell(value: unknown): string {
  const text = String(value)
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}
