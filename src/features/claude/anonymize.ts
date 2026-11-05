// [REVIEW i-code#22] Обезличивание запроса: без тикера и дат, цены в шкале «текущая цена = 100». Иначе модель может узнать монету
// и период и вспомнить, что было дальше, и бэктест окажется завышен. Позиция тоже передаётся только полями цены и состояния.
// Шкала строится от текущей цены, а не от последнего закрытия, чтобы правило «текущая цена всегда 100» было точным.
import type { Candle, CandleWindows, EntryRequest, ReviewRequest, Side, Timeframe } from '../../core/types.js'

const HOUR_MS = 3_600_000

type AnonCandle = [open: number, high: number, low: number, close: number, relativeVolume: number]
type AnonCandles = Partial<Record<Timeframe, AnonCandle[]>>

export interface AnonEntryBody {
  // Картина рынка обезличивается отдельно, пока уходит только тип ситуации.
  situation: { kind: string; picture: null }
  currentPrice: number
  maxLossPct: number
  candles: AnonCandles
}

export interface AnonReviewBody {
  side: Side
  currentPrice: number
  entryPrice: number
  stop: number
  take: number
  resultR: number
  hoursInTrade: number
  candles: AnonCandles
}

export interface Anonymized<T> {
  body: T
  scale: number
  /** Переводит цену из шкалы запроса обратно в реальную. */
  unscale: (value: number) => number
}

export function anonymizeEntry(request: EntryRequest): Anonymized<AnonEntryBody> {
  const { situation, currentPrice, candles, maxLossPct } = request
  const toScale = scaler(currentPrice)
  return {
    body: {
      situation: {
        kind: situation.kind,
        picture: null,
      },
      currentPrice: toScale(currentPrice),
      maxLossPct,
      candles: anonymizeCandles(candles, toScale),
    },
    ...scaleOf(currentPrice),
  }
}

export function anonymizeReview(request: ReviewRequest): Anonymized<AnonReviewBody> {
  const { position, currentPrice, now, candles } = request
  const toScale = scaler(currentPrice)
  const sign = position.side === 'long' ? 1 : -1
  const riskPerUnit = Math.abs(position.entryPrice - position.initialStop)

  return {
    body: {
      side: position.side,
      currentPrice: toScale(currentPrice),
      entryPrice: toScale(position.entryPrice),
      stop: toScale(position.stop),
      take: toScale(position.take),
      resultR: round((sign * (currentPrice - position.entryPrice)) / riskPerUnit),
      hoursInTrade: round((now - position.openedAt) / HOUR_MS),
      candles: anonymizeCandles(candles, toScale),
    },
    ...scaleOf(currentPrice),
  }
}

function scaleOf(price: number): { scale: number; unscale: (value: number) => number } {
  return { scale: 100 / price, unscale: (value) => (value * price) / 100 }
}

function scaler(price: number): (value: number) => number {
  return (value) => round((value * 100) / price)
}

function anonymizeCandles(windows: CandleWindows, toScale: (value: number) => number): AnonCandles {
  const result: AnonCandles = {}
  for (const [timeframe, candles] of Object.entries(windows) as [Timeframe, Candle[]][]) {
    const meanVolume = candles.reduce((sum, candle) => sum + candle.volume, 0) / candles.length || 1
    result[timeframe] = candles.map((candle) => [
      toScale(candle.open),
      toScale(candle.high),
      toScale(candle.low),
      toScale(candle.close),
      round(candle.volume / meanVolume),
    ])
  }
  return result
}

function round(value: number): number {
  return Number(value.toFixed(4))
}
