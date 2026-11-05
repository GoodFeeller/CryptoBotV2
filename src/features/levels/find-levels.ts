// [REVIEW i-code#42] Поиск уровней по правилам из спеки уровней. Чистая функция: видит только переданные свечи, поэтому при подаче истории
// до момента T не может знать будущего. Уровень не отменяется пробоем: цена может ходить сквозь него, как на скриншоте. Отскок
// засчитывается, только когда цена реально ушла от уровня, иначе дрожание у цены давало бы десятки ложных отскоков. Все пороги
// в ATR, чтобы одни и те же настройки работали на BTC и на мелких монетах. Значения подобраны как начальные и будут уточняться по картинкам.
import { computeAtr } from '../../core/atr.js'
import { findPivots } from '../../core/pivots.js'
import type { Candle, Level, LevelClass, LevelEvent, LevelOrigin, LevelZone } from '../../core/types.js'

export interface LevelOptions {
  levelClass: LevelClass
  atrPeriod: number
  /** Минимальный размер волны для разворота. */
  swingAtr: number
  /** Кандидаты ближе этого склеиваются в один уровень. */
  clusterAtr: number
  /** На таком расстоянии цена считается у уровня. */
  touchAtr: number
  /** Закрытие дальше этого за уровнем считается закрытием за ним: из таких складываются ложные пробои и пробои. */
  closeBeyondAtr: number
  /** Так далеко цена должна уйти, чтобы касание стало отскоком. */
  departAtr: number
  /** Глубже этого касание тенью считается ложным пробоем. */
  falseBreakAtr: number
  /** Столько закрытий подряд за уровнем это пробой. */
  breakCloses: number
  paranormalAtr: number
  consolidationBars: number
  consolidationTouches: number
  consolidationAtr: number
  consolidationMaxRangeAtr: number
  /** Столько пересечений уровня ценой закрытия за один эпизод делают его проторгованным. */
  tradedCrossings: number
  tradedNearAtr: number
  /** Столько свечей подряд вдали от уровня завершают эпизод проторговки. */
  tradedAwayBars: number
  /** Подтверждение: после касания цена уходит на confirmAtr не дольше чем за confirmWithinBars свечей. */
  confirmAtr: number
  confirmWithinBars: number
  /** Второе подтверждение: столько обычных отскоков подряд с одной стороны, когда цена ушла от проторговки на confirmAtr и вернулась. */
  confirmBounces: number
  /** Столько закрытий подряд за уровнем делают пробой настоящим. Меньше и возврат назад это неудачная попытка пробить уровень. */
  heldCloses: number
  /** Уровень пробит, если после настоящего пробоя цена ушла от него так далеко, а отскока с тех пор не было. */
  brokenAtr: number
  /** Уровень, который пробивают чаще, чем он держит, не показывается. */
  maxFlipShare: number
  minBounces: number
  maxLevels: number
  /** Уровни ближе этого не показываются вместе: остаётся сильнейший. */
  minGapAtr: number
}

export const MAJOR_LEVELS: LevelOptions = {
  levelClass: 'major',
  atrPeriod: 14,
  swingAtr: 2,
  clusterAtr: 0.5,
  touchAtr: 0.2,
  closeBeyondAtr: 0.25,
  departAtr: 1,
  falseBreakAtr: 0.5,
  breakCloses: 2,
  heldCloses: 3,
  paranormalAtr: 2,
  consolidationBars: 10,
  consolidationTouches: 3,
  consolidationAtr: 0.15,
  consolidationMaxRangeAtr: 2.5,
  tradedCrossings: 5,
  tradedNearAtr: 1,
  tradedAwayBars: 3,
  confirmAtr: 2,
  confirmWithinBars: 5,
  confirmBounces: 2,
  brokenAtr: 1,
  maxFlipShare: 0.5,
  minBounces: 2,
  maxLevels: 6,
  minGapAtr: 1.5,
}

export const LOCAL_LEVELS: LevelOptions = { ...MAJOR_LEVELS, levelClass: 'local', maxLevels: 6 }

const ORIGIN_BONUS: Record<LevelOrigin, number> = { pivot: 0, paranormal_bar: 0.5, consolidation: 1, trend_break: 1 }
const FALSE_BREAK_BONUS = 0.5
const FLIP_BONUS = 1.5
/** Соседние проторговки склеиваются, только если общий прямоугольник не вырастает сильно. */
const ZONE_MERGE_GROWTH = 1.3

