import { describe, expect, it } from 'vitest'
import type { Equity } from '../../../src/core/types.js'
import { DrawdownGate } from '../../../src/features/risk/drawdown-gate.js'

function equity(total: number): Equity {
  return { balance: total, unrealized: 0, total, usedMargin: 0 }
}

describe('DrawdownGate', () => {
  it('allows while drawdown is below the limit', () => {
    const gate = new DrawdownGate({ maxDrawdownHaltPct: 40 })
    gate.update(equity(10_000))
    gate.update(equity(6001))

    expect(gate.canOpen()).toEqual({ allowed: true })
  })

  it('halts at the limit and stays halted after a recovery', () => {
    const gate = new DrawdownGate({ maxDrawdownHaltPct: 40 })
    gate.update(equity(10_000))
    gate.update(equity(6000))
    expect(gate.canOpen()).toEqual({ allowed: false, drawdownPct: 40 })

    gate.update(equity(9000))
    expect(gate.canOpen().allowed).toBe(false)
  })

  it('measures drawdown from the highest peak', () => {
    const gate = new DrawdownGate({ maxDrawdownHaltPct: 40 })
    gate.update(equity(10_000))
    gate.update(equity(20_000))
    gate.update(equity(12_000))

    expect(gate.canOpen().allowed).toBe(false)
  })

  it('available loss is the distance to the floor minus open exposure', () => {
    const gate = new DrawdownGate({ maxDrawdownHaltPct: 40 })
    gate.update(equity(10_000))

    expect(gate.availableLoss(equity(9000), [])).toBe(3000)
    expect(gate.availableLoss(equity(9000), [{ lossAtStop: 500 }, { lossAtStop: 100 }])).toBe(2400)
  })

  it('available loss can be negative', () => {
    const gate = new DrawdownGate({ maxDrawdownHaltPct: 40 })
    gate.update(equity(10_000))

    expect(gate.availableLoss(equity(6100), [{ lossAtStop: 500 }])).toBe(-400)
  })
})
