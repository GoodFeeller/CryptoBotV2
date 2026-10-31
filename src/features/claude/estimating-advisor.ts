// [REVIEW i-code#30] Оценка стоимости прогона через API до его запуска: API не вызывается, решения принимает вложенный советник.
// Оценка приблизительная: токены считаются как длина текста / 3.5, а длительность сделок берётся не от Claude.
import type { TradeAdvisor } from '../../core/ports.js'
import type { EntryDecision, EntryRequest, ReviewDecision, ReviewRequest } from '../../core/types.js'
import { anonymizeEntry, anonymizeReview } from './anonymize.js'
import { SYSTEM_PROMPTS } from './decision-advisor.js'
import { costUsd, type Pricing } from './response-cache.js'

const CHARS_PER_TOKEN = 3.5

export interface EstimatingAdvisorOptions {
  pricing: Pricing
  assumedOutputTokens: number
  promptVersion: string
}

export class EstimatingAdvisor implements TradeAdvisor {
  private requests = 0
  private cost = 0

  constructor(
    private readonly inner: TradeAdvisor,
    private readonly options: EstimatingAdvisorOptions,
  ) {}

  decideEntry(request: EntryRequest): Promise<EntryDecision> {
    this.count(anonymizeEntry(request).body)
    return this.inner.decideEntry(request)
  }

  reviewTrade(request: ReviewRequest): Promise<ReviewDecision> {
    this.count(anonymizeReview(request).body)
    return this.inner.reviewTrade(request)
  }

  estimate(): { requests: number; costUsd: number } {
    return { requests: this.requests, costUsd: this.cost }
  }

  private count(body: object): void {
    const { pricing, assumedOutputTokens, promptVersion } = this.options
    const chars = JSON.stringify(body).length + (SYSTEM_PROMPTS[promptVersion]?.length ?? 0)
    this.requests++
    this.cost += costUsd(
      {
        inputTokens: chars / CHARS_PER_TOKEN,
        outputTokens: assumedOutputTokens,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      pricing,
    )
  }
}
