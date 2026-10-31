// [REVIEW i-code#27] Единственное место с SDK. Fallback при отказе включён: модель в ответе записывается, поэтому смена модели
// будет видна. temperature и отключение размышлений на этой модели дают ошибку 400, поэтому их нет; глубину задаёт effort.
import Anthropic from '@anthropic-ai/sdk'
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod'
import type { ClaudeCall } from './api-source.js'
import { EntryResponseSchema, ReviewResponseSchema } from './schemas.js'

export interface AnthropicCallOptions {
  apiKey: string
  model: string
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  maxTokens: number
}

export function createAnthropicCall(options: AnthropicCallOptions): ClaudeCall {
  const client = new Anthropic({ apiKey: options.apiKey, maxRetries: 3 })

  return async (request) => {
    const schema = request.kind === 'entry' ? EntryResponseSchema : ReviewResponseSchema
    const response = await client.beta.messages.parse({
      model: options.model,
      max_tokens: options.maxTokens,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: [{ type: 'text', text: request.system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: JSON.stringify(request.body) }],
      output_config: { effort: options.effort, format: betaZodOutputFormat(schema) },
    })

    return {
      parsed: response.parsed_output ?? null,
      stopReason: response.stop_reason,
      model: response.model,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
      },
    }
  }
}
