// [REVIEW i-code#33] Отправка в Telegram. Сбой не должен мешать торговле, поэтому метод не бросает ошибку: до 3 повторов, затем запись
// в лог. На 429 ждём столько, сколько просит Telegram. Один недоступный чат не мешает остальным. Без parse_mode: текст от Claude
// может содержать символы разметки, и Telegram отклонил бы такое сообщение.
import type { ErrorEvent, Notifier, TradeClosedEvent, TradeEditedEvent, TradeOpenedEvent } from '../../core/ports.js'
import { formatClosed, formatEdited, formatError, formatOpened } from './messages.js'

const MAX_RETRIES = 3
const RETRY_PAUSE_MS = 1000
const CAPTION_LIMIT = 1024
const TEXT_LIMIT = 4096

export interface TelegramResponse {
  ok: boolean
  error_code?: number
  description?: string
  parameters?: { retry_after?: number }
}

export type TelegramPost = (method: string, fields: Record<string, unknown>) => Promise<TelegramResponse>

export function createTelegramPost(token: string): TelegramPost {
  return async (method, fields) => {
    const form = new FormData()
    for (const [name, value] of Object.entries(fields)) {
      if (value instanceof Uint8Array) form.set(name, new Blob([Buffer.from(value)], { type: 'image/png' }), 'chart.png')
      else form.set(name, String(value))
    }
    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', body: form })
    return (await response.json()) as TelegramResponse
  }
}

export interface TelegramNotifierOptions {
  post: TelegramPost
  chatIds: string[]
  sleep?: (ms: number) => Promise<void>
  /** Первая строка каждого сообщения, например пометка «тест». */
  prefix?: string
}

export class TelegramNotifier implements Notifier {
  private readonly sleep: (ms: number) => Promise<void>

  constructor(private readonly options: TelegramNotifierOptions) {
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  }

  tradeOpened(event: TradeOpenedEvent): Promise<void> {
    return this.send(formatOpened(event.position), event.chart)
  }

  tradeClosed(event: TradeClosedEvent): Promise<void> {
    return this.send(formatClosed(event.trade), event.chart)
  }

  tradeEdited(event: TradeEditedEvent): Promise<void> {
    return this.send(formatEdited(event), null)
  }

  error(event: ErrorEvent): Promise<void> {
    return this.send(formatError(event), null)
  }

  private async send(body: string, chart: Uint8Array | null): Promise<void> {
    const text = this.options.prefix ? `${this.options.prefix}\n${body}` : body
    for (const chatId of this.options.chatIds) {
      const [method, fields]: [string, Record<string, unknown>] = chart
        ? ['sendPhoto', { chat_id: chatId, photo: chart, caption: text.slice(0, CAPTION_LIMIT) }]
        : ['sendMessage', { chat_id: chatId, text: text.slice(0, TEXT_LIMIT) }]
      await this.deliver(method, fields)
    }
  }

  private async deliver(method: string, fields: Record<string, unknown>): Promise<void> {
    let problem = ''
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await this.options.post(method, fields)
        if (response.ok) return
        problem = response.description ?? `код ${response.error_code}`
        if (attempt < MAX_RETRIES) {
          const retryAfter = response.parameters?.retry_after
          await this.sleep(retryAfter ? retryAfter * 1000 : RETRY_PAUSE_MS)
        }
      } catch (error) {
        problem = error instanceof Error ? error.message : String(error)
        if (attempt < MAX_RETRIES) await this.sleep(RETRY_PAUSE_MS)
      }
    }
    console.error(`Telegram: сообщение в чат ${String(fields.chat_id)} не доставлено: ${problem}`)
  }
}
