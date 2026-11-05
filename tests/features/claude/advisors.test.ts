import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Candle, EntryRequest, Position, ReviewRequest } from '../../../src/core/types.js'
import { DecisionAdvisor, type DecisionSource, type SourceAnswer } from '../../../src/features/claude/decision-advisor.js'
import { anonymizeEntry, anonymizeReview } from '../../../src/features/claude/anonymize.js'
import { ApiDecisionSource, BudgetExceededError, type ClaudeCall } from '../../../src/features/claude/api-source.js'
import { cacheKey, costUsd, ResponseCache } from '../../../src/features/claude/response-cache.js'
import { EstimatingAdvisor } from '../../../src/features/claude/estimating-advisor.js'
import { RandomSideAdvisor } from '../../../src/features/claude/random-side-advisor.js'
import { SessionDecisionSource } from '../../../src/features/claude/session-source.js'

const HOUR = 3_600_000
const T0 = Date.UTC(2026, 0, 10)
const PRICING = { inputPerM: 4, outputPerM: 20, cacheReadPerM: 0.2, cacheWritePerM: 5 }

function candle(i: number, close: number, volume = 10): Candle {
  const openTime = T0 + i * HOUR
  return { openTime, closeTime: openTime + HOUR, open: close, high: close + 1, low: close - 1, close, volume, turnover: 1 }
}

const ENTRY: EntryRequest = {
  situation: {
    symbol: 'BTCUSDT',
    kind: 'level-approach',
    at: T0,
    picture: null,
  },
  currentPrice: 50_000,
  candles: { '1h': [candle(0, 49_000), candle(1, 50_000, 30)] },
  maxLossPct: 12.5,
}

const POSITION: Position = {
  id: 'p1',
  symbol: 'BTCUSDT',
  side: 'long',
  kind: 'level-approach',
  qty: 1,
  leverage: 5,
  entryPrice: 49_000,
  initialStop: 48_000,
  stop: 48_000,
  take: 52_000,
  openedAt: T0,
  reason: 'r',
}

const REVIEW: ReviewRequest = {
  position: POSITION,
  currentPrice: 50_000,
  now: T0 + 3 * HOUR,
  candles: { '1h': [candle(0, 50_000)] },
}

const ENTER_ANSWER = {
  enter: true,
  side: 'long',
  entryPrice: 99,
  leverage: 5,
  notionalPct: 20,
  stop: 97,
  take: 104,
  reason: 'отбой',
}

function fixedSource(answer: SourceAnswer): DecisionSource {
  return { answer: async () => answer }
}

describe('anonymize', () => {
  it('has no symbol and no timestamps', () => {
    const entry = JSON.stringify(anonymizeEntry(ENTRY).body)
    const review = JSON.stringify(anonymizeReview(REVIEW).body)

    for (const text of [entry, review]) {
      expect(text).not.toContain('BTC')
      expect(text).not.toContain(String(T0))
      expect(text).not.toContain('50000')
    }
  })

  it('maps the current price to 100 and sends the situation kind', () => {
    const { body, scale } = anonymizeEntry(ENTRY)

    expect(scale).toBe(100 / 50_000)
    expect(body.currentPrice).toBe(100)
    expect(body.situation).toEqual({ kind: 'level-approach', picture: null })
    expect(body.maxLossPct).toBe(12.5)
  })

  it('sends candles oldest first with relative volume', () => {
    const { body } = anonymizeEntry(ENTRY)

    expect(body.candles['1h']).toEqual([
      [98, 98.002, 97.998, 98, 0.5],
      [100, 100.002, 99.998, 100, 1.5],
    ])
  })

  it('review body carries the trade state', () => {
    const { body } = anonymizeReview(REVIEW)

    expect(body).toMatchObject({ side: 'long', currentPrice: 100, entryPrice: 98, stop: 96, take: 104, hoursInTrade: 3 })
    expect(body.resultR).toBe(1)
  })
})

