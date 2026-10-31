import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface CachedResponse {
  raw: unknown
  costUsd: number
}

export interface Usage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

export interface Pricing {
  inputPerM: number
  outputPerM: number
  cacheReadPerM: number
  cacheWritePerM: number
}

export function cacheKey(model: string, promptVersion: string, body: unknown): string {
  return createHash('sha256').update(JSON.stringify([model, promptVersion, body])).digest('hex')
}

export function costUsd(usage: Usage, pricing: Pricing): number {
  return (
    (usage.inputTokens * pricing.inputPerM +
      usage.outputTokens * pricing.outputPerM +
      usage.cacheReadTokens * pricing.cacheReadPerM +
      usage.cacheWriteTokens * pricing.cacheWritePerM) /
    1_000_000
  )
}

/** Успешные ответы на диске: один файл на запрос. Повреждённый файл считается отсутствующим. */
export class ResponseCache {
  constructor(private readonly dir: string) {}

  get(key: string): CachedResponse | null {
    try {
      return JSON.parse(readFileSync(this.path(key), 'utf8')) as CachedResponse
    } catch {
      return null
    }
  }

  put(key: string, value: CachedResponse): void {
    mkdirSync(this.dir, { recursive: true })
    writeFileSync(this.path(key), JSON.stringify(value))
  }

  private path(key: string): string {
    return join(this.dir, `${key}.json`)
  }
}
