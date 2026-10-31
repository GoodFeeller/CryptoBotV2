// [REVIEW i-code#26] Источник решений через API: для live и сверки перед демо-счётом, бэктест по умолчанию его не использует.
// Лимит расходов проверяется до запроса и прерывает прогон исключением: тихий отказ исказил бы результат. stop_reason читается
// раньше результата, потому что при refusal и max_tokens ответа нет или он обрезан. SDK импортирует только anthropic-call.ts.
import { FatalRunError } from '../../core/errors.js'
import type { DecisionRequest, DecisionSource, SourceAnswer } from './decision-advisor.js'
import { cacheKey, costUsd, type Pricing, type ResponseCache, type Usage } from './response-cache.js'

export type ClaudeCall = (request: DecisionRequest) => Promise<{
  parsed: unknown
  usage: Usage
  stopReason: string | null
  model: string
}>

export class BudgetExceededError extends FatalRunError {}

export interface ApiDecisionSourceOptions {
  call: ClaudeCall
  /** null в live: там каждый запрос идёт в API. */
  cache: ResponseCache | null
  model: string
  promptVersion: string
  pricing: Pricing
  budgetUsd: number
}

export class ApiDecisionSource implements DecisionSource {
  private newUsd = 0
  private totalUsd = 0

  constructor(private readonly options: ApiDecisionSourceOptions) {}

  async answer(request: DecisionRequest): Promise<SourceAnswer> {
    const { call, cache, model, promptVersion, pricing, budgetUsd } = this.options
    const key = cacheKey(model, promptVersion, request.body)

    const cached = cache?.get(key)
    if (cached) {
      this.totalUsd += cached.costUsd
      return { status: 'answered', raw: cached.raw }
    }
    if (this.newUsd >= budgetUsd) {
      throw new BudgetExceededError(`Достигнут лимит расходов ${budgetUsd} USD`)
    }

    try {
      const response = await call(request)
      const cost = costUsd(response.usage, pricing)
      this.newUsd += cost
      this.totalUsd += cost

      if (response.stopReason === 'refusal') return { status: 'failed', message: 'модель отказалась отвечать', refusal: true }
      if (response.stopReason === 'max_tokens') return { status: 'failed', message: 'ответ обрезан', refusal: false }

      cache?.put(key, { raw: response.parsed, costUsd: cost })
      return { status: 'answered', raw: response.parsed }
    } catch (error) {
      return { status: 'failed', message: error instanceof Error ? error.message : String(error), refusal: false }
    }
  }

  spend(): { newUsd: number; totalUsd: number } {
    return { newUsd: this.newUsd, totalUsd: this.totalUsd }
  }
}
