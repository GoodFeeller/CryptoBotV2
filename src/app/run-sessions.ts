// Бэктест через сессии Claude Code целиком: прогон доходит до запросов без ответа, сессии отвечают на них, прогон перезапускается
// с начала и идёт дальше, пока не дойдёт до конца периода. Перезапуск с начала безопасен: готовые ответы лежат в answers,
// поэтому прошлые шаги повторяются без новых сессий.
import { answerPending, type ClaudeRunner } from './session-answerer.js'
import { runBacktest, type BacktestOptions, type BacktestResult, type RunDeps } from './run-backtest.js'

export interface SessionLoopOptions {
  runner: ClaudeRunner
  /** Столько сессий работает одновременно. */
  concurrency: number
  /** Защита от бесконечного цикла: столько остановок на запросах самое большее. */
  maxCycles: number
  /** Вызывается перед ответами на каждой остановке с числом запросов. */
  onCycle?: (pending: number) => void
}

export async function backtestWithSessions(
  options: Pick<BacktestOptions, 'from' | 'to' | 'mode'>,
  deps: Partial<RunDeps>,
  loop: SessionLoopOptions,
): Promise<BacktestResult> {
  for (let cycle = 0; cycle < loop.maxCycles; cycle++) {
    const result = await runBacktest({ ...options, advisor: 'session', estimate: false }, deps)
    if (result.status !== 'needs_decisions' || !result.pendingDir) return result
    loop.onCycle?.(result.pending)
    // pendingDir указывает на .../pending, ответы пишутся в соседнюю answers.
    await answerPending(result.pendingDir.replace(/[\\/]pending$/, ''), loop.runner, { concurrency: loop.concurrency })
  }
  throw new Error(`Бэктест не дошёл до конца за ${loop.maxCycles} остановок на запросах`)
}
