// [REVIEW i-code#43] Картинка уровней с теми же пометками, что на твоём скриншоте: линии, стрелки на отскоках, овалы на ложных пробоях,
// прямоугольники проторговок. Шкала строится только по свечам: уровень далеко от цены не сжимает график и не рисуется.
// Линия начинается с момента подтверждения уровня, поэтому на картинке видно, что код знал в каждый момент.
import { Resvg } from '@resvg/resvg-js'
import type { Candle, Level } from '../../core/types.js'

const WIDTH = 1500
const HEIGHT = 860
const MARGIN = { top: 44, right: 300, bottom: 28, left: 16 }
const LABEL_HEIGHT = 18
/** Неактивный уровень рисуется серым пунктиром, а подпись говорит почему. */
const STATUS_LABEL: Record<Level['status'], string> = { active: '', traded: ' · проторгован', broken: ' · пробит' }

const COLORS = {
  background: '#131722',
  text: '#d1d4dc',
  muted: '#787b86',
  up: '#26a69a',
  down: '#ef5350',
  major: '#ff9800',
  local: '#4fc3f7',
  bounceAbove: '#4c8bf5',
  bounceBelow: '#e040fb',
  falseBreak: '#ffffff',
  zone: '#ff5252',
}

/** Линия поверх свечей, например EMA. Значения идут по свечам, undefined там, где значения нет. */
export interface ChartLine {
  label: string
  color: string
  values: (number | undefined)[]
}

export interface LevelsChartInput {
  title: string
  candles: Candle[]
  levels: Level[]
  lines?: ChartLine[]
}