type Side = LevelEvent['side']

interface Candidate {
  price: number
  /** Свеча, с которой начинается подсчёт. */
  index: number
  /** Свеча, на которой кандидат стал известен. */
  confirmedIndex: number
  side: Side
  origin: LevelOrigin
  zone?: LevelZone
}

export function findLevels(candles: Candle[], options: LevelOptions): Level[] {
  if (candles.length <= options.atrPeriod) return []

  const atr = computeAtr(candles, options.atrPeriod)
  const candidates = [...pivotCandidates(candles, atr, options), ...consolidationCandidates(candles, atr, options)]
  const typicalAtr = median(atr)
  const levels = groupCandidates(candidates, options.clusterAtr * typicalAtr)
    .map((group) => buildLevel(group, candles, atr, options))
    .filter((level) => level.bounces >= options.minBounces)
    .sort((a, b) => b.strength - a.strength || a.price - b.price)

  // Интервал проверяется и с отброшенными уровнями: ненадёжный уровень не должен пропускать своего слабого соседа.
  const spaced: Level[] = []
  for (const level of levels) {
    if (spaced.every((other) => Math.abs(other.price - level.price) >= options.minGapAtr * typicalAtr)) spaced.push(level)
  }
  return spaced.filter((level) => level.flips <= level.bounces * options.maxFlipShare).slice(0, options.maxLevels)
}

/** Убирает локальные уровни, совпавшие с основными. */
export function combineLevels(major: Level[], local: Level[], tolerance: number): Level[] {
  const separate = local.filter((item) => major.every((level) => Math.abs(level.price - item.price) > tolerance))
  return [...major, ...separate]
}

function pivotCandidates(candles: Candle[], atr: number[], options: LevelOptions): Candidate[] {
  const pivots = findPivots(candles, atr, options.swingAtr)
  const candidates: Candidate[] = []

  pivots.forEach((pivot, k) => {
    const candle = candles[pivot.index]!
    const side: Side = pivot.type === 'low' ? 'above' : 'below'
    const base = { price: pivot.price, index: pivot.index, side }
    candidates.push({ ...base, confirmedIndex: pivot.confirmedIndex, origin: 'pivot' })

    const previousAtr = atr[pivot.index - 1] ?? atr[pivot.index]!
    if (candle.high - candle.low >= options.paranormalAtr * previousAtr) {
      candidates.push({ ...base, confirmedIndex: pivot.confirmedIndex, origin: 'paranormal_bar' })
    }

    const previous = pivots[k - 1]
    const next = pivots[k + 1]
    const brokeOut = previous && next && (pivot.type === 'low' ? next.price > previous.price : next.price < previous.price)
    if (brokeOut) candidates.push({ ...base, confirmedIndex: next.confirmedIndex, origin: 'trend_break' })
  })
  return candidates
}

function consolidationCandidates(candles: Candle[], atr: number[], options: LevelOptions): Candidate[] {
  const { consolidationBars, consolidationTouches, consolidationAtr } = options
  const candidates: Candidate[] = []
  const extremes: { side: Side; value: (candle: Candle) => number }[] = [
    { side: 'above', value: (candle) => candle.low },
    { side: 'below', value: (candle) => candle.high },
  ]

  for (let i = consolidationTouches - 1; i < candles.length; i++) {
    for (const { side, value } of extremes) {
      const price = value(candles[i]!)
      const tolerance = consolidationAtr * atr[i]!
      const touches: number[] = []
      for (let j = Math.max(0, i - consolidationBars + 1); j <= i; j++) {
        if (Math.abs(value(candles[j]!) - price) <= tolerance) touches.push(j)
      }
      if (touches.length < consolidationTouches) continue

      // Проторговка упирается в цену: это край окна, а не случайная цена в его середине.
      const windowExtremes = candles.slice(touches[0]!, i + 1).map(value)
      const edge = side === 'above' ? Math.min(...windowExtremes) : Math.max(...windowExtremes)
      if (Math.abs(price - edge) > tolerance) continue

      const first = candles[touches[0]!]!
      const window = candles.slice(touches[0]!, i + 1)
      const low = Math.min(...window.map((candle) => candle.low))
      const high = Math.max(...window.map((candle) => candle.high))
      candidates.push({
        price,
        index: touches[0]!,
        confirmedIndex: i,
        side,
        origin: 'consolidation',
        // Прямоугольник только вокруг настоящего боковика: большое движение внутри окна проторговкой не считаем.
        ...(high - low <= options.consolidationMaxRangeAtr * atr[i]!
          ? { zone: { from: first.openTime, to: candles[i]!.closeTime, low, high } }
          : {}),
      })
    }
  }
  return candidates
}

