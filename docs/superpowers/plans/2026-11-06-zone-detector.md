# Детектор зон: план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** заменить заглушку `EveryNCandlesDetector` детектором, который зовёт Claude, когда цена в зоне в конце исчерпанной волны, и отдаёт ему картину рынка.

**Architecture:** детектор `ZoneDetector` в `src/features/signals`, модули анализа доступны ему через интерфейс `MarketAnalysis` из `core`, реализацию собирает `app/compose`. `SignalDetector.detect` становится асинхронным, `Situation` получает `picture`. Проверка на истории без Claude через `npm run situations`.

**Tech Stack:** TypeScript (ESM, `.js` в импортах), vitest, zod, dependency-cruiser (`npm run check`).

**Spec:** `docs/superpowers/specs/2026-11-06-zone-detector-design.md`

## Global Constraints

- Фичи не импортируют друг друга и `app`; общие типы и интерфейсы только в `src/core` (проверяет `npm run check`).
- `core` не зависит ни от чего вне `src/core`.
- Модули видят только свечи, закрытые к моменту (`closeTime <= at`).
- `kind` ситуации всегда `'zone'`, без тикера и дат.
- Настройки `signals.zone`: `zoneAtr` 0.5, `exhaustedShare` 0.9, `maxAsksPerVisit` 3, `nearbyLevelsAtr` 3, `history` `{ "1d": 600, "1h": 720 }`.
- Уровни считаются по последним 365 дневкам и 720 часовикам.
- `claude.windows` = `{ "5m": 72, "1h": 200, "4h": 100 }`, `claude.promptVersion` = `"v2"`.
- Комментарии и README на русском, в стиле существующих модулей.
- Каждая задача заканчивается зелёным `npm run check`.

## Review Focus

- **Молодая монета без 600 дневок** (HYPE, FARTCOIN): ожидается, что детектор работает без EMA 1d, а не молчит. EMA необязательна: `picture.ema` содержит только таймфреймы, где снимок `ok`. Это уточнение спеки; тест в задаче 3.
- **Нет последней часовой свечи** (пропуск у биржи): детектор возвращает `null` и не падает. Тест в задаче 3.
- **Текущая волна нулевой длины** (разворот только что подтверждён): никакой ситуации, без деления на ноль. Тест в задаче 3.
- **Уровень совпал с серединой волны**: одна зона с двумя причинами. Тест в задаче 2.
- **Повторы по разным монетам независимы**: 3 вопроса по BTC не мешают ETH. Тест в задаче 3.

---

### Task 1: Типы в core, асинхронный detect и картина в ситуации

**Files:**
- Modify: `src/core/types.ts`, `src/core/ports.ts`, `src/core/README.md`
- Modify: `src/features/ema/ema.ts`, `src/features/waves/waves.ts`, `src/features/structure/structure.ts` (типы импортируются из core, реэкспорт не нужен)
- Modify: `src/features/signals/every-n-candles.ts`, `src/features/signals/scripted.ts`, `src/features/trading/engine.ts:212`
- Modify: `src/features/claude/anonymize.ts` (тело ситуации: `{ kind, picture: null }` пока картина не обезличивается)
- Test: `tests/features/signals/detectors.test.ts`, `tests/features/trading/engine.test.ts`, `tests/features/claude/advisors.test.ts`

**Interfaces:**
- Produces в `core/types.ts`: `EmaReading`, `EmaStack`, `EmaSnapshot`, `WaveDirection`, `WavePoint`, `Wave`, `WaveSnapshot`, `Trend`, `StructurePoint`, `StructureSnapshot` (те же поля, что сейчас в модулях); `ZoneReason`, `PictureLevel`, `WavePicture`, `MarketPicture` (поля из раздела «Ситуация» спеки); `Situation { symbol; kind; at; picture: MarketPicture | null }` — поля `levels` и `indicators` удаляются, `PriceLevel` удаляется, если больше не используется.
- Produces в `core/ports.ts`: `MarketAnalysis` (сигнатуры из спеки) и `SignalDetector.detect(ctx: SignalContext): Promise<Situation | null>`.

