// [REVIEW i-code#32] Тексты четырёх типов сообщений из твоей задачи. Функции чистые, поэтому формат проверяется тестами без отправки.
// В сообщение об открытии и закрытии входят сторона, сигнал, цены и причина; картинку прикладывает TelegramNotifier.
import type { ErrorEvent, TradeEditedEvent } from '../../core/ports.js'
import type { ClosedTrade, CloseReason, Position, Side } from '../../core/types.js'

const SIDE_NAMES: Record<Side, string> = { long: 'лонг', short: 'шорт' }
const CLOSE_REASONS: Record<CloseReason, string> = {
  stop: 'стоп',
  take: 'тейк',
  advisor: 'решение Claude',
  end_of_run: 'конец прогона',
}

export function formatOpened(position: Position): string {
  const icon = position.side === 'long' ? '🟢' : '🔴'
  return [
    `${icon} Открыта сделка · ${title(position)}`,
    `Сигнал: ${position.kind}`,
    `Вход: ${position.entryPrice}  Стоп: ${position.stop}  Тейк: ${position.take}`,
    `Причина: ${position.reason}`,
  ].join('\n')
}

export function formatClosed(trade: ClosedTrade): string {
  const icon = trade.pnl >= 0 ? '✅' : '❌'
  return [
    `${icon} Закрыта сделка · ${title(trade)}`,
    `Результат: ${signed(trade.pnl)} USDT (${signed(trade.r)}R)`,
    `Причина закрытия: ${CLOSE_REASONS[trade.closeReason]}`,
    `Сигнал: ${trade.kind}`,
    `Вход: ${trade.entryPrice}  Стоп: ${trade.stop}  Тейк: ${trade.take}  Выход: ${trade.exitPrice}`,
  ].join('\n')
}

export function formatEdited(event: TradeEditedEvent): string {
  const { position, changes, reason } = event
  return [
    `✏️ Сделка отредактирована · ${title(position)}`,
    ...(changes.stop ? [`Стоп: ${changes.stop.was} → ${changes.stop.now}`] : []),
    ...(changes.take ? [`Тейк: ${changes.take.was} → ${changes.take.now}`] : []),
    `Причина: ${reason}`,
  ].join('\n')
}

export function formatError(event: ErrorEvent): string {
  return [`⚠️ Ошибка · ${event.where}`, `Что случилось: ${event.message}`, `Что дальше: ${event.action}`].join('\n')
}

function title(position: Position): string {
  return `${position.symbol} · ${SIDE_NAMES[position.side]}`
}

function signed(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}`
}
