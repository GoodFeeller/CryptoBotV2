// [REVIEW i-code#37] Ответ на вопрос, помогает ли лимитный вход: что было бы, войди мы рынком на первой свече после выставления ордера
// с теми же стопом и тейком. Считаются только ордера, не исполненные из-за цены; отмены защитой и концом прогона не считаются.
import type { Candle, TradingCosts } from '../../core/types.js'
import type { OrderRecord } from './simulated-broker.js'

const MISSED_OUTCOMES = new Set<OrderRecord['outcome']>(['post_only', 'expired', 'take_reached'])

export async function missedEntries(
  orders: OrderRecord[],
  candlesAfter: (record: OrderRecord) => Promise<Candle[]>,
  costs: TradingCosts,
): Promise<{ count: number; avgR: number }> {
  const results: number[] = []
  for (const record of orders) {
    if (!MISSED_OUTCOMES.has(record.outcome) || record.firstCandleOpen === null) continue
    const r = marketEntryR(record, record.firstCandleOpen, await candlesAfter(record), costs)
    if (r !== null) results.push(r)
  }
  return {
    count: results.length,
    avgR: results.length ? results.reduce((sum, value) => sum + value, 0) / results.length : 0,
  }
}

function marketEntryR(record: OrderRecord, entry: number, candles: Candle[], costs: TradingCosts): number | null {
  const { side, stop, take } = record.order
  const long = side === 'long'
  // Если цена уже за стопом или тейком, войти с этими уровнями было бы невозможно.
  if (long ? entry <= stop || entry >= take : entry >= stop || entry <= take) return null

  let exit = candles.at(-1)?.close ?? entry
  for (const candle of candles) {
    if (long ? candle.low <= stop : candle.high >= stop) {
      exit = stop
      break
    }
    if (long ? candle.high >= take : candle.low <= take) {
      exit = take
      break
    }
  }

  const sign = long ? 1 : -1
  const costPct = costs.takerPct + costs.slippagePct
  const cost = ((entry + exit) * costPct) / 100
  return (sign * (exit - entry) - cost) / Math.abs(entry - stop)
}