- [ ] **Step 1:** в `tests/features/signals/detectors.test.ts` заменить ожидания на `await detector.detect(...)` и ситуации вида `{ symbol, kind, at, picture: null }`; в `engine.test.ts:151` литерал ситуации с `picture: null` и асинхронным `detect`; в `advisors.test.ts:90-91` ожидание `expect(body.situation).toEqual({ kind: 'test', picture: null })`.
- [ ] **Step 2:** `npx vitest run tests/features/signals tests/features/trading tests/features/claude` — ожидается FAIL (типы и поля не совпадают).
- [ ] **Step 3:** перенести типы снимков в `core/types.ts`, модули импортируют их оттуда; добавить `MarketAnalysis`, асинхронный `detect`, `Situation.picture`; заглушки возвращают `Promise`; движок `await detector.detect(...)`; обезличивание отдаёт `situation: { kind, picture: null }` (полноценно в задаче 5).
- [ ] **Step 4:** `npm run check` — ожидается PASS, все тесты зелёные, нарушений зависимостей нет.
- [ ] **Step 5:** commit `refactor: snapshot types in core, async detector, situation picture`.

### Task 2: Зоны

**Files:**
- Create: `src/features/signals/zones.ts`
- Test: `tests/features/signals/zones.test.ts`

**Interfaces:**
- Consumes: `Level`, `WaveSnapshot`, `ZoneReason` из core.
- Produces:
  - `interface Zone { price: number; low: number; high: number; reasons: ZoneReason[] }`
  - `buildZones(levels: Level[], bigWaves: WaveSnapshot, atr: number, zoneAtr: number): Zone[]` — кандидаты: только `status === 'active'` уровни и, если `bigWaves.ok`, верх, середина и низ `lastWave`; зона ± `zoneAtr × atr`; пересекающиеся склеиваются (границы объединяются, `price` = середина границ, причины конкатенируются); результат по возрастанию цены.
  - `touches(zone: Zone, candle: Candle): boolean` — `candle.low <= zone.high && candle.high >= zone.low`.
  - `inOuterHalf(zone: Zone, wave: { direction: WaveDirection; start: WavePoint; length: number }): boolean` — вверх: `zone.price >= start.price + length / 2`; вниз: `zone.price <= start.price - length / 2`; при `length === 0` всегда `false`.

- [ ] **Step 1:** тесты: `active levels become zones, traded and broken do not`; `wave top, middle and bottom become zones` (причины `{ type: 'wave', part }`); `a level on the wave middle is one zone with two reasons` (уровень 100 и середина 100.2 при `atr` 1 → одна зона, `reasons` длины 2); `zones farther apart than their widths stay separate`; `touches when the candle range crosses the zone` (минимум внутри, максимум внутри, свеча целиком над зоной → false); `outer half of an up and a down wave`; `a zero-length wave has no outer half`.
- [ ] **Step 2:** `npx vitest run tests/features/signals/zones.test.ts` — FAIL (модуля нет).
- [ ] **Step 3:** реализовать функции по сигнатурам выше.
- [ ] **Step 4:** тот же запуск — PASS.
- [ ] **Step 5:** commit `feat: zones from levels and wave parts`.

### Task 3: ZoneDetector

**Files:**
- Create: `src/features/signals/zone-detector.ts`
- Modify: `src/features/signals/README.md` (таблица детекторов, правила, настройки)
- Test: `tests/features/signals/zone-detector.test.ts`

**Interfaces:**
- Consumes: `buildZones`, `touches`, `inOuterHalf` (задача 2); `MarketData`, `MarketAnalysis`, `SignalDetector` из core; `computeAtr` из `core/atr.js`.
- Produces:
  - `interface ZoneDetectorOptions { zoneAtr: number; exhaustedShare: number; maxAsksPerVisit: number; nearbyLevelsAtr: number; history: { '1d': number; '1h': number } }`
  - `class ZoneDetector implements SignalDetector { readonly isPlaceholder = false; constructor(deps: { market: MarketData; analysis: MarketAnalysis; options: ZoneDetectorOptions }); detect(ctx: SignalContext): Promise<Situation | null> }`

