import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig, requireSecret } from '../../src/app/config.js'

function writeConfig(content: unknown): string {
  const path = join(mkdtempSync(join(tmpdir(), 'cryptobot-config-')), 'config.json')
  writeFileSync(path, JSON.stringify(content))
  return path
}

describe('loadConfig', () => {
  it('loads defaults from the spec', () => {
    const cfg = loadConfig()

    expect(cfg.timeframes).toEqual({ execution: '5m', signal: '1h' })
    expect(cfg.symbols).toEqual([
      'BTCUSDT',
      'ETHUSDT',
      'SOLUSDT',
      'XRPUSDT',
      'DOGEUSDT',
      '1000PEPEUSDT',
      'SUIUSDT',
      'HYPEUSDT',
      'ADAUSDT',
      'FARTCOINUSDT',
    ])
    expect(cfg.trading).toEqual({ maxPositions: 5, limitOrderTtlHours: 4, minStopPct: 0.3 })
    expect(cfg.risk).toEqual({ maxDrawdownHaltPct: 40 })
    expect(cfg.costs).toEqual({
      takerPct: 0.055,
      makerPct: 0.02,
      slippagePct: 0.05,
      limitFillThroughPct: 0.02,
      maintenanceMarginPct: 0.5,
    })
    expect(cfg.baseline).toEqual({ entryOffsetPct: 0.2, stopPct: 1, takePct: 1.5, notionalPct: 20, leverage: 5 })
    expect(cfg.claude.model).toBe('claude-opus-5-5')
    expect(cfg.claude.effort).toBe('high')
    expect(cfg.claude.maxTokens).toBe(16000)
    expect(cfg.claude.budgetUsd).toBe(20)
    expect(cfg.claude.windows).toEqual({ '1h': 200, '4h': 100 })
    expect(cfg.claude.pricing).toEqual({ inputPerM: 4, outputPerM: 20, cacheReadPerM: 0.2, cacheWritePerM: 5 })
  })

  it('rejects negative maxDrawdownHaltPct and names the field', () => {
    const base = loadConfig()
    const path = writeConfig({ ...base, risk: { maxDrawdownHaltPct: -1 } })

    expect(() => loadConfig(path)).toThrow(/risk\.maxDrawdownHaltPct/)
  })

  it('rejects an unknown timeframe', () => {
    const base = loadConfig()
    const path = writeConfig({ ...base, timeframes: { ...base.timeframes, signal: '7m' } })

    expect(() => loadConfig(path)).toThrow(/timeframes\.signal/)
  })

  it('rejects a misspelled field instead of silently using nothing', () => {
    const base = loadConfig()
    const path = writeConfig({ ...base, risk: { ...base.risk, riskPercent: 2 } })

    expect(() => loadConfig(path)).toThrow(/riskPercent/)
  })
})

describe('requireSecret', () => {
  it('returns the value when set', () => {
    expect(requireSecret('ANTHROPIC_API_KEY', { ANTHROPIC_API_KEY: 'value' })).toBe('value')
  })

  it('throws naming the variable when missing or empty', () => {
    expect(() => requireSecret('TELEGRAM_BOT_TOKEN', {})).toThrow(/TELEGRAM_BOT_TOKEN/)
    expect(() => requireSecret('TELEGRAM_BOT_TOKEN', { TELEGRAM_BOT_TOKEN: '' })).toThrow(/TELEGRAM_BOT_TOKEN/)
  })
})
