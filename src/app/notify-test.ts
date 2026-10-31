import { SvgChartRenderer } from '../features/chart/svg-chart.js'
import { BybitClient } from '../features/market-data/bybit-client.js'
import { createTelegramPost, TelegramNotifier } from '../features/telegram/telegram-notifier.js'
import { createRawMarket } from './compose.js'
import { loadConfig, loadDotEnv, requireSecret } from './config.js'
import { sendNotifyTest } from './run-live.js'

loadDotEnv()
const notifier = new TelegramNotifier({
  post: createTelegramPost(requireSecret('TELEGRAM_BOT_TOKEN')),
  chatIds: requireSecret('TELEGRAM_CHAT_ID').split(',').map((id) => id.trim()),
  prefix: '🧪 тест',
})

await sendNotifyTest({
  notifier,
  chart: new SvgChartRenderer(),
  market: createRawMarket(loadConfig(), new BybitClient(), Date.now),
  now: Date.now(),
})
console.log('Отправлено 4 сообщения. Если их нет в чате, смотрите ошибки выше.')
