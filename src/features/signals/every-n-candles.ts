// [REVIEW i-code#21] Заглушка вместо настоящих сигналов: нужна только чтобы прогнать конвейер целиком. Номер свечи считается
// от времени, поэтому детектор не хранит состояния и повторный прогон даёт те же ситуации. По её результатам нельзя судить
// о доходности, поэтому isPlaceholder всегда true и вердикт отчёта будет N/A.
import type { SignalDetector } from '../../core/ports.js'
import { timeframeMs } from '../../core/timeframes.js'
import type { SignalContext, Situation, Timeframe } from '../../core/types.js'

export class EveryNCandlesDetector implements SignalDetector {
  readonly isPlaceholder = true

  constructor(private readonly options: { n: number; timeframe: Timeframe }) {}

  async detect(ctx: SignalContext): Promise<Situation | null> {
    const { n, timeframe } = this.options
    const last = ctx.candles[timeframe]?.at(-1)
    if (!last) return null
    if (Math.floor(last.closeTime / timeframeMs(timeframe)) % n !== 0) return null

    return { symbol: ctx.symbol, kind: 'every-n-candles', at: ctx.now, picture: null }
  }
}
