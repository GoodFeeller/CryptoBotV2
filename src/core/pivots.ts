import type { Candle } from './types.js'

/** Разворот волны: экстремум, от которого цена потом ушла на заданное число ATR. */
export interface Pivot {
  type: 'high' | 'low'
  /** Свеча экстремума. */
  index: number
  price: number
  /** Свеча, на которой разворот подтвердился: раньше неё о развороте знать нельзя. */
  confirmedIndex: number
}

/** Волны: разворот подтверждается, только когда цена ушла от экстремума на swingAtr. Самая первая точка разворотом не считается. */
export function findPivots(candles: Candle[], atr: number[], swingAtr: number): Pivot[] {
  const pivots: Pivot[] = []
  let direction: 'up' | 'down' | null = null
  let highIndex = 0
  let lowIndex = 0

  candles.forEach((candle, i) => {
    if (candle.high > candles[highIndex]!.high) highIndex = i
    if (candle.low < candles[lowIndex]!.low) lowIndex = i
    const swing = swingAtr * atr[i]!

    if (direction === null) {
      if (candle.high - candles[lowIndex]!.low >= swing && highIndex > lowIndex) direction = 'up'
      else if (candles[highIndex]!.high - candle.low >= swing && lowIndex > highIndex) direction = 'down'
      return
    }
    if (direction === 'up' && candles[highIndex]!.high - candle.low >= swing && i > highIndex) {
      pivots.push({ type: 'high', index: highIndex, price: candles[highIndex]!.high, confirmedIndex: i })
      direction = 'down'
      lowIndex = i
    } else if (direction === 'down' && candle.high - candles[lowIndex]!.low >= swing && i > lowIndex) {
      pivots.push({ type: 'low', index: lowIndex, price: candles[lowIndex]!.low, confirmedIndex: i })
      direction = 'up'
      highIndex = i
    }
  })
  return pivots
}