export function buildLevelsSvg({ title, candles, levels, lines = [] }: LevelsChartInput): string {
  const plotWidth = WIDTH - MARGIN.left - MARGIN.right
  const plotHeight = HEIGHT - MARGIN.top - MARGIN.bottom
  // Шкала включает и линии: иначе далёкая EMA ушла бы за край картинки.
  const lineValues = lines.flatMap((line) => line.values.slice(0, candles.length).filter((value) => value !== undefined))
  const lows = [...candles.map((candle) => candle.low), ...lineValues]
  const highs = [...candles.map((candle) => candle.high), ...lineValues]
  const rawMin = lows.length ? Math.min(...lows) : 0
  const rawMax = highs.length ? Math.max(...highs) : 1
  const padding = (rawMax - rawMin || 1) * 0.04
  const min = rawMin - padding
  const max = rawMax + padding

  const y = (price: number): number => round(MARGIN.top + ((max - price) / (max - min)) * plotHeight)
  const slot = plotWidth / Math.max(candles.length, 1)
  const xOfIndex = (index: number): number => round(MARGIN.left + slot * (index + 0.5))
  const xOfTime = (time: number): number => {
    const index = candles.findIndex((candle) => candle.closeTime > time)
    return index === -1 ? xOfIndex(candles.length - 1) : xOfIndex(index)
  }
  const bodyWidth = Math.max(round(slot * 0.7), 1)

  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">`,
    `<rect width="${WIDTH}" height="${HEIGHT}" fill="${COLORS.background}"/>`,
    label(MARGIN.left, 28, title, COLORS.text, 20),
  ]
  if (levels.length > 0) {
    parts.push(label(WIDTH - MARGIN.right - 470, 28, '▲ отскок сверху   ▼ отскок снизу   ○ ложный пробой   ▭ проторговка', COLORS.muted, 13))
  }

  const visible = levels
    .filter((level) => level.price >= min && level.price <= max)
    .sort((a, b) => b.price - a.price)

  for (const level of visible) {
    for (const zone of level.zones) {
      if (candles.length === 0 || zone.to <= candles[0]!.openTime) continue
      const top = y(Math.min(zone.high, max))
      const left = xOfTime(zone.from)
      parts.push(
        `<rect data-role="zone" x="${left}" y="${top}" width="${Math.max(round(xOfTime(zone.to) - left), 2)}" height="${Math.max(round(y(Math.max(zone.low, min)) - top), 2)}" fill="none" stroke="${COLORS.zone}"/>`,
      )
    }
  }

  candles.forEach((candle, index) => {
    const color = candle.close >= candle.open ? COLORS.up : COLORS.down
    const top = y(Math.max(candle.open, candle.close))
    const height = Math.max(round(y(Math.min(candle.open, candle.close)) - top), 1)
    parts.push(
      `<line x1="${xOfIndex(index)}" x2="${xOfIndex(index)}" y1="${y(candle.high)}" y2="${y(candle.low)}" stroke="${color}"/>`,
      `<rect x="${round(xOfIndex(index) - bodyWidth / 2)}" y="${top}" width="${bodyWidth}" height="${height}" fill="${color}"/>`,
    )
  })

  let lastLabelY = -Infinity
  const lastValue = (line: ChartLine): number | undefined => line.values.slice(0, candles.length).findLast((value) => value !== undefined)
  // Подписи идут сверху вниз, как и линии справа, иначе сдвиг от наложения их перепутал бы.
  const byHeight = [...lines].sort((a, b) => (lastValue(b) ?? 0) - (lastValue(a) ?? 0))
  for (const line of byHeight) {
    const points = candles.flatMap((_, index) => {
      const value = line.values[index]
      return value === undefined ? [] : [`${xOfIndex(index)},${y(value)}`]
    })
    if (points.length === 0) continue
    parts.push(`<polyline data-role="line" points="${points.join(' ')}" fill="none" stroke="${line.color}" stroke-width="2"/>`)
    const last = lastValue(line)!
    const labelY = Math.max(y(last) + 4, lastLabelY + LABEL_HEIGHT)
    lastLabelY = labelY
    parts.push(label(WIDTH - MARGIN.right + 6, labelY, `${line.label} · ${formatPrice(last)}`, line.color, 13))
  }

  for (const level of visible) {
    const major = level.class === 'major'
    const traded = level.status !== 'active'
    const color = traded ? COLORS.muted : major ? COLORS.major : COLORS.local
    const lineY = y(level.price)
    const width = major ? 2 : 1
    const style = traded || !major ? `stroke-width="${width}" stroke-dasharray="6 4"` : `stroke-width="${width}"`
    parts.push(
      `<line data-role="level-${level.class}" x1="${xOfTime(level.bornAt)}" x2="${WIDTH - MARGIN.right}" y1="${lineY}" y2="${lineY}" stroke="${color}" ${style}/>`,
    )

    const labelY = Math.max(lineY + 4, lastLabelY + LABEL_HEIGHT)
    lastLabelY = labelY
    parts.push(label(WIDTH - MARGIN.right + 6, labelY, `${formatPrice(level.price)} · отскоков ${level.bounces}${level.flips ? ' · зерк.' : ''}${STATUS_LABEL[level.status]}`, color, 13))

    for (const event of level.events) {
      if (candles.length === 0 || event.time < candles[0]!.openTime) continue
      const x = xOfTime(event.time)
      if (event.type === 'false_break') {
        parts.push(`<ellipse data-role="false-break" cx="${x}" cy="${lineY}" rx="9" ry="14" fill="none" stroke="${COLORS.falseBreak}"/>`)
      } else if (event.side === 'above') {
        parts.push(`<path data-role="bounce" d="M${x} ${lineY + 4} l-6 10 h12 z" fill="${COLORS.bounceAbove}"/>`)
      } else {
        parts.push(`<path data-role="bounce" d="M${x} ${lineY - 4} l-6 -10 h12 z" fill="${COLORS.bounceBelow}"/>`)
      }
    }
  }

  parts.push('</svg>')
  return parts.join('')
}

export function renderLevelsPng(input: LevelsChartInput): Uint8Array {
  const image = new Resvg(buildLevelsSvg(input), { font: { loadSystemFonts: true } }).render()
  return new Uint8Array(image.asPng())
}

function label(x: number, y: number, content: string, color: string, size: number): string {
  return `<text x="${x}" y="${round(y)}" fill="${color}" font-size="${size}" font-family="Arial, DejaVu Sans, sans-serif">${escapeXml(content)}</text>`
}

function formatPrice(price: number): string {
  return String(Number(price.toPrecision(6)))
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function round(value: number): number {
  return Number(value.toFixed(2))
}
