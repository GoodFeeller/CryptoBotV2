// [REVIEW i-code#35] Критерий цели проекта. Вердикта нет, если условия проверки не выполнены: подбор параметров, заглушка сигналов,
// меньше 6 месяцев или выключенные издержки. Иначе красивая цифра выглядела бы как доказательство.
export const TARGET_MONTHLY_PCT = 60
export const MAX_DRAWDOWN_PCT = 50
export const MIN_FULL_MONTHS = 6

export interface VerdictInput {
  mode: 'research' | 'validation'
  isPlaceholder: boolean
  fullMonths: number
  costsEnabled: boolean
  medianMonthlyPct: number
  maxDrawdownPct: number
}

export type Verdict = 'PASS' | 'FAIL' | 'N/A'

export function verdict(input: VerdictInput): Verdict {
  const { mode, isPlaceholder, fullMonths, costsEnabled, medianMonthlyPct, maxDrawdownPct } = input
  if (mode !== 'validation' || isPlaceholder || fullMonths < MIN_FULL_MONTHS || !costsEnabled) return 'N/A'
  return medianMonthlyPct >= TARGET_MONTHLY_PCT && maxDrawdownPct <= MAX_DRAWDOWN_PCT ? 'PASS' : 'FAIL'
}