function groupCandidates(candidates: Candidate[], tolerance: number): Candidate[][] {
  const sorted = [...candidates].sort((a, b) => a.price - b.price)
  const groups: Candidate[][] = []
  for (const candidate of sorted) {
    const group = groups.at(-1)
    const fits = group && candidate.price - group[group.length - 1]!.price <= tolerance && candidate.price - group[0]!.price <= 2 * tolerance
    if (fits) group.push(candidate)
    else groups.push([candidate])
  }
  return groups
}

function buildLevel(group: Candidate[], candles: Candle[], atr: number[], options: LevelOptions): Level {
  const price = Number(median(group.map((candidate) => candidate.price)).toPrecision(8))
  const earliest = group.reduce((first, candidate) => (candidate.index < first.index ? candidate : first))
  const confirmedIndex = Math.min(...group.map((candidate) => candidate.confirmedIndex))
  const { events, flips, traded, broken } = walkLevel(price, earliest.index, earliest.side, candles, atr, options)
  const origins = [...new Set(group.map((candidate) => candidate.origin))]
  const bounces = events.length
  const falseBreaks = events.filter((event) => event.type === 'false_break').length

  return {
    class: options.levelClass,
    price,
    status: broken ? 'broken' : traded ? 'traded' : 'active',
    origins,
    bornAt: candles[confirmedIndex]!.closeTime,
    bounces,
    falseBreaks,
    flips,
    strength:
      bounces +
      falseBreaks * FALSE_BREAK_BONUS +
      flips * FLIP_BONUS +
      origins.reduce((sum, origin) => sum + ORIGIN_BONUS[origin], 0),
    events,
    zones: mergeZones(group.flatMap((candidate) => (candidate.zone ? [candidate.zone] : []))),
  }
}

