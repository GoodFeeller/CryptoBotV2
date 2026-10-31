import type { MarketData } from '../../core/ports.js'
import { timeframeMs } from '../../core/timeframes.js'
import type { Candle, FundingRate, Instrument, Timeframe } from '../../core/types.js'
import type { CandleStore } from './candle-store.js'

const MISSING_GRACE_MS = 60_000
const FETCH_AHEAD_CANDLES = 1000

export interface BybitApi {
  instruments(): Promise<Instrument[]>
  klines(symbol: string, tf: Timeframe, start: number, end: number): Promise<Candle[]>
  fundingRates(symbol: string, from: number, to: number): Promise<FundingRate[]>
}

export interface DataGap {
  symbol: string
  timeframe: Timeframe
  openTime: number
}

export interface BybitMarketDataOptions {
  api: BybitApi
  store: CandleStore
  now: () => number
}

export class BybitMarketData implements MarketData {
  private instrumentsLoad: Promise<Instrument[]> | null = null
  private readonly gaps = new Map<string, DataGap>()

  constructor(private readonly options: BybitMarketDataOptions) {}

  async instrument(symbol: string): Promise<Instrument> {
    this.instrumentsLoad ??= this.options.api.instruments()
    const found = (await this.instrumentsLoad).find((instrument) => instrument.symbol === symbol)
    if (!found) throw new Error(`Монета ${symbol} не найдена на Bybit`)
    return found
  }

  async candles(symbol: string, tf: Timeframe, endAt: number, limit: number): Promise<Candle[]> {
    const { api, store, now } = this.options
    const step = timeframeMs(tf)
    const lastClose = Math.floor(Math.min(endAt, now()) / step) * step
    const { launchTime } = await this.instrument(symbol)
    const firstOpen = Math.max(lastClose - limit * step, Math.floor(launchTime / step) * step)
    if (firstOpen >= lastClose) return []

    const stored = store.readCandles(symbol, tf, firstOpen, lastClose)
    const storedTimes = new Set(stored.map((candle) => candle.openTime))
    const knownMissing = store.readMissing(symbol, tf)
    const toFetch: number[] = []
    for (let openTime = firstOpen; openTime < lastClose; openTime += step) {
      if (!storedTimes.has(openTime) && !knownMissing.has(openTime)) toFetch.push(openTime)
    }

    if (toFetch.length > 0) {
      // Загружаем вперёд: бэктест двигает окно по одной свече, и иначе каждая новая свеча стоила бы запроса к бирже.
      // В кеш попадают только закрытые свечи, а наружу уходит только окно до endAt.
      const closedNow = Math.floor(now() / step) * step
      const fetchEnd = Math.max(toFetch.at(-1)!, Math.min(toFetch[0]! + (FETCH_AHEAD_CANDLES - 1) * step, closedNow - step))
      const fetched = (await api.klines(symbol, tf, toFetch[0]!, fetchEnd)).filter((candle) => candle.closeTime <= closedNow)
      store.writeCandles(symbol, tf, fetched)

      const fetchedTimes = new Set(fetched.map((candle) => candle.openTime))
      const settled = toFetch.filter(
        (openTime) => !fetchedTimes.has(openTime) && openTime + step <= now() - MISSING_GRACE_MS,
      )
      if (settled.length > 0) store.addMissing(symbol, tf, settled)
    }

    const result = store.readCandles(symbol, tf, firstOpen, lastClose)
    this.recordInnerGaps(symbol, tf, result, step)
    return result
  }

  async fundingRates(symbol: string, from: number, to: number): Promise<FundingRate[]> {
    const { api, store, now } = this.options
    const end = Math.min(to, now())
    const covered = store.fundingCoverage(symbol)

    if (!covered || from < covered.from || end > covered.to) {
      const range = { from: Math.min(from, covered?.from ?? from), to: Math.max(end, covered?.to ?? end) }
      store.writeFunding(symbol, await api.fundingRates(symbol, range.from, range.to), range)
    }
    return store.readFunding(symbol, from, end)
  }

  /** Пропуски в свечах, которые встретились за этот запуск. */
  dataGaps(): DataGap[] {
    return [...this.gaps.values()]
  }

  /** Дыра только между свечами: пустота после последней свечи это ещё не опубликованные или снятые с торгов данные. */
  private recordInnerGaps(symbol: string, timeframe: Timeframe, candles: Candle[], step: number): void {
    for (let i = 1; i < candles.length; i++) {
      for (let openTime = candles[i - 1]!.openTime + step; openTime < candles[i]!.openTime; openTime += step) {
        this.gaps.set(`${symbol}:${timeframe}:${openTime}`, { symbol, timeframe, openTime })
      }
    }
  }
}
