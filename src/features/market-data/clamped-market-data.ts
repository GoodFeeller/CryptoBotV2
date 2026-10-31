import type { Clock, MarketData } from '../../core/ports.js'
import type { Candle, FundingRate, Instrument, Timeframe } from '../../core/types.js'

export class ClampedMarketData implements MarketData {
  constructor(
    private readonly inner: MarketData,
    private readonly clock: Clock,
  ) {}

  instrument(symbol: string): Promise<Instrument> {
    return this.inner.instrument(symbol)
  }

  candles(symbol: string, tf: Timeframe, endAt: number, limit: number): Promise<Candle[]> {
    return this.inner.candles(symbol, tf, Math.min(endAt, this.clock.now()), limit)
  }

  fundingRates(symbol: string, from: number, to: number): Promise<FundingRate[]> {
    return this.inner.fundingRates(symbol, from, Math.min(to, this.clock.now()))
  }
}