Алгоритм `detect` (порядок проверок, ATR — `computeAtr(hourly, 14)`):
1. Загрузить `1d` × `history['1d']` и `1h` × `history['1h']` через `market.candles(symbol, tf, now, limit)`. Если последней часовой свечи с `closeTime === now` нет, сбросить состояние монеты и вернуть `null`.
2. `levels = analysis.levels(daily.slice(-365), hourly)`; `waves.small/big = analysis.waves(hourly, now, scale)`; `structure = analysis.structure(hourly, now)`; `ema` по 1h и 1d. Если `structure` или обе волны не `ok` — `null`. EMA необязательна.
3. Зоны: `buildZones(levels, waves.big, atr1h, zoneAtr)`, оставить касающиеся последней часовой свечи.
4. Для каждой касающейся зоны найти волну (мелкую или крупную со `ok`), у которой `current.share >= exhaustedShare` и `inOuterHalf(zone, current)`. Нет такой пары — сбросить состояние монеты, `null`.
5. Из подходящих зон взять ближайшую к `current.extreme.price` исчерпанной волны.
6. Повторы: состояние `Map<symbol, { low: number; high: number; asks: number; lastAt: number }>`. Та же зона = границы пересекаются и `lastAt === now - 1h`. Если `asks >= maxAsksPerVisit` — `null` (состояние сохраняется, `lastAt = now`). Иначе `asks + 1` и ситуация.
7. Ситуация `{ symbol, kind: 'zone', at: now, picture }`: уровни в пределах `nearbyLevelsAtr` × ATR(1d) от закрытия, волны, структура, EMA, `atrPct` по 1h и 1d.

- [ ] **Step 1:** тесты с поддельным `MarketAnalysis` (возвращает заданные снимки) и `MarketData` (синтетические свечи): `touch without an exhausted wave gives nothing`; `touch at the end of an exhausted small wave gives a zone situation` (проверить `kind`, `picture.zone.reasons`, `picture.waves.small.current.share`); `big wave exhaustion alone is enough`; `a zone in the inner half of the wave gives nothing`; `traded and broken levels are not zones but are in the picture`; `asks at most 3 times in a row and resets after an hour without touch`; `repeats of one coin do not affect another`; `missing last hourly candle gives nothing`; `a young coin without daily EMA still gets situations, picture has only 1h EMA`; `a zero-length current wave gives nothing`; `not enough waves or structure gives nothing`.
- [ ] **Step 2:** `npx vitest run tests/features/signals/zone-detector.test.ts` — FAIL.
- [ ] **Step 3:** реализовать `ZoneDetector` по алгоритму; README модуля обновить.
- [ ] **Step 4:** тот же запуск — PASS, затем `npm run check` — PASS.
- [ ] **Step 5:** commit `feat: zone detector`.

### Task 4: Подключение: MarketAnalysis, конфиг, compose

**Files:**
- Create: `src/app/market-analysis.ts`
- Modify: `src/app/config.ts`, `config/default.json`, `src/app/compose.ts`, `src/app/run-backtest.ts:127`, `src/app/README.md`
- Test: `tests/app/config.test.ts`, `tests/app/market-analysis.test.ts`

**Interfaces:**
- Consumes: `findLevels`, `combineLevels`, `MAJOR_LEVELS`, `LOCAL_LEVELS` (levels), `emaSnapshot` (ema), `waveSnapshot` (waves), `structureSnapshot` (structure), `ZoneDetector` (задача 3).
- Produces:
  - `createMarketAnalysis(config: AppConfig): MarketAnalysis` — `levels` объединяет основные и локальные как `src/app/levels.ts` (допуск 0.5 × последний ATR дневки); `ema` с `config.ema`; `waves` с `config.waves.swingAtr[scale]`; `structure` с `config.structure`.
  - `createDetector(config: AppConfig, market: MarketData): SignalDetector` — `ZoneDetector` с `config.signals.zone`.
  - Конфиг: секция `signals: { zone: { zoneAtr, exhaustedShare, maxAsksPerVisit, nearbyLevelsAtr, history } }` со значениями из Global Constraints.

