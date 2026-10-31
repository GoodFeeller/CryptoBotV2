export const TIMEFRAMES = ['5m', '1h', '4h', '1d'] as const

export type Timeframe = (typeof TIMEFRAMES)[number]

const DURATION_MS: Record<Timeframe, number> = {
  '5m': 300_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
}

export function timeframeMs(tf: Timeframe): number {
  return DURATION_MS[tf]
}

// closeTime свечи это начало следующей свечи, а не её последняя миллисекунда.
export function isCloseOf(tf: Timeframe, closeTime: number): boolean {
  return closeTime % timeframeMs(tf) === 0
}