/** Проходит свечи слева направо и считает, что цена делала у уровня. */
function walkLevel(
  price: number,
  start: number,
  startSide: Side,
  candles: Candle[],
  atr: number[],
  options: LevelOptions,
): { events: LevelEvent[]; flips: number; traded: boolean; broken: boolean } {
  const events: LevelEvent[] = []
  let side = startSide
  let armed = true
  let pending: LevelEvent | null = null
  let touchIndex = start
  // Касание, которое ещё может подтвердить уровень быстрым уходом от него.
  let confirmingTouch: number | null = null
  let closesBeyond = 0
  let brokenSinceLastBounce = false
  // Статус «пробит» считается отдельно от смены стороны. Смена стороны это только попытка пробоя: если цена вернулась раньше,
  // чем закрылась за уровнем heldCloses раз, уровень устоял. Пробит он, когда пробой настоящий и цена ушла от уровня на brokenAtr.
  let broken = false
  let far = false
  let attempt: { broken: boolean; far: boolean } | null = null
  let closesOnNewSide = 0
  let flips = 0
  let crossings = 0
  let barsAway = 0
  let traded = false
  // Отскоки, которые цена дала уровню после проторговки, пока его снова не пересекли. Считаются, только когда цена сначала ушла
  // от уровня на confirmAtr: отскоки на выходе из боковика это ещё сама проторговка.
  let bouncesSinceTraded = 0
  let leftSinceTraded = false

  for (let i = start; i < candles.length; i++) {
    const candle = candles[i]!
    const tolerance = options.closeBeyondAtr * atr[i]!
    const above = side === 'above'
    const piercedBy = above ? price - candle.low : candle.high - price
    const closedBeyond = above ? candle.close < price - tolerance : candle.close > price + tolerance
    const distance = Math.abs(candle.close - price)
    // Проторговка это цена, которая в одном эпизоде ходит сквозь уровень туда и обратно. Редкие визиты за год не складываются,
    // а просто постоять рядом недостаточно: у сильного уровня цена тоже задерживается.
    if (distance <= options.tradedNearAtr * atr[i]!) {
      barsAway = 0
      const previousClose = candles[i - 1]?.close ?? candle.close
      if (previousClose > price !== candle.close > price) {
        crossings++
        bouncesSinceTraded = 0
        leftSinceTraded = false
      }
      if (crossings >= options.tradedCrossings) traded = true
    } else if (++barsAway >= options.tradedAwayBars) {
      crossings = 0
    }
    if (traded && distance >= options.confirmAtr * atr[i]!) leftSinceTraded = true
    const holdBreak = (): void => {
      if (attempt && closesOnNewSide >= options.heldCloses) {
        attempt = null
        broken = true
        far = false
      }
    }
    if (attempt) {
      const held = above ? candle.close > price + tolerance : candle.close < price - tolerance
      closesOnNewSide = held ? closesOnNewSide + 1 : 0
      holdBreak()
    }
    if (broken && !attempt && distance >= options.brokenAtr * atr[i]!) far = true

    if (closedBeyond) {
      pending = null
      confirmingTouch = null
      closesBeyond++
      if (closesBeyond >= options.breakCloses) {
        side = above ? 'below' : 'above'
        bouncesSinceTraded = 0
        closesBeyond = 0
        armed = false
        brokenSinceLastBounce = true
        if (attempt) {
          // Цена вернулась, не закрепившись за уровнем: попытка не удалась, всё как до неё.
          ;({ broken, far } = attempt)
          attempt = null
        } else {
          attempt = { broken, far }
          closesOnNewSide = options.breakCloses
          holdBreak()
        }
      }
      continue
    }

    if (closesBeyond > 0) {
      closesBeyond = 0
      armed = false
      touchIndex = i
      confirmingTouch = null
      pending = { time: candle.openTime, type: 'false_break', side }
    } else if (armed && piercedBy >= -options.touchAtr * atr[i]!) {
      armed = false
      touchIndex = i
      confirmingTouch = null
      pending = {
        time: candle.openTime,
        type: piercedBy > options.falseBreakAtr * atr[i]! ? 'false_break' : 'bounce',
        side,
      }
    }

    if (!armed && distance >= options.departAtr * atr[i]!) {
      armed = true
      if (pending) {
        events.push(pending)
        if (pending.type === 'bounce') {
          confirmingTouch = touchIndex
          // Уровень, от которого цена снова и снова отскакивает с одной стороны, опять работает, даже если уходы были медленные.
          if (traded && leftSinceTraded && ++bouncesSinceTraded >= options.confirmBounces) {
            crossings = 0
            traded = false
            bouncesSinceTraded = 0
            leftSinceTraded = false
          }
        }
        pending = null
        if (brokenSinceLastBounce) {
          flips++
          brokenSinceLastBounce = false
        }
        broken = false
        far = false
        attempt = null
      }
    }

    // Выход из проторговки уровень не подтверждает: нужен новый отскок, быстрый и далёкий.
    if (confirmingTouch !== null) {
      if (i - confirmingTouch > options.confirmWithinBars) {
        confirmingTouch = null
      } else if (distance >= options.confirmAtr * atr[i]!) {
        crossings = 0
        traded = false
        confirmingTouch = null
      }
    }
  }
  // Пробитый уровень работает снова только после отскока. Возврат цены назад без отскока его не восстанавливает.
  return { events, flips, traded, broken: broken && far }
}

function mergeZones(zones: LevelZone[]): LevelZone[] {
  const merged: LevelZone[] = []
  for (const zone of [...zones].sort((a, b) => a.from - b.from)) {
    const last = merged.at(-1)
    const tallest = Math.max(zone.high - zone.low, (last?.high ?? 0) - (last?.low ?? 0))
    const mergedHeight = last ? Math.max(last.high, zone.high) - Math.min(last.low, zone.low) : 0
    if (last && zone.from <= last.to && mergedHeight <= tallest * ZONE_MERGE_GROWTH) {
      last.to = Math.max(last.to, zone.to)
      last.low = Math.min(last.low, zone.low)
      last.high = Math.max(last.high, zone.high)
    } else {
      merged.push({ ...zone })
    }
  }
  return merged
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}