describe('DecisionAdvisor', () => {
  function advisor(answer: SourceAnswer): DecisionAdvisor {
    return new DecisionAdvisor(fixedSource(answer), 'v1')
  }

  it('scales an entry answer back to real prices', async () => {
    const result = await advisor({ status: 'answered', raw: ENTER_ANSWER }).decideEntry(ENTRY)

    expect(result).toEqual({
      enter: true,
      side: 'long',
      entryPrice: 49_500,
      leverage: 5,
      notionalPct: 20,
      stop: 48_500,
      take: 52_000,
      reason: 'отбой',
    })
  })

  it('accepts a refusal to enter', async () => {
    const raw = { enter: false, side: null, entryPrice: null, leverage: null, notionalPct: null, stop: null, take: null, reason: 'нет' }

    expect(await advisor({ status: 'answered', raw }).decideEntry(ENTRY)).toEqual({ enter: false, reason: 'нет' })
  })

  it('counts a malformed or incomplete answer as invalid', async () => {
    const bad = advisor({ status: 'answered', raw: { enter: true } })
    expect(await bad.decideEntry(ENTRY)).toMatchObject({ failed: true })

    const incomplete = advisor({ status: 'answered', raw: { ...ENTER_ANSWER, stop: null } })
    expect(await incomplete.decideEntry(ENTRY)).toMatchObject({ failed: true })
    expect(incomplete.stats()).toMatchObject({ requests: 1, invalid: 1, failures: 0 })
  })

  it('counts a source failure and a refusal', async () => {
    const failed = advisor({ status: 'failed', message: 'API', refusal: false })
    expect(await failed.decideEntry(ENTRY)).toEqual({ failed: true, message: 'API' })
    expect(failed.stats().failures).toBe(1)

    const refused = advisor({ status: 'failed', message: 'нет', refusal: true })
    await refused.reviewTrade(REVIEW)
    expect(refused.stats().refusals).toBe(1)
  })

  it('scales a review answer back', async () => {
    const raw = { newStop: 100, newTake: null, closeNow: false, reason: 'подтянул' }

    expect(await advisor({ status: 'answered', raw }).reviewTrade(REVIEW)).toEqual({
      newStop: 50_000,
      newTake: null,
      closeNow: false,
      reason: 'подтянул',
    })
  })

  it('a pending answer changes nothing', async () => {
    const pending = advisor({ status: 'pending' })

    expect(await pending.decideEntry(ENTRY)).toMatchObject({ enter: false })
    expect(await pending.reviewTrade(REVIEW)).toMatchObject({ newStop: null, newTake: null, closeNow: false })
    expect(pending.stats().requests).toBe(0)
  })

  it('a request never contains the symbol', async () => {
    let sent = ''
    const source: DecisionSource = {
      answer: async (request) => {
        sent = JSON.stringify(request)
        return { status: 'pending' }
      },
    }

    await new DecisionAdvisor(source, 'v1').decideEntry(ENTRY)

    expect(sent).not.toContain('BTC')
    expect(sent).toContain('level-approach')
  })
})

describe('ResponseCache and cost', () => {
  it('key changes with model, prompt version or body', () => {
    const base = cacheKey('m', 'v1', { a: 1 })

    expect(cacheKey('m', 'v1', { a: 1 })).toBe(base)
    expect(cacheKey('x', 'v1', { a: 1 })).not.toBe(base)
    expect(cacheKey('m', 'v2', { a: 1 })).not.toBe(base)
    expect(cacheKey('m', 'v1', { a: 2 })).not.toBe(base)
  })

  it('a corrupt file is a miss', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cryptobot-cache-'))
    const cache = new ResponseCache(dir)
    cache.put('k', { raw: 1, costUsd: 2 })
    expect(cache.get('k')).toEqual({ raw: 1, costUsd: 2 })

    writeFileSync(join(dir, 'k.json'), '{')

    expect(cache.get('k')).toBeNull()
  })

  it('computes cost from usage with Opus 5.5 prices', () => {
    const usage = (over: object) => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, ...over })

    expect(costUsd(usage({ inputTokens: 1_000_000 }), PRICING)).toBe(4)
    expect(costUsd(usage({ outputTokens: 1_000_000 }), PRICING)).toBe(20)
    expect(costUsd(usage({ cacheReadTokens: 1_000_000 }), PRICING)).toBe(0.2)
    expect(costUsd(usage({ cacheWriteTokens: 1_000_000 }), PRICING)).toBe(5)
  })
})

