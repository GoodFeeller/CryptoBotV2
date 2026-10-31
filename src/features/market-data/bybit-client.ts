import { timeframeMs } from '../../core/timeframes.js'
import type { Candle, FundingRate, Instrument, Timeframe } from '../../core/types.js'

const BASE_URL = 'https://api.bybit.com'
const KLINE_PAGE = 1000
const FUNDING_PAGE = 200
const MAX_RETRIES = 5
const FIRST_PAUSE_MS = 500
/** Таймаут сервера, лимит запросов и внутренняя ошибка сервиса: запрос стоит повторить. */
const TEMPORARY_CODES = new Set([10000, 10006, 10016])

const INTERVALS: Record<Timeframe, string> = { '5m': '5', '1h': '60', '4h': '240', '1d': 'D' }

export type HttpGet = (url: string) => Promise<unknown>
export type Sleep = (ms: number) => Promise<void>

export const fetchJson: HttpGet = async (url) => {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`HTTP ${response.status} при запросе ${url}`)
  return response.json()
}

const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

interface Envelope<T> {
  retCode: number
  retMsg: string
  result: T
}

interface RawInstrument {
  symbol: string
  contractType: string
  quoteCoin: string
  launchTime: string
  priceFilter: { tickSize: string }
  lotSizeFilter: { qtyStep: string; minOrderQty: string }
  leverageFilter: { maxLeverage: string }
}

class BybitApiError extends Error {}

export class BybitClient {
  constructor(
    private readonly http: HttpGet = fetchJson,
    private readonly sleep: Sleep = realSleep,
  ) {}

  /** Все торгуемые USDT-перпетуалы. */
  async instruments(): Promise<Instrument[]> {
    const result: Instrument[] = []
    let cursor = ''
    do {
      const page = await this.get<{ list: RawInstrument[]; nextPageCursor?: string }>('/v5/market/instruments-info', {
        category: 'linear',
        status: 'Trading',
        limit: '1000',
        ...(cursor ? { cursor } : {}),
      })
      for (const raw of page.list) {
        if (raw.contractType !== 'LinearPerpetual' || raw.quoteCoin !== 'USDT') continue
        result.push({
          symbol: raw.symbol,
          tickSize: Number(raw.priceFilter.tickSize),
          qtyStep: Number(raw.lotSizeFilter.qtyStep),
          minQty: Number(raw.lotSizeFilter.minOrderQty),
          launchTime: Number(raw.launchTime),
          maxLeverage: Number(raw.leverageFilter.maxLeverage),
        })
      }
      cursor = page.nextPageCursor ?? ''
    } while (cursor)
    return result
  }

  /** Свечи с openTime в диапазоне [start, end], от старых к новым. Bybit отдаёт новые первыми, поэтому листаем назад. */
  async klines(symbol: string, tf: Timeframe, start: number, end: number): Promise<Candle[]> {
    const step = timeframeMs(tf)
    const candles: Candle[] = []
    let pageEnd = end

    while (true) {
      const page = await this.get<{ list: string[][] }>('/v5/market/kline', {
        category: 'linear',
        symbol,
        interval: INTERVALS[tf],
        start: String(start),
        end: String(pageEnd),
        limit: String(KLINE_PAGE),
      })
      const batch = page.list.map((row) => toCandle(row, step))
      candles.push(...batch)

      const oldest = batch.at(-1)?.openTime
      if (oldest === undefined || oldest <= start || batch.length < KLINE_PAGE) break
      pageEnd = oldest - 1
    }

    return candles.sort((a, b) => a.openTime - b.openTime)
  }

  /** Ставки с временем в диапазоне [from, to], от старых к новым. */
  async fundingRates(symbol: string, from: number, to: number): Promise<FundingRate[]> {
    const rates: FundingRate[] = []
    let pageEnd = to

    while (true) {
      const page = await this.get<{ list: { fundingRate: string; fundingRateTimestamp: string }[] }>(
        '/v5/market/funding/history',
        {
          category: 'linear',
          symbol,
          startTime: String(from),
          endTime: String(pageEnd),
          limit: String(FUNDING_PAGE),
        },
      )
      const batch = page.list.map((raw) => ({ time: Number(raw.fundingRateTimestamp), rate: Number(raw.fundingRate) }))
      rates.push(...batch)

      const oldest = batch.at(-1)?.time
      if (oldest === undefined || oldest <= from || batch.length < FUNDING_PAGE) break
      pageEnd = oldest - 1
    }

    return rates.sort((a, b) => a.time - b.time)
  }

  private async get<T>(path: string, params: Record<string, string>): Promise<T> {
    const url = `${BASE_URL}${path}?${new URLSearchParams(params)}`
    for (let attempt = 0; ; attempt++) {
      try {
        const body = (await this.http(url)) as Envelope<T>
        if (body.retCode === 0) return body.result
        const message = `Bybit ${body.retCode}: ${body.retMsg}`
        if (!TEMPORARY_CODES.has(body.retCode)) throw new BybitApiError(message)
        throw new Error(message)
      } catch (error) {
        if (error instanceof BybitApiError || attempt === MAX_RETRIES) throw error
        await this.sleep(FIRST_PAUSE_MS * 2 ** attempt)
      }
    }
  }
}

function toCandle(row: string[], step: number): Candle {
  const [openTime, open, high, low, close, volume, turnover] = row.map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ]
  return { openTime, closeTime: openTime + step, open, high, low, close, volume, turnover }
}
