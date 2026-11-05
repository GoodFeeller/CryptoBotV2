import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { config as loadEnvFile } from 'dotenv'
import { z } from 'zod'
import { TIMEFRAMES } from '../core/timeframes.js'

const DEFAULT_CONFIG_PATH = fileURLToPath(new URL('../../config/default.json', import.meta.url))

const Timeframe = z.enum(TIMEFRAMES)
const PositiveInt = z.number().int().positive()
const Percent = z.number().positive().max(100)
const CostPercent = z.number().nonnegative().max(100)

const ConfigSchema = z.strictObject({
  timeframes: z.strictObject({ execution: Timeframe, signal: Timeframe }),
  symbols: z.array(z.string().min(1)).min(1),
  trading: z.strictObject({
    maxPositions: PositiveInt,
    limitOrderTtlHours: z.number().positive(),
    minStopPct: Percent,
  }),
  risk: z.strictObject({ maxDrawdownHaltPct: Percent }),
  costs: z.strictObject({
    takerPct: CostPercent,
    makerPct: CostPercent,
    slippagePct: CostPercent,
    limitFillThroughPct: CostPercent,
    maintenanceMarginPct: CostPercent,
  }),
  baseline: z.strictObject({
    entryOffsetPct: Percent,
    stopPct: Percent,
    takePct: Percent,
    notionalPct: z.number().positive(),
    leverage: z.number().positive(),
  }),
  claude: z.strictObject({
    model: z.string().min(1),
    effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']),
    maxTokens: PositiveInt,
    promptVersion: z.string().min(1),
    budgetUsd: z.number().nonnegative(),
    assumedOutputTokens: PositiveInt,
    windows: z.partialRecord(Timeframe, PositiveInt),
    pricing: z.strictObject({
      inputPerM: z.number().nonnegative(),
      outputPerM: z.number().nonnegative(),
      cacheReadPerM: z.number().nonnegative(),
      cacheWritePerM: z.number().nonnegative(),
    }),
  }),
  ema: z.strictObject({
    periods: z.array(PositiveInt).min(1),
    timeframes: z.array(Timeframe).min(1),
    slopeBars: PositiveInt,
    atrPeriod: PositiveInt,
    warmupFactor: z.number().min(1),
  }),
  waves: z.strictObject({
    timeframes: z.array(Timeframe).min(1),
    swingAtr: z.number().positive(),
    atrPeriod: PositiveInt,
    sampleWaves: PositiveInt,
    minWaves: PositiveInt,
    historyCandles: PositiveInt,
  }),
  backtest: z.strictObject({ initialBalance: z.number().positive() }),
  paths: z.strictObject({ data: z.string().min(1) }),
})

export type AppConfig = z.infer<typeof ConfigSchema>

export function loadConfig(path: string = DEFAULT_CONFIG_PATH): AppConfig {
  const result = ConfigSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')))
  if (result.success) return result.data

  const problems = result.error.issues.map((issue) => `${issue.path.join('.') || '(корень)'}: ${issue.message}`)
  throw new Error(`Ошибка в конфиге ${path}:\n${problems.join('\n')}`)
}

// Переменная, уже заданная в системе, важнее значения из .env: dotenv её не перезаписывает.
export function loadDotEnv(): void {
  loadEnvFile({ quiet: true })
}

export function requireSecret(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const value = env[name]
  if (!value) throw new Error(`Не задана переменная ${name}. Добавьте её в .env, образец в .env.example`)
  return value
}
