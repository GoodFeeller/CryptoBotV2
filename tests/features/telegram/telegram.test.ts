import { describe, expect, it } from 'vitest'
import type { ClosedTrade, Position } from '../../../src/core/types.js'
import { formatClosed, formatEdited, formatError, formatOpened } from '../../../src/features/telegram/messages.js'
import { TelegramNotifier, type TelegramPost } from '../../../src/features/telegram/telegram-notifier.js'

const LONG: Position = {
  id: 'p1',
  symbol: 'BTCUSDT',
  side: 'long',
  kind: 'подход к уровню',
  qty: 1,
  leverage: 5,
  entryPrice: 100,
  initialStop: 95,
  stop: 95,
  take: 110,
  openedAt: 0,
  reason: 'отбой от уровня',
}

const WIN: ClosedTrade = {
  ...LONG,
  exitPrice: 110,
  closedAt: 1,
  closeReason: 'take',
  pnl: 9.5,
  r: 1.9,
  fees: 0.5,
  slippageCost: 0,
  funding: 0,
}

describe('messages', () => {
  it('formats an opened trade', () => {
    expect(formatOpened(LONG)).toBe(
      '🟢 Открыта сделка · BTCUSDT · лонг\nСигнал: подход к уровню\nВход: 100  Стоп: 95  Тейк: 110\nПричина: отбой от уровня',
    )
    expect(formatOpened({ ...LONG, side: 'short' })).toContain('🔴 Открыта сделка · BTCUSDT · шорт')
  })

  it('formats a winning and a losing close', () => {
    expect(formatClosed(WIN)).toBe(
      '✅ Закрыта сделка · BTCUSDT · лонг\nРезультат: +9.50 USDT (+1.90R)\nПричина закрытия: тейк\nСигнал: подход к уровню\nВход: 100  Стоп: 95  Тейк: 110  Выход: 110',
    )
    const loss = formatClosed({ ...WIN, side: 'short', closeReason: 'stop', pnl: -5.2, r: -1.04 })
    expect(loss).toContain('❌ Закрыта сделка · BTCUSDT · шорт')
    expect(loss).toContain('Результат: -5.20 USDT (-1.04R)')
    expect(loss).toContain('Причина закрытия: стоп')
    expect(formatClosed({ ...WIN, closeReason: 'advisor' })).toContain('решение Claude')
    expect(formatClosed({ ...WIN, closeReason: 'end_of_run' })).toContain('конец прогона')
  })

  it('formats an edit, only changed fields', () => {
    expect(formatEdited({ position: LONG, changes: { stop: { was: 95, now: 98 }, take: { was: 110, now: 112 } }, reason: 'тренд' })).toBe(
      '✏️ Сделка отредактирована · BTCUSDT · лонг\nСтоп: 95 → 98\nТейк: 110 → 112\nПричина: тренд',
    )
    const onlyTake = formatEdited({ position: LONG, changes: { take: { was: 110, now: 112 } }, reason: 'r' })
    expect(onlyTake).not.toContain('Стоп')
  })

  it('formats an error', () => {
    expect(formatError({ where: 'вход BTCUSDT', message: 'нет ответа', action: 'сделка не открыта' })).toBe(
      '⚠️ Ошибка · вход BTCUSDT\nЧто случилось: нет ответа\nЧто дальше: сделка не открыта',
    )
  })
})

describe('TelegramNotifier', () => {
  function setup(respond: TelegramPost = async () => ({ ok: true })) {
    const calls: { method: string; fields: Record<string, unknown> }[] = []
    const sleeps: number[] = []
    const post: TelegramPost = async (method, fields) => {
      calls.push({ method, fields })
      return respond(method, fields)
    }
    const notifier = new TelegramNotifier({
      post,
      chatIds: ['1', '2'],
      sleep: async (ms) => {
        sleeps.push(ms)
      },
    })
    return { notifier, calls, sleeps }
  }

  const PHOTO = new Uint8Array([1, 2])

  it('sends opened and closed with a photo to every chat', async () => {
    const { notifier, calls } = setup()

    await notifier.tradeOpened({ position: LONG, chart: PHOTO })
    await notifier.tradeClosed({ trade: WIN, chart: PHOTO })

    expect(calls.map((c) => [c.method, c.fields.chat_id])).toEqual([
      ['sendPhoto', '1'],
      ['sendPhoto', '2'],
      ['sendPhoto', '1'],
      ['sendPhoto', '2'],
    ])
    expect(calls[0]?.fields.photo).toBe(PHOTO)
    expect(calls[0]?.fields.caption).toBe(formatOpened(LONG))
  })

  it('sends text when there is no chart', async () => {
    const { notifier, calls } = setup()

    await notifier.tradeOpened({ position: LONG, chart: null })

    expect(calls[0]).toMatchObject({ method: 'sendMessage', fields: { text: formatOpened(LONG) } })
  })

  it('a long caption is cut to the Telegram limit', async () => {
    const { notifier, calls } = setup()

    await notifier.tradeOpened({ position: { ...LONG, reason: 'я'.repeat(2000) }, chart: PHOTO })

    expect((calls[0]?.fields.caption as string).length).toBe(1024)
  })

  it('edit and error are text messages', async () => {
    const { notifier, calls } = setup()

    await notifier.tradeEdited({ position: LONG, changes: {}, reason: 'r' })
    await notifier.error({ where: 'a', message: 'b', action: 'c' })

    expect(calls.every((c) => c.method === 'sendMessage')).toBe(true)
  })

  it('adds a prefix for test messages', async () => {
    const calls: Record<string, unknown>[] = []
    const notifier = new TelegramNotifier({
      post: async (_method, fields) => {
        calls.push(fields)
        return { ok: true }
      },
      chatIds: ['1'],
      prefix: 'тест',
    })

    await notifier.error({ where: 'a', message: 'b', action: 'c' })

    expect(calls[0]?.text).toMatch(/^тест\n/)
  })

  it('on 429 waits retry_after, then retries', async () => {
    let attempts = 0
    const { notifier, calls, sleeps } = setup(async () => {
      attempts++
      return attempts === 1 ? { ok: false, error_code: 429, parameters: { retry_after: 7 } } : { ok: true }
    })

    await notifier.error({ where: 'a', message: 'b', action: 'c' })

    expect(sleeps).toEqual([7000])
    expect(calls).toHaveLength(3) // первый чат дважды, второй один раз
  })

  it('after 3 retries gives up without throwing, other chats still receive', async () => {
    const failed: unknown[] = []
    const { notifier, calls } = setup(async (_method, fields) => {
      if (fields.chat_id === '1') {
        failed.push(fields.chat_id)
        return { ok: false, description: 'bad' }
      }
      return { ok: true }
    })

    await expect(notifier.error({ where: 'a', message: 'b', action: 'c' })).resolves.toBeUndefined()

    expect(failed).toHaveLength(4)
    expect(calls.at(-1)?.fields.chat_id).toBe('2')
  })

  it('a thrown network error is retried too', async () => {
    let attempts = 0
    const { notifier, calls } = setup(async () => {
      attempts++
      if (attempts === 1) throw new Error('network')
      return { ok: true }
    })

    await notifier.error({ where: 'a', message: 'b', action: 'c' })

    expect(calls).toHaveLength(3)
  })
})
