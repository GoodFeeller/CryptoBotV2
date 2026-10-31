import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Candle, FundingRate, Timeframe } from '../../core/types.js'

export interface TimeRange {
  from: number
  to: number
}

export class CandleStore {
  /** Прочитанные файлы: бэктест читает одни и те же месяцы тысячи раз. */
  private readonly files = new Map<string, unknown[]>()

  constructor(private readonly root: string) {}

  /** Свечи с openTime в диапазоне [from, to). */
  readCandles(symbol: string, tf: Timeframe, from: number, to: number): Candle[] {
    const result: Candle[] = []
    for (const month of monthsBetween(from, to)) {
      for (const candle of this.readLines<Candle>(this.candlePath(symbol, tf, month))) {
        if (candle.openTime >= from && candle.openTime < to) result.push(candle)
      }
    }
    return result.sort((a, b) => a.openTime - b.openTime)
  }

  writeCandles(symbol: string, tf: Timeframe, candles: Candle[]): void {
    const byMonth = new Map<string, Candle[]>()
    for (const candle of candles) {
      const month = monthOf(candle.openTime)
      byMonth.set(month, [...(byMonth.get(month) ?? []), candle])
    }

    for (const [month, fresh] of byMonth) {
      const path = this.candlePath(symbol, tf, month)
      // Запись идёт от файла, а не от памяти: другой запуск мог дописать его, и его свечи нельзя стереть.
      const merged = new Map((parseJsonLines(path) as Candle[]).map((candle) => [candle.openTime, candle]))
      for (const candle of fresh) merged.set(candle.openTime, candle)
      this.writeLines(path, [...merged.values()].sort((a, b) => a.openTime - b.openTime))
    }
  }

  readMissing(symbol: string, tf: Timeframe): Set<number> {
    return new Set(this.readLines<number>(this.missingPath(symbol, tf)))
  }

  addMissing(symbol: string, tf: Timeframe, openTimes: number[]): void {
    const merged = new Set([...this.readMissing(symbol, tf), ...openTimes])
    this.writeLines(this.missingPath(symbol, tf), [...merged].sort((a, b) => a - b))
  }

  /** Ставки с временем в диапазоне [from, to). */
  readFunding(symbol: string, from: number, to: number): FundingRate[] {
    return this.readLines<FundingRate>(this.fundingPath(symbol))
      .filter((rate) => rate.time >= from && rate.time < to)
      .sort((a, b) => a.time - b.time)
  }

  writeFunding(symbol: string, rates: FundingRate[], coverage: TimeRange): void {
    const path = this.fundingPath(symbol)
    const merged = new Map(this.readLines<FundingRate>(path).map((rate) => [rate.time, rate]))
    for (const rate of rates) merged.set(rate.time, rate)
    this.writeLines(path, [...merged.values()].sort((a, b) => a.time - b.time))
    this.writeLines(this.coveragePath(symbol), [coverage])
  }

  /** Период, за который ставки уже загружены. Без него нельзя отличить «ставок не было» от «не загружали». */
  fundingCoverage(symbol: string): TimeRange | null {
    return this.readLines<TimeRange>(this.coveragePath(symbol))[0] ?? null
  }

  private readLines<T>(path: string): T[] {
    let items = this.files.get(path)
    if (!items) {
      items = parseJsonLines(path)
      this.files.set(path, items)
    }
    return items as T[]
  }

  private writeLines(path: string, items: unknown[]): void {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, items.map((item) => JSON.stringify(item)).join('\n') + '\n')
    this.files.set(path, items)
  }

  private candlePath(symbol: string, tf: Timeframe, month: string): string {
    return join(this.root, 'candles', symbol, tf, `${month}.jsonl`)
  }

  private missingPath(symbol: string, tf: Timeframe): string {
    return join(this.root, 'candles', symbol, tf, 'missing.jsonl')
  }

  private fundingPath(symbol: string): string {
    return join(this.root, 'funding', `${symbol}.jsonl`)
  }

  private coveragePath(symbol: string): string {
    return join(this.root, 'funding', `${symbol}.coverage.jsonl`)
  }
}

function monthOf(time: number): string {
  return new Date(time).toISOString().slice(0, 7)
}

function monthsBetween(from: number, to: number): string[] {
  if (from >= to) return []
  const months: string[] = []
  const cursor = new Date(from)
  cursor.setUTCDate(1)
  cursor.setUTCHours(0, 0, 0, 0)
  while (cursor.getTime() < to) {
    months.push(monthOf(cursor.getTime()))
    cursor.setUTCMonth(cursor.getUTCMonth() + 1)
  }
  return months
}

/** Повреждённая строка пропускается: данные будут запрошены заново. */
function parseJsonLines(path: string): unknown[] {
  if (!existsSync(path)) return []
  const items: unknown[] = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    try {
      items.push(JSON.parse(line))
    } catch {
      continue
    }
  }
  return items
}