describe('ApiDecisionSource', () => {
  const REQUEST = { kind: 'entry', system: 's', body: { x: 1 } } as const
  const USAGE = { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
  let cache: ResponseCache
  let calls: number

  function source(call: ClaudeCall, budgetUsd = 100, useCache = true): ApiDecisionSource {
    const counted: ClaudeCall = (request) => {
      calls++
      return call(request)
    }
    return new ApiDecisionSource({ call: counted, cache: useCache ? cache : null, model: 'm', promptVersion: 'v1', pricing: PRICING, budgetUsd })
  }

  const success: ClaudeCall = async () => ({ parsed: { ok: 1 }, usage: USAGE, stopReason: 'end_turn', model: 'm' })

  beforeEach(() => {
    cache = new ResponseCache(mkdtempSync(join(tmpdir(), 'cryptobot-api-')))
    calls = 0
  })

  it('a cache hit does not call the API and adds no new spend, but counts the original cost', async () => {
    await source(success).answer(REQUEST)
    const second = source(success)

    expect(await second.answer(REQUEST)).toEqual({ status: 'answered', raw: { ok: 1 } })
    expect(calls).toBe(1)
    expect(second.spend()).toEqual({ newUsd: 0, totalUsd: 4 })
  })

  it('without a cache every request goes to the API', async () => {
    const live = source(success, 100, false)
    await live.answer(REQUEST)
    await live.answer(REQUEST)

    expect(calls).toBe(2)
  })

  it('only successful answers are cached', async () => {
    const failing = source(async () => {
      throw new Error('boom')
    })

    expect(await failing.answer(REQUEST)).toEqual({ status: 'failed', message: 'boom', refusal: false })
    await source(success).answer(REQUEST)
    expect(calls).toBe(2)
  })

  it('a refusal and a cut answer are failures', async () => {
    const refusal = source(async () => ({ parsed: null, usage: USAGE, stopReason: 'refusal', model: 'm' }))
    expect(await refusal.answer(REQUEST)).toMatchObject({ status: 'failed', refusal: true })

    const cut = source(async () => ({ parsed: null, usage: USAGE, stopReason: 'max_tokens', model: 'm' }))
    expect(await cut.answer({ ...REQUEST, body: { x: 2 } })).toMatchObject({ status: 'failed', refusal: false })
  })

  it('throws BudgetExceededError before a call over budget', async () => {
    const limited = source(success, 3)
    await limited.answer(REQUEST)

    await expect(limited.answer({ ...REQUEST, body: { x: 2 } })).rejects.toBeInstanceOf(BudgetExceededError)
    expect(calls).toBe(1)
  })
})

describe('SessionDecisionSource', () => {
  const REQUEST = { kind: 'entry', system: 'промпт', body: { x: 1 } } as const
  let dir: string
  let session: SessionDecisionSource

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cryptobot-session-'))
    session = new SessionDecisionSource(dir, 'v1')
  })

  function answerAll(raw: unknown): void {
    for (const file of readdirSync(join(dir, 'pending'))) {
      writeFileSync(join(dir, 'answers', file), JSON.stringify(raw))
    }
  }

  it('a missing answer writes a pending file', async () => {
    expect(await session.answer(REQUEST)).toEqual({ status: 'pending' })
    expect(session.pendingCount()).toBe(1)

    const [file] = readdirSync(join(dir, 'pending'))
    const pending = JSON.parse(readFileSync(join(dir, 'pending', file!), 'utf8'))
    expect(pending).toMatchObject({ kind: 'entry', system: 'промпт', body: { x: 1 } })
    expect(pending.responseSchema).toBeTruthy()
  })

  it('all requests of one step are written together', async () => {
    await session.answer(REQUEST)
    await session.answer({ ...REQUEST, body: { x: 2 } })

    expect(readdirSync(join(dir, 'pending'))).toHaveLength(2)
    expect(session.pendingCount()).toBe(2)
  })

  it('an existing answer is replayed and its request removed', async () => {
    await session.answer(REQUEST)
    answerAll({ ok: 1 })

    const next = new SessionDecisionSource(dir, 'v1')

    expect(await next.answer(REQUEST)).toEqual({ status: 'answered', raw: { ok: 1 } })
    expect(next.pendingCount()).toBe(0)
    expect(readdirSync(join(dir, 'pending'))).toEqual([])
  })

  it('a corrupt answer is a failure', async () => {
    await session.answer(REQUEST)
    for (const file of readdirSync(join(dir, 'pending'))) writeFileSync(join(dir, 'answers', file), '{')

    expect(await new SessionDecisionSource(dir, 'v1').answer(REQUEST)).toMatchObject({ status: 'failed' })
  })

  it('clearPending removes old requests only', async () => {
    await session.answer(REQUEST)
    answerAll({ ok: 1 })
    await session.answer({ ...REQUEST, body: { x: 2 } })

    session.clearPending()

    expect(readdirSync(join(dir, 'pending'))).toEqual([])
    expect(readdirSync(join(dir, 'answers'))).toHaveLength(1)
    expect(session.pendingCount()).toBe(0)
  })
})

