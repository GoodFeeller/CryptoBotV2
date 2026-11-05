// [REVIEW i-code#25] Советник отвечает только за формат: обезличивает запрос, разбирает ответ, возвращает реальные цены. Откуда
// берётся ответ, решает DecisionSource: API в live или сессии Claude Code в бэктесте. Поэтому оба пути проверяют одно и то же
// поведение. Правила сделки проверяет движок, а здесь только полнота ответа.
import type { TradeAdvisor } from '../../core/ports.js'
import type { EntryDecision, EntryRequest, ReviewDecision, ReviewRequest } from '../../core/types.js'
import { anonymizeEntry, anonymizeReview } from './anonymize.js'
import { SYSTEM_PROMPT_V1 } from './prompts/v1.js'
import { SYSTEM_PROMPT_V2 } from './prompts/v2.js'
import { EntryResponseSchema, ReviewResponseSchema } from './schemas.js'

export const SYSTEM_PROMPTS: Record<string, string> = { v1: SYSTEM_PROMPT_V1, v2: SYSTEM_PROMPT_V2 }

export interface DecisionRequest {
  kind: 'entry' | 'review'
  system: string
  body: object
}

export type SourceAnswer =
  | { status: 'answered'; raw: unknown }
  /** Ответа пока нет: прогон остановится после этого шага. */
  | { status: 'pending' }
  | { status: 'failed'; message: string; refusal: boolean }

export interface DecisionSource {
  answer(request: DecisionRequest): Promise<SourceAnswer>
}

export interface AdvisorStats {
  requests: number
  failures: number
  invalid: number
  refusals: number
}

export class DecisionAdvisor implements TradeAdvisor {
  private readonly counters: AdvisorStats = { requests: 0, failures: 0, invalid: 0, refusals: 0 }
  private readonly system: string

  constructor(
    private readonly source: DecisionSource,
    promptVersion: string,
  ) {
    const system = SYSTEM_PROMPTS[promptVersion]
    if (!system) throw new Error(`Нет промпта версии ${promptVersion}`)
    this.system = system
  }

  async decideEntry(request: EntryRequest): Promise<EntryDecision> {
    const { body, unscale } = anonymizeEntry(request)
    const answer = await this.source.answer({ kind: 'entry', system: this.system, body })
    if (answer.status === 'pending') return { enter: false, reason: 'ждём ответ сессии' }
    if (answer.status === 'failed') return this.failed(answer)

    this.counters.requests++
    const parsed = EntryResponseSchema.safeParse(answer.raw)
    if (!parsed.success) return this.invalid(parsed.error.message)

    const { enter, side, entryPrice, leverage, notionalPct, stop, take, reason } = parsed.data
    if (!enter) return { enter: false, reason }
    if (side === null || entryPrice === null || leverage === null || notionalPct === null || stop === null || take === null) {
      return this.invalid('при enter=true заполнены не все поля')
    }
    return {
      enter: true,
      side,
      entryPrice: unscale(entryPrice),
      leverage,
      notionalPct,
      stop: unscale(stop),
      take: unscale(take),
      reason,
    }
  }

  async reviewTrade(request: ReviewRequest): Promise<ReviewDecision> {
    const { body, unscale } = anonymizeReview(request)
    const answer = await this.source.answer({ kind: 'review', system: this.system, body })
    if (answer.status === 'pending') return { newStop: null, newTake: null, closeNow: false, reason: 'ждём ответ сессии' }
    if (answer.status === 'failed') return this.failed(answer)

    this.counters.requests++
    const parsed = ReviewResponseSchema.safeParse(answer.raw)
    if (!parsed.success) return this.invalid(parsed.error.message)

    const { newStop, newTake, closeNow, reason } = parsed.data
    return {
      newStop: newStop === null ? null : unscale(newStop),
      newTake: newTake === null ? null : unscale(newTake),
      closeNow,
      reason,
    }
  }

  stats(): AdvisorStats {
    return { ...this.counters }
  }

  private failed(answer: { message: string; refusal: boolean }): { failed: true; message: string } {
    this.counters.requests++
    if (answer.refusal) this.counters.refusals++
    else this.counters.failures++
    return { failed: true, message: answer.message }
  }

  private invalid(message: string): { failed: true; message: string } {
    this.counters.invalid++
    return { failed: true, message: `негодный ответ: ${message}` }
  }
}
