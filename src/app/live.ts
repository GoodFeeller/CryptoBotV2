import { BybitClient } from '../features/market-data/bybit-client.js'
import { createTelegramPost, TelegramNotifier } from '../features/telegram/telegram-notifier.js'
import { loadConfig, loadDotEnv, requireSecret } from './config.js'
import { startLive } from './run-live.js'

loadDotEnv()
const notifier = new TelegramNotifier({
  post: createTelegramPost(requireSecret('TELEGRAM_BOT_TOKEN')),
  chatIds: requireSecret('TELEGRAM_CHAT_ID').split(',').map((id) => id.trim()),
})

console.log('Бумажный режим запущен. Ордера на биржу не отправляются.')
await startLive(loadConfig(), new BybitClient(), notifier)
