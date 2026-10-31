import type { Notifier } from '../../core/ports.js'

/** Для бэктеста: тысячи исторических сделок в Telegram не нужны. */
export class NullNotifier implements Notifier {
  async tradeOpened(): Promise<void> {}
  async tradeClosed(): Promise<void> {}
  async tradeEdited(): Promise<void> {}
  async error(): Promise<void> {}
}
