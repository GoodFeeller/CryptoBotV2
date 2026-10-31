import { describe, expect, it } from 'vitest'
import { BybitClient, type HttpGet } from '../../../src/features/market-data/bybit-client.js'

const HOUR = 3_600_000
const T0 = Date.UTC(2026, 0, 1)

function ok(result: unknown): unknown {
  return { retCode: 0, retMsg: 'OK', result }
}

function row(openTime: number): string[] {
  return [String(openTime), '1', '2', '0.5', '1.5', '10', '15']
}

/** Отдаёт ответы по очереди и запоминает адреса запросов. */
function scripted(responses: unknown[]): { http: HttpGet; urls: string[] } {
  const urls: string[] = []
  const http: HttpGet = async (url) => {
    urls.push(url)
    const next = responses.shift()
    if (next instanceof Error) throw next
    return next
  }
  return { http, urls }
}

function client(http: HttpGet, sleeps: number[] = []): BybitClient {
  return new BybitClient(http, async (ms) => {
    sleeps.push(ms)
  })
}

describe('klines', () => {
  it('returns candles oldest first with closeTime and numbers', async () => {
    const { http, urls } = scripted([ok({ list: [row(T0 + HOUR), row(T0)] })])

    const result = await client(http).klines('BTCUSDT', '1h', T0, T0 + HOUR)

    expect(result[0]).toEqual({
      openTime: T0,
      closeTime: T0 + HOUR,
      open: 1,
      high: 2,
      low: 0.5,
      close: 1.5,
      volume: 10,
      turnover: 15,
    })
    expect(result[1]?.openTime).toBe(T0 + HOUR)
    expect(urls[0]).toContain('category=linear')
    expect(urls[0]).toContain('interval=60')
  })

  it('pages backwards through a long range', async () => {
    const newer = Array.from({ length: 1000 }, (_, i) => row(T0 + (1999 - i) * HOUR))
    const older = Array.from({ length: 1000 }, (_, i) => row(T0 + (999 - i) * HOUR))
    const { http, urls } = scripted([ok({ list: newer }), ok({ list: older })])

    const result = await client(http).klines('BTCUSDT', '1h', T0, T0 + 1999 * HOUR)

    expect(result).toHaveLength(2000)
    expect(result[0]?.openTime).toBe(T0)
    expect(result.at(-1)?.openTime).toBe(T0 + 1999 * HOUR)
    expect(urls[1]).toContain(`end=${T0 + 1000 * HOUR - 1}`)
  })

  it('stops on a short page', async () => {
    const { http, urls } = scripted([ok({ list: [row(T0 + HOUR)] })])

    await client(http).klines('BTCUSDT', '1h', T0, T0 + HOUR)

    expect(urls).toHaveLength(1)
  })
})

describe('retries', () => {
  it('retries 5 times with growing pauses, then throws', async () => {
    const sleeps: number[] = []
    const { http, urls } = scripted(Array.from({ length: 6 }, () => new Error('network')))

    await expect(client(http, sleeps).klines('BTCUSDT', '1h', T0, T0)).rejects.toThrow('network')

    expect(urls).toHaveLength(6)
    expect(sleeps).toEqual([500, 1000, 2000, 4000, 8000])
  })

  it('succeeds after a temporary failure', async () => {
    const { http } = scripted([new Error('network'), ok({ list: [row(T0)] })])

    await expect(client(http).klines('BTCUSDT', '1h', T0, T0)).resolves.toHaveLength(1)
  })

  it('retries the rate limit response', async () => {
    const { http, urls } = scripted([{ retCode: 10006, retMsg: 'Too many visits' }, ok({ list: [] })])

    await client(http).klines('BTCUSDT', '1h', T0, T0)

    expect(urls).toHaveLength(2)
  })

  it('retries temporary server errors', async () => {
    const { http, urls } = scripted([
      { retCode: 10016, retMsg: 'svc error: Get kline failed' },
      { retCode: 10000, retMsg: 'Server Timeout' },
      ok({ list: [] }),
    ])

    await client(http).klines('BTCUSDT', '1h', T0, T0)

    expect(urls).toHaveLength(3)
  })

  it('does not retry other API errors', async () => {
    const { http, urls } = scripted([{ retCode: 10001, retMsg: 'params error' }])

    await expect(client(http).klines('BTCUSDT', '1h', T0, T0)).rejects.toThrow(/10001.*params error/)

    expect(urls).toHaveLength(1)
  })
})

describe('instruments', () => {
  function raw(symbol: string, extra: object = {}): object {
    return {
      symbol,
      contractType: 'LinearPerpetual',
      quoteCoin: 'USDT',
      launchTime: String(T0),
      priceFilter: { tickSize: '0.1' },
      lotSizeFilter: { qtyStep: '0.001', minOrderQty: '0.002' },
      leverageFilter: { maxLeverage: '100.00' },
      ...extra,
    }
  }

  it('maps fields and follows the cursor', async () => {
    const { http, urls } = scripted([
      ok({ list: [raw('AAAUSDT')], nextPageCursor: 'next' }),
      ok({ list: [raw('BBBUSDT')], nextPageCursor: '' }),
    ])

    const result = await client(http).instruments()

    expect(result.map((i) => i.symbol)).toEqual(['AAAUSDT', 'BBBUSDT'])
    expect(result[0]).toEqual({
      symbol: 'AAAUSDT',
      tickSize: 0.1,
      qtyStep: 0.001,
      minQty: 0.002,
      launchTime: T0,
      maxLeverage: 100,
    })
    expect(urls[0]).toContain('status=Trading')
    expect(urls[1]).toContain('cursor=next')
  })

  it('keeps only USDT perpetuals', async () => {
    const { http } = scripted([
      ok({
        list: [raw('AAAUSDT'), raw('AAA-26DEC26', { contractType: 'LinearFutures' }), raw('AAAPERP', { quoteCoin: 'USDC' })],
        nextPageCursor: '',
      }),
    ])

    const result = await client(http).instruments()

    expect(result.map((i) => i.symbol)).toEqual(['AAAUSDT'])
  })
})

describe('fundingRates', () => {
  it('returns rates oldest first and pages backwards', async () => {
    const newer = Array.from({ length: 200 }, (_, i) => ({
      fundingRate: '0.0001',
      fundingRateTimestamp: String(T0 + (399 - i) * HOUR),
    }))
    const older = [{ fundingRate: '-0.0002', fundingRateTimestamp: String(T0) }]
    const { http, urls } = scripted([ok({ list: newer }), ok({ list: older })])

    const result = await client(http).fundingRates('BTCUSDT', T0, T0 + 399 * HOUR)

    expect(result[0]).toEqual({ time: T0, rate: -0.0002 })
    expect(result).toHaveLength(201)
    expect(urls[1]).toContain(`endTime=${T0 + 200 * HOUR - 1}`)
  })
})
