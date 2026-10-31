// [REVIEW i-code#29] База для сравнения и бесплатного прогона конвейера: сторона выбирается случайно, но воспроизводимо по монете
// и времени. Параметры фиксированы и сделка не ведётся. Прогон с Claude должен быть лучше этого, иначе Claude не приносит пользы.
import type { TradeAdvisor } from '../../core/ports.js'
import type { EntryDecision, EntryRequest, ReviewDecision, ReviewRequest, Side } from '../../core/types.js'

export interface BaselineConfig {
  entryOffsetPct: number
  stopPct: number
  takePct: number
  notionalPct: number
  leverage: number
}

export class RandomSideAdvisor implements TradeAdvisor {
  constructor(private readonly baseline: BaselineConfig) {}

  async decideEntry({ situation, currentPrice }: EntryRequest): Promise<EntryDecision> {
    const { entryOffsetPct, stopPct, takePct, notionalPct, leverage } = this.baseline
    const side = sideOf(`${situation.symbol}:${situation.at}`)
    const sign = side === 'long' ? 1 : -1
    const entryPrice = currentPrice * (1 - (sign * entryOffsetPct) / 100)

    return {
      enter: true,
      side,
      entryPrice,
      leverage,
      notionalPct,
      stop: entryPrice * (1 - (sign * stopPct) / 100),
      take: entryPrice * (1 + (sign * takePct) / 100),
      reason: 'случайная сторона, база для сравнения',
    }
  }

  async reviewTrade(_request: ReviewRequest): Promise<ReviewDecision> {
    return { newStop: null, newTake: null, closeNow: false, reason: 'база для сравнения не меняет сделку' }
  }
}

/** Хеш FNV-1a: один и тот же вход всегда даёт одну и ту же сторону. */
function sideOf(text: string): Side {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193)
  }
  return ((hash >>> 16) & 1) === 0 ? 'long' : 'short'
}