describe('RandomSideAdvisor', () => {
  const BASELINE = { entryOffsetPct: 0.2, stopPct: 1, takePct: 1.5, notionalPct: 20, leverage: 5 }

  it('is deterministic and uses both sides', async () => {
    const advisor = new RandomSideAdvisor(BASELINE)
    const sides = new Set<string>()
    for (let i = 0; i < 50; i++) {
      const request = { ...ENTRY, situation: { ...ENTRY.situation, at: T0 + i * HOUR } }
      const first = await advisor.decideEntry(request)
      expect(await advisor.decideEntry(request)).toEqual(first)
      if ('side' in first) sides.add(first.side)
    }

    expect(sides).toEqual(new Set(['long', 'short']))
  })

  it('places prices around the current price', async () => {
    const advisor = new RandomSideAdvisor(BASELINE)
    for (let i = 0; i < 20; i++) {
      const decision = await advisor.decideEntry({ ...ENTRY, situation: { ...ENTRY.situation, at: T0 + i * HOUR } })
      if (!('side' in decision)) throw new Error('ожидался вход')
      if (decision.side === 'long') {
        expect(decision.entryPrice).toBeCloseTo(49_900)
        expect(decision.stop).toBeCloseTo(49_900 * 0.99)
        expect(decision.take).toBeCloseTo(49_900 * 1.015)
      } else {
        expect(decision.entryPrice).toBeCloseTo(50_100)
        expect(decision.stop).toBeCloseTo(50_100 * 1.01)
        expect(decision.take).toBeCloseTo(50_100 * 0.985)
      }
      expect(decision).toMatchObject({ leverage: 5, notionalPct: 20 })
    }
  })

  it('never changes a trade', async () => {
    expect(await new RandomSideAdvisor(BASELINE).reviewTrade(REVIEW)).toMatchObject({
      newStop: null,
      newTake: null,
      closeNow: false,
    })
  })
})

describe('EstimatingAdvisor', () => {
  it('counts requests and estimates cost without calling anything else', async () => {
    const advisor = new EstimatingAdvisor(new RandomSideAdvisor({ entryOffsetPct: 0.2, stopPct: 1, takePct: 1.5, notionalPct: 20, leverage: 5 }), {
      pricing: PRICING,
      assumedOutputTokens: 2000,
      promptVersion: 'v1',
    })

    await advisor.decideEntry(ENTRY)
    await advisor.reviewTrade(REVIEW)

    const estimate = advisor.estimate()
    expect(estimate.requests).toBe(2)
    expect(estimate.costUsd).toBeGreaterThan((2 * 2000 * 20) / 1_000_000)
  })
})
