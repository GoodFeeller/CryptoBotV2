// Положение EMA в заданный момент. Чистые функции: видят только свечи, закрытые к этому моменту, поэтому в бэктесте не заглядывают
// в будущее. Расстояние до цены в ATR, чтобы одни и те же числа читались одинаково на BTC и на мелких монетах.
import { computeAtr } from '../../core/atr.js'
import type { Candle, EmaReading, EmaSnapshot, EmaStack } from '../../core/types.js'

export interface EmaOptions {
  /** Периоды от быстрого к медленному. */
  periods: number[]
  /** Наклон: значение EMA сравнивается с её значением столько свечей назад. */
  slopeBars: number
  atrPeriod: number
  /** Нужно истории не меньше warmupFactor × самый длинный период: иначе начальное значение заметно искажает EMA. */
  warmupFactor: number
}

/** EMA по каждому значению. Начало: простое среднее первых period значений, до него значения нет. */
export function computeEma(values: number[], period: number): (number | undefined)[] {
  const weight = 2 / (period + 1)
  const result: (number | undefined)[] = []
  let ema: number | undefined
  values.forEach((value, i) => {
    if (i === period - 1) ema = values.slice(0, period).reduce((sum, item) => sum + item, 0) / period
    else if (ema !== undefined) ema += weight * (value - ema)
    result.push(ema)
  })
  return result
}

/** Положение EMA на момент at по свечам, закрытым не позже него. */
export function emaSnapshot(candles: Candle[], at: number, options: EmaOptions): EmaSnapshot {
  const closed = candles.filter((candle) => candle.closeTime <= at)
  const needed = options.warmupFactor * Math.max(...options.periods)
  if (closed.length < needed) return { ok: false, reason: 'not_enough_candles', needed, got: closed.length }

  const closes = closed.map((candle) => candle.close)
  const close = closes.at(-1)!
  const atr = computeAtr(closed, options.atrPeriod).at(-1)!
  const emas = options.periods.map((period): EmaReading => {
    const series = computeEma(closes, period)
    const value = series.at(-1)!
    const before = series.at(-1 - options.slopeBars) ?? value
    return {
      period,
      value,
      priceSide: close >= value ? 'above' : 'below',
      distanceAtr: atr > 0 ? Math.abs(close - value) / atr : 0,
      slope: value > before ? 'up' : value < before ? 'down' : 'flat',
    }
  })
  return { ok: true, at, close, emas, stack: stackOf(emas.map((ema) => ema.value)) }
}

function stackOf(values: number[]): EmaStack {
  const pairs = values.slice(1).map((slower, i) => values[i]! - slower)
  if (pairs.every((gap) => gap > 0)) return 'up'
  if (pairs.every((gap) => gap < 0)) return 'down'
  return 'mixed'
}