- [ ] **Step 1:** тесты: в `config.test.ts` ожидание `cfg.signals.zone` со значениями из Global Constraints; в `market-analysis.test.ts` — `createMarketAnalysis(loadConfig())` на синтетических свечах-зигзаге отдаёт `ok` от `waves` и `structure`, а `levels` возвращает массив уровней.
- [ ] **Step 2:** `npx vitest run tests/app` — FAIL.
- [ ] **Step 3:** реализовать; `createTrading` передаёт `market` в `createDetector`; в `run-backtest.ts` признак заглушки брать у детектора, созданного с тем же `market`.
- [ ] **Step 4:** `npm run check` — PASS.
- [ ] **Step 5:** commit `feat: wire zone detector`.

### Task 5: Claude: обезличивание картины, окно 5m, промпт v2

**Files:**
- Modify: `src/features/claude/anonymize.ts`, `src/features/claude/README.md`
- Create: `src/features/claude/prompts/v2.ts`
- Modify: место выбора промпта по `promptVersion` (там, где сейчас подключается `SYSTEM_PROMPT_V1`), `config/default.json` (`claude.windows`, `claude.promptVersion`), `tests/app/config.test.ts`
- Test: `tests/features/claude/anonymize.test.ts`

**Interfaces:**
- Consumes: `MarketPicture` из core.
- Produces: `AnonEntryBody.situation = { kind: string; picture: AnonPicture | null }`, где `AnonPicture` — `MarketPicture` с ценами в шкале и `structure.highs/lows` как `{ barsAgo: number; price: number }`; `SYSTEM_PROMPT_V2` (содержание из раздела «Claude» спеки).

- [ ] **Step 1:** тесты: `every price in the picture is on the scale` (картина с ценами около 80 000 при текущей 80 000 → зона около 100, EMA, уровни, верх, середина и низ волн, старт волны, максимумы и минимумы — около 100); `no real price leaks into the request` (обход JSON тела: ни одно число не равно ни одной цене исходной картины); `structure points are given as bars ago`; `a situation without a picture stays null`.
- [ ] **Step 2:** `npx vitest run tests/features/claude/anonymize.test.ts` — FAIL.
- [ ] **Step 3:** реализовать обезличивание картины; написать `prompts/v2.ts`; подключить выбор v2 по `promptVersion`; конфиг.
- [ ] **Step 4:** `npm run check` — PASS.
- [ ] **Step 5:** commit `feat: market picture for Claude, prompt v2`.

### Task 6: Прогон на истории `npm run situations`

**Files:**
- Modify: `src/features/chart/levels-chart.ts` (поле `marks`), `tests/features/chart/levels-chart.test.ts`
- Create: `src/app/situations.ts`
- Modify: `package.json` (`"situations": "tsx src/app/situations.ts"`), `src/app/README.md`

**Interfaces:**
- Consumes: `createDetector`, `createRawMarket`, `dataPath` (compose), `ManualClock` и `ClampedMarketData` так же, как в `run-backtest.ts`.
- Produces: `LevelsChartInput.marks?: { time: number; price: number; label: string }[]` — кружок на свече `time` в цене `price` и подпись над ним.

- [ ] **Step 1:** тест графика `draws a mark with its label` (в SVG есть `data-role="mark"` и текст подписи).
- [ ] **Step 2:** `npx vitest run tests/features/chart` — FAIL.
- [ ] **Step 3:** реализовать `marks`; написать `situations.ts`: аргументы `символы`, `from`, `to` (ISO-даты); для каждой монеты идти по закрытиям часов от `from` до `to`, двигать `ManualClock`, вызывать `detector.detect({ symbol, now, candles: {} })`; печатать время, цену зоны, причины, исчерпанную волну и процент, структуру; в конце число ситуаций по монетам; картинка `data/situations/<монета>.png` — часовики периода, зоны ситуаций линиями, метки в местах срабатывания.
- [ ] **Step 4:** `npm run check` — PASS; `npm run situations -- BTCUSDT 2026-10-01 2026-11-01` печатает список и число ситуаций и создаёт картинку.
- [ ] **Step 5:** commit `feat: npm run situations`.
- [ ] **Step 6:** показать пользователю список, число ситуаций в месяц и картинки по BTC, ETH, SOL; пороги `zoneAtr` и `exhaustedShare` менять только по его оценке.
