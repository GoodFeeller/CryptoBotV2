import type { SignalDetector } from '../../core/ports.js'
import type { SignalContext, Situation } from '../../core/types.js'

/** Ситуации из заранее заданного списка. Только для тестов. */
export class ScriptedSignalDetector implements SignalDetector {
  readonly isPlaceholder = true

  constructor(private readonly situations: Situation[]) {}

  async detect(ctx: SignalContext): Promise<Situation | null> {
    return this.situations.find(({ symbol, at }) => symbol === ctx.symbol && at === ctx.now) ?? null
  }
}
