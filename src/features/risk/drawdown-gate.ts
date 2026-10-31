// [REVIEW i-code#19] Защита от просадки. Просадка считается от пика капитала с незакрытым результатом. Запрет не снимается
// сам: после такой просадки решение о продолжении должен принять человек. Запас потери считается в USDT от того же порога,
// поэтому сумма стопов всех сделок не сможет увести счёт за предел, если нет гэпов.
import type { RiskGate } from '../../core/ports.js'
import type { Equity, Exposure, GateResult } from '../../core/types.js'

export class DrawdownGate implements RiskGate {
  private peak = 0
  private haltedDrawdownPct: number | null = null

  constructor(private readonly options: { maxDrawdownHaltPct: number }) {}

  update(equity: Equity): void {
    this.peak = Math.max(this.peak, equity.total)
    if (this.haltedDrawdownPct !== null || this.peak <= 0) return

    const drawdownPct = ((this.peak - equity.total) / this.peak) * 100
    if (drawdownPct >= this.options.maxDrawdownHaltPct) this.haltedDrawdownPct = drawdownPct
  }

  canOpen(): GateResult {
    return this.haltedDrawdownPct === null ? { allowed: true } : { allowed: false, drawdownPct: this.haltedDrawdownPct }
  }

  availableLoss(equity: Equity, exposures: Exposure[]): number {
    const floor = this.peak * (1 - this.options.maxDrawdownHaltPct / 100)
    const atRisk = exposures.reduce((sum, exposure) => sum + exposure.lossAtStop, 0)
    return equity.total - floor - atRisk
  }
}
