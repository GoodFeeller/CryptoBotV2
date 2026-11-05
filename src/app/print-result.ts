// Общая печать результата бэктеста для npm run backtest и npm run backtest:sessions.
import type { AppConfig } from './config.js'
import type { BacktestResult } from './run-backtest.js'

/** --symbols BTCUSDT,ETHUSDT: прогон только по этим монетам вместо всех из конфига. */
export function withSymbols(config: AppConfig, symbols: string | undefined): AppConfig {
  return symbols ? { ...config, symbols: symbols.split(',') } : config
}

export function printResult(result: BacktestResult): void {
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
}
