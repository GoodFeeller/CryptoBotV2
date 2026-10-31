# CryptoBot v2

Бот для USDT-перпетуалов Bybit. Код находит рыночные ситуации, а Claude решает, что с ними делать: сторона, цена лимитного входа, плечо, сумма, стоп и тейк. Раз в час Claude ведёт открытую сделку: двигает стоп, двигает тейк или закрывает раньше.

**Сейчас это база.** Настоящих сигналов нет (заглушка `EveryNCandlesDetector`), настоящих ордеров нет: сделки идут через симулятор. Результаты прогонов на заглушке ничего не говорят о доходности.

Спека: [docs/superpowers/specs/2026-10-31-base-design.md](docs/superpowers/specs/2026-10-31-base-design.md)

## Установка

```bash
npm install
```

Для `live`, `notify-test` и режима `--advisor claude` скопируйте `.env.example` в `.env` и заполните.

## Команды

```bash
npm run check
```

Типы, тесты и правила архитектуры.

```bash
npm run backtest -- --from 2026-01-01 --to 2026-02-01 --advisor random-side
```

Бесплатный прогон конвейера со случайной стороной: база для сравнения.

```bash
npm run backtest -- --from 2026-01-01 --to 2026-02-01 --advisor session
```

Бэктест с решениями сессий Claude Code, порядок работы описан в [src/features/claude/README.md](src/features/claude/README.md).

```bash
npm run backtest -- --from 2026-01-01 --to 2026-02-01 --advisor claude --estimate
```

Оценка стоимости прогона через API, запросы не отправляются. Без `--estimate` прогон платный и ограничен `claude.budgetUsd`.

```bash
npm run notify-test
```

Отправляет в Telegram все 4 типа сообщений с пометкой «тест».

```bash
npm run live
```

Бумажный режим: настоящие свечи, Claude и Telegram, сделки через симулятор. Запросы к Claude платные.

Режим проверки: `--mode validation`. Вердикт PASS или FAIL возможен только в нём.

## Карта папок

```text
src/core/                  типы, интерфейсы, правила проверки решений
src/features/market-data/  данные Bybit и кеш
src/features/claude/       решения Claude, обезличивание, промпты
src/features/telegram/     сообщения
src/features/chart/        картинка сделки
src/features/signals/      детекторы ситуаций, сейчас заглушки
src/features/risk/         защита от просадки
src/features/trading/      движок сделок
src/features/backtest/     симулятор и отчёт
src/app/                   сборка и запуск
config/default.json        настройки
data/                      кеш и отчёты, вне git
```

Фичи не импортируют друг друга, общение идёт через интерфейсы `core`. Это проверяет `npm run check`. В каждой папке есть свой `README.md`.

## Что учитывать

- Список монет выбран по данным на 31.10.2026, поэтому на истории он уже знает будущее: результат бэктеста может быть завышен.
- Сессия Claude Code должна работать в отдельной папке без доступа к `data/`, иначе она увидит будущее.
- Сессия и API могут отвечать по-разному. Перед демо-счётом часть решений нужно сверить через API.
- Вход только лимитным post-only ордером, поэтому вход на пробое по цене дальше текущей невозможен.
