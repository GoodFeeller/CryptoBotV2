import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { answerPending, cliFailure, cliSchema, type ClaudeRunner } from '../../src/app/session-answerer.js'

const NO_ENTRY = { enter: false, side: null, entryPrice: null, leverage: null, notionalPct: null, stop: null, take: null, reason: 'нет паттерна' }
const HOLD = { newStop: null, newTake: null, closeNow: false, reason: 'держим' }

describe('answerPending', () => {
  let dir: string
  const pending = () => join(dir, 'pending')
  const answers = () => join(dir, 'answers')

  function request(file: string, kind: 'entry' | 'review'): void {
    writeFileSync(join(pending(), file), JSON.stringify({ kind, system: `системный ${kind}`, body: { currentPrice: 100, kind }, responseSchema: { type: 'object' } }))
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cryptobot-sessions-'))
    mkdirSync(pending())
    mkdirSync(answers())
  })

  it('answers every pending request with the session output', async () => {
    request('a.json', 'entry')
    request('b.json', 'review')
    const seen: { system: string; prompt: string }[] = []
    const runner: ClaudeRunner = async (input) => {
      seen.push({ system: input.system, prompt: input.prompt })
      return JSON.parse(input.prompt).kind === 'entry' ? NO_ENTRY : HOLD
    }

    expect(await answerPending(dir, runner, { concurrency: 2 })).toBe(2)
    expect(JSON.parse(readFileSync(join(answers(), 'a.json'), 'utf8'))).toEqual(NO_ENTRY)
    expect(JSON.parse(readFileSync(join(answers(), 'b.json'), 'utf8'))).toEqual(HOLD)
    expect(seen.map((item) => item.system).sort()).toEqual(['системный entry', 'системный review'])
  })

  it('sends only the anonymized body as the prompt', async () => {
    request('a.json', 'entry')
    let prompt = ''
    await answerPending(dir, async (input) => ((prompt = input.prompt), NO_ENTRY), { concurrency: 1 })

    expect(JSON.parse(prompt)).toEqual({ currentPrice: 100, kind: 'entry' })
  })

  it('asks again after an invalid answer and keeps the valid one', async () => {
    request('a.json', 'entry')
    let calls = 0
    await answerPending(dir, async () => (++calls === 1 ? { enter: 'maybe' } : NO_ENTRY), { concurrency: 1 })

    expect(calls).toBe(2)
    expect(JSON.parse(readFileSync(join(answers(), 'a.json'), 'utf8'))).toEqual(NO_ENTRY)
  })

  it('stops with an error after two invalid answers and writes no answer for it', async () => {
    request('a.json', 'entry')

    await expect(answerPending(dir, async () => ({ enter: 'maybe' }), { concurrency: 1 })).rejects.toThrow('a.json')
    expect(existsSync(join(answers(), 'a.json'))).toBe(false)
  })

  it('a failed session stops with an error', async () => {
    request('a.json', 'entry')

    await expect(
      answerPending(dir, async () => {
        throw new Error('лимит подписки')
      }, { concurrency: 1 }),
    ).rejects.toThrow('лимит подписки')
  })

  it('with nothing pending does nothing', async () => {
    expect(await answerPending(dir, async () => NO_ENTRY, { concurrency: 1 })).toBe(0)
    expect(readdirSync(answers())).toEqual([])
  })
})

describe('cliSchema', () => {
  it('drops the $schema draft key that claude --json-schema rejects', () => {
    const schema = { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', properties: { a: { type: 'number' } } }

    expect(cliSchema(schema)).toEqual({ type: 'object', properties: { a: { type: 'number' } } })
  })
})

describe('cliFailure', () => {
  it('shows the reason from the json result instead of raw output', () => {
    const out = JSON.stringify({ is_error: true, usage: { input_tokens: 0 }, result: 'Failed to authenticate: OAuth session expired' })

    expect(cliFailure(1, out, '')).toBe('claude завершился с кодом 1: Failed to authenticate: OAuth session expired')
  })

  it('falls back to stderr when the output is not json', () => {
    expect(cliFailure(2, 'oops', 'unknown option')).toBe('claude завершился с кодом 2: unknown option')
  })
})
