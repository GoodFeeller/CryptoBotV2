// [REVIEW i-code#34] Картинка сделки: SVG строит наш код, в PNG переводит resvg. Отказался от библиотек графиков: нужны только свечи и
// три линии, а браузер или canvas утяжелили бы установку. Шкала включает стоп и тейк, поэтому линии всегда видны, даже если
// далеко от свечей. Подписи требуют системного шрифта: без него линии останутся, а текста не будет.
import { Resvg } from '@resvg/resvg-js'
import type { ChartInput, ChartRenderer } from '../../core/ports.js'

const WIDTH = 1000
const HEIGHT = 560
const MARGIN = { top: 40, right: 110, bottom: 20, left: 16 }
const COLORS = {
  background: '#131722',
  text: '#d1d4dc',
  up: '#26a69a',
  down: '#ef5350',
  entry: '#4c8bf5',
  stop: '#ef5350',
  take: '#26a69a',
  exit: '#ffb300',
}

export function buildChartSvg(input: ChartInput): string {
  const { symbol, side, candles, entryPrice, stop, take, exit } = input
  const plotWidth = WIDTH - MARGIN.left - MARGIN.right
  const plotHeight = HEIGHT - MARGIN.top - MARGIN.bottom

  const prices = [entryPrice, stop, take, ...candles.flatMap((candle) => [candle.high, candle.low])]
  if (exit) prices.push(exit.price)
  const rawMin = Math.min(...prices)
  const rawMax = Math.max(...prices)
  const padding = rawMax > rawMin ? (rawMax - rawMin) * 0.03 : Math.max(Math.abs(rawMax) * 0.01, 1)
  const min = rawMin - padding
  const max = rawMax + padding

  const y = (price: number): number => round(MARGIN.top + ((max - price) / (max - min)) * plotHeight)
  const slot = plotWidth / Math.max(candles.length, 1)
  const x = (index: number): number => round(MARGIN.left + slot * (index + 0.5))
  const bodyWidth = Math.max(round(slot * 0.7), 1)

  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">`,
    `<rect width="${WIDTH}" height="${HEIGHT}" fill="${COLORS.background}"/>`,
    text(MARGIN.left, 26, `${symbol} · ${side === 'long' ? 'лонг' : 'шорт'}`, COLORS.text, 18),
  ]

  candles.forEach((candle, index) => {
    const color = candle.close >= candle.open ? COLORS.up : COLORS.down
    const top = y(Math.max(candle.open, candle.close))
    const height = Math.max(round(y(Math.min(candle.open, candle.close)) - top), 1)
    parts.push(
      `<line x1="${x(index)}" x2="${x(index)}" y1="${y(candle.high)}" y2="${y(candle.low)}" stroke="${color}"/>`,
      `<rect data-role="body" x="${round(x(index) - bodyWidth / 2)}" y="${top}" width="${bodyWidth}" height="${height}" fill="${color}"/>`,
    )
  })

  const levels: [string, string, number, string][] = [
    ['entry', 'Вход', entryPrice, COLORS.entry],
    ['stop', 'Стоп', stop, COLORS.stop],
    ['take', 'Тейк', take, COLORS.take],
  ]
  for (const [role, label, price, color] of levels) {
    parts.push(
      `<line data-role="${role}" y1="${y(price)}" y2="${y(price)}" x1="${MARGIN.left}" x2="${WIDTH - MARGIN.right}" stroke="${color}" stroke-dasharray="6 4"/>`,
      text(WIDTH - MARGIN.right + 6, y(price) + 4, `${label} ${price}`, color, 13),
    )
  }

  if (exit) {
    const found = candles.findLastIndex((candle) => candle.openTime <= exit.time)
    const index = found === -1 ? Math.max(candles.length - 1, 0) : found
    parts.push(`<circle data-role="exit" cx="${x(index)}" cy="${y(exit.price)}" r="6" fill="${COLORS.exit}"/>`)
  }

  parts.push('</svg>')
  return parts.join('')
}

export class SvgChartRenderer implements ChartRenderer {
  async render(input: ChartInput): Promise<Uint8Array> {
    const svg = buildChartSvg(input)
    const image = new Resvg(svg, { font: { loadSystemFonts: true } }).render()
    return new Uint8Array(image.asPng())
  }
}

function text(x: number, y: number, content: string, color: string, size: number): string {
  return `<text x="${x}" y="${round(y)}" fill="${color}" font-size="${size}" font-family="Arial, DejaVu Sans, sans-serif">${escapeXml(content)}</text>`
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function round(value: number): number {
  return Number(value.toFixed(2))
}
