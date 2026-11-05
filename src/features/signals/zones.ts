// Зоны — области ценности из видео: активные уровни и верх, середина и низ последней крупной волны. Цена зоны размывается
// на ± zoneAtr ATR часовика, потому что уровень это область, а не тонкая линия. Пересекающиеся зоны склеиваются: если уровень
// совпал с серединой волны, Claude увидит одну зону с двумя причинами.
import type { Candle, Level, WaveDirection, WavePoint, WaveSnapshot, ZoneReason } from '../../core/types.js'

export interface Zone {
  price: number
  low: number
  high: number
  reasons: ZoneReason[]
}

export function buildZones(levels: Level[], bigWaves: WaveSnapshot, atr: number, zoneAtr: number): Zone[] {
  const half = zoneAtr * atr
  const candidates: { price: number; reason: ZoneReason }[] = levels
    .filter((level) => level.status === 'active')
    .map((level) => ({ price: level.price, reason: { type: 'level', class: level.class, bounces: level.bounces, flips: level.flips } }))
  if (bigWaves.ok) {
    const { top, middle, bottom } = bigWaves.lastWave
    candidates.push(
      { price: top, reason: { type: 'wave', part: 'top' } },
      { price: middle, reason: { type: 'wave', part: 'middle' } },
      { price: bottom, reason: { type: 'wave', part: 'bottom' } },
    )
  }

  const zones: Zone[] = []
  for (const { price, reason } of candidates.sort((a, b) => a.price - b.price)) {
    const last = zones.at(-1)
    if (last && price - half <= last.high) {
      last.high = Math.max(last.high, price + half)
      last.price = (last.low + last.high) / 2
      last.reasons.push(reason)
    } else {
      zones.push({ price, low: price - half, high: price + half, reasons: [reason] })
    }
  }
  return zones
}

export function touches(zone: Zone, candle: Candle): boolean {
  return candle.low <= zone.high && candle.high >= zone.low
}

/** Зона во внешней половине волны, то есть там, куда волна пришла, а не позади движения. */
export function inOuterHalf(zone: Zone, wave: { direction: WaveDirection; start: WavePoint; length: number }): boolean {
  if (wave.length === 0) return false
  const middle = wave.direction === 'up' ? wave.start.price + wave.length / 2 : wave.start.price - wave.length / 2
  return wave.direction === 'up' ? zone.price >= middle : zone.price <= middle
}
