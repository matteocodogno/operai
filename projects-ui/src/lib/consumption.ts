/**
 * Consumption: what a project's terms sold, set against the hours recorded on it (specs/20261112-project-hours US-1,
 * AC-1.1–1.9, and the signals of US-5, AC-5.1–5.29; plan § Consumption, § Signals on the consumption block). Pure: two
 * complete answers go in (the terms projects-api reads back, the summary hours-api answers for the project) with the
 * project's own state, and one figure per fact comes out, with no I/O, no clock and no formatting — the block formats
 * with the library's `formatDuration`, `formatNumber` and `formatDate`.
 *
 * Hours are compared as whole minutes, man-days as integer tenths (`tenths = roundHalfUp(minutes × 10 / 480)`, D27,
 * A34), so nothing here goes through a float and a figure is rounded once; the consumed percentage and the time
 * elapsed are rounded down (D92, A56), and the state, the excess and the bar are decided on the exact minutes (A53).
 * This module imports types only: no money formatter, no amount, price or rate exists anywhere in it (AC-1.8), and no
 * function takes a person, a role or a permission, so every reader of the project sees the same signals (AC-5.27).
 *
 * It reads no clock either. Every signal that reads today reads the Europe/Zurich day projects-api states with the
 * terms (`Terms.asOf`, plan D-P7, AC-5.29), by calendar arithmetic on `YYYY-MM-DD`; an `asOf` that is absent or not a
 * date gives no time elapsed and no date signal, never the browser's own day (R10).
 *
 * Why it lives in projects-ui, not in a service (plan D-P3): projects-api owns the terms and derives the package
 * period (`currentPeriod`), hours-api owns the hours, and the screen that owns the comparison composes the two. The
 * server-side alerts of specs/20261112-project-alerts rebuild this rule on their own path.
 *
 * How a caller uses it: `summaryRequestOf(terms)` says whether the block has to ask the summary and for which window
 * (`null`: nothing to ask — no terms to compare, or a package that has not started); once the answer is in (or the
 * request failed: pass `null`) `consumptionOf(terms, summary, projectState)` says what to draw, `dateSignalsOf(terms,
 * projectState)` which dates to say, and `hasConsumptionBlock(terms, projectState)` whether there is a block at all.
 */
import type { HourPackageKind, ProjectState, Terms } from './types'

// ─── The rules, fixed and not configurable ───────────────────────────────────

/** The thresholds (D87): the same as specs/20261112-project-alerts, so the card and the alert task agree. */
export const CLOSE_TO_LIMIT_PERCENT = 80
export const OVER_PERCENT = 100
/** The bar's scale ends at 125 % of the reference (D86). */
export const SCALE_END_PERCENT = 125
/** A date within this many days is near (D89): the same as specs/20261112-project-alerts. */
export const NEAR_DAYS = 30
/** Where the two thresholds sit, as percent of the bar's length: 80 % and 100 % of the reference on a 0–125 % scale (AC-5.14). */
export const BAR_MARKS = { closeToLimit: 64, over: 80 } as const

/** The bar's length, as the percent its positions are given in. */
const BAR_END = 100

/** A man-day is 8 hours (D27). */
const MINUTES_PER_MAN_DAY = 8 * 60

/** A tenth of a man-day is 48 minutes, exactly (D27): a reference in whole tenths is a whole number of minutes. */
const MINUTES_PER_TENTH = MINUTES_PER_MAN_DAY / 10

// ─── What goes in and what comes out ─────────────────────────────────────────

/** What the summary answers that a comparison reads (`SummaryAnswer.totalMinutes` and `.windowMinutes`, plan § API). */
export type SummaryFigures = { totalMinutes: number; windowMinutes: number | null }

/**
 * What `ConsumptionBlock` asks the summary for, decided from the terms alone: the package's current period as the
 * window (`windowFrom`/`windowTo`), or all time (`window: null`) for a fixed price and time and material.
 */
export type SummaryRequest = { window: { from: string; to: string } | null }

/** The spec's "state" of a consumption: not a project's state (D87). */
export type ConsumptionState = 'on_track' | 'close_to_limit' | 'over'

/** The milder or the graver of the two levels a signal can have (D87): a warning, or a danger. */
export type Level = 'milder' | 'graver'

/** The hours beyond the reference, positive (AC-5.12): in hours for a package, in man-days for the other terms. */
export type Excess = { unit: 'hours'; minutes: number } | { unit: 'man_days'; tenths: number; belowOneTenth: boolean }

/** What a comparison says about the hours used against its reference (specs/20261112-project-hours US-5, plan § Signals). */
export type Share = {
  /** The exact percentage rounded down to a whole number, uncapped (AC-5.5, D92). */
  consumedPercent: number
  /**
   * On the exact minutes, never the floored figure or the man-days shown (AC-5.6, A53). `null`, no state said, for a
   * capacity package past its expiry (AC-5.25, D91) and for a closed or cancelled project (AC-5.26, D93): everything
   * else of the share stays.
   */
  state: ConsumptionState | null
  /** `null` at or below the reference: exactly 100 % is over with no excess (AC-5.9, AC-5.12). */
  excess: Excess | null
  /** 0–100: how much of the span the terms have has gone by at `asOf`; `null` where the terms have no span with an end or `asOf` is not usable (AC-5.18, AC-5.19). */
  elapsedPercent: number | null
  /** Where each part of the bar sits, in percent of the bar's length. It holds no text: the bar is drawn for the eye (AC-5.11). */
  bar: {
    /** 0–80: the part up to the reference (the fill before the 100 % mark). */
    within: number
    /** 0–20: the part beyond the 100 % mark; above zero exactly when `used` is above the reference, never past the end (AC-5.15, AC-5.16). */
    beyond: number
    /** 0–100: a fixed price's estimate, at its share of the max effort, when that is within the scale; `null` otherwise (AC-5.17). */
    estimate: number | null
    /** 0–80: the "today" mark at 0.8 times the time elapsed (AC-5.18); `null` with it. */
    today: number | null
  }
}

export type Consumption =
  /** No terms, or terms that sold nothing to compare with (an SLA and no hour package, D82): no figures at all. */
  | { variant: 'none' }
  /** A package whose start date is still ahead (A51): shown as sold, with no figure and no request. */
  | { variant: 'package_not_started'; kind: HourPackageKind; packageMinutes: number; startDate: string }
  /**
   * Terms that sold something comparable and a summary that could not be read (AC-4.9): no hours figure and no
   * remaining figure, rather than a comparison that could be too low.
   */
  | { variant: 'unavailable' }
  | {
      variant: 'package'
      kind: HourPackageKind
      packageMinutes: number
      /** Yearly: the current period. Capacity: its start and its expiry — `to` is `null` for a package without one. */
      period: { from: string; to: string | null }
      /** `true` only for a capacity package past its expiry (D83): the figures are its final ones. */
      ended: boolean
      /** The hours recorded in the period. */
      usedMinutes: number
      /** What is left of the package; `0` once it is exceeded. Never negative. */
      leftMinutes: number
      /** By how much the package is exceeded; `0` until it is. Never negative (D81): the block says "Over by". */
      overByMinutes: number
      /** `null` only for a reference not above zero (AC-5.4). */
      share: Share | null
    }
  | {
      variant: 'fixed_price'
      usedTenths: number
      estimatedTenths: number | null
      maxEffortTenths: number
      /** `null` only for a reference not above zero (AC-5.4). */
      share: Share | null
    }
  | {
      variant: 't_and_m'
      usedTenths: number
      plannedTenths: number
      /** `null` only for a reference not above zero (AC-5.4). */
      share: Share | null
    }

/** One date of the terms that has passed or is near (AC-5.21, AC-5.22): said in words and by an icon of its level (AC-5.10). */
export type DateSignal = {
  which: 'deadline' | 'end_date'
  /** `YYYY-MM-DD`, shown with `formatDate`. */
  date: string
  when: 'passed' | 'near'
  /** Passed: at least 1, the days since. Near: 0 to 30, the days to go; 0 is today (D94). */
  days: number
  level: Level
}

// ─── Whole numbers ───────────────────────────────────────────────────────────

/** Integer division of whole non-negative numbers: exact, with no float quotient to round (D92). */
const intDiv = (dividend: number, divisor: number): number => (dividend - (dividend % divisor)) / divisor

/** Minutes as tenths of a man-day: `roundHalfUp(minutes × 10 / 480)`, in integers. */
const manDayTenthsOfMinutes = (minutes: number): number =>
  Math.floor((minutes * 10 * 2 + MINUTES_PER_MAN_DAY) / (MINUTES_PER_MAN_DAY * 2))

/**
 * A man-day figure projects-api sends (a number with at most one decimal) as whole tenths, so the comparison and any
 * sum stay in integers. The `Math.round` only strips float noise (`2.3 * 10` and the like), never a real digit.
 */
const tenthsOfManDays = (manDays: number): number => Math.round(manDays * 10)

// ─── Days ────────────────────────────────────────────────────────────────────

/**
 * A `YYYY-MM-DD` date as a day number, by integer calendar arithmetic (the days from the civil date, proleptic
 * Gregorian): no `Date`, no clock and no time zone, so the browser's own day can never leak into a signal (AC-5.29).
 * `null` for anything that is not a real calendar date — a day number is never guessed.
 */
const dayNumberOf = (date: string): number | null => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (match === null) return null
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
  const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  // Year 0 is refused: the integer division below is only a floor for non-negative numbers.
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > monthDays[month - 1]) return null
  // Count from 1 March, so the leap day is the last of its year.
  const y = month <= 2 ? year - 1 : year
  const era = intDiv(y, 400)
  const yearOfEra = y - era * 400
  const dayOfYear = intDiv(153 * (month > 2 ? month - 3 : month + 9) + 2, 5) + day - 1
  const dayOfEra = yearOfEra * 365 + intDiv(yearOfEra, 4) - intDiv(yearOfEra, 100) + dayOfYear
  return era * 146097 + dayOfEra
}

/**
 * How much of a span of days has gone by, as a whole number of percent, rounded down (AC-5.20, A56): the days from its
 * first day up to but not including `asOf`, over all its days, its first and its last both counted — 0 up to and
 * including the first day, 100 only from the day after the last, never beyond. `null` when the span ends before it
 * starts (AC-5.19), or when a date of it, or `asOf`, is not a `YYYY-MM-DD` calendar date (an older projects-api states
 * none, R10).
 */
export function elapsedPercentOf(span: { from: string; to: string }, asOf: string): number | null {
  const [from, to, today] = [dayNumberOf(span.from), dayNumberOf(span.to), dayNumberOf(asOf)]
  if (from === null || to === null || today === null || to < from) return null
  const days = to - from + 1
  const gone = Math.min(Math.max(today - from, 0), days)
  return intDiv(100 * gone, days)
}

// ─── The share of a comparison ───────────────────────────────────────────────

/** The excess, in the unit the terms are sold in: whole minutes, or the AC-1.6 man-day rule applied to the excess itself. */
const excessOf = (minutes: number, unit: Excess['unit']): Excess => {
  if (unit === 'hours') return { unit, minutes }
  const tenths = manDayTenthsOfMinutes(minutes)
  return { unit, tenths, belowOneTenth: tenths === 0 }
}

/**
 * A fixed price's estimate as a position on the bar: at `80 × e / m` when the estimate `e` is within the scale — at most
 * 125 % of the max effort `m`, both ends included — and no mark otherwise (AC-5.17). Whole tenths, cross-multiplied.
 */
const estimateMarkOf = (estimatedTenths: number | null, maxEffortTenths: number): number | null =>
  estimatedTenths !== null && maxEffortTenths > 0 && 100 * estimatedTenths <= SCALE_END_PERCENT * maxEffortTenths
    ? (BAR_MARKS.over * estimatedTenths) / maxEffortTenths
    : null

/**
 * What the comparison says about `used` against `reference`, both whole minutes. `null` when the reference is not above
 * zero — the schemas forbid one (F17), and nothing is compared with it (AC-5.4): no division by zero, no "NaN %".
 */
const shareOf = (
  used: number,
  reference: number,
  {
    unit,
    stateSaid,
    estimate = null,
    elapsedPercent = null,
  }: { unit: Excess['unit']; stateSaid: boolean; estimate?: number | null; elapsedPercent?: number | null },
): Share | null => {
  if (reference <= 0) return null
  const over = used > reference
  return {
    consumedPercent: intDiv(100 * used, reference),
    // Cross-multiplied, so the exact minutes decide and no quotient is rounded on the way (A53).
    state: !stateSaid
      ? null
      : 100 * used < CLOSE_TO_LIMIT_PERCENT * reference
        ? 'on_track'
        : 100 * used < OVER_PERCENT * reference
          ? 'close_to_limit'
          : 'over',
    excess: over ? excessOf(used - reference, unit) : null,
    elapsedPercent,
    bar: {
      within: (BAR_MARKS.over * Math.min(used, reference)) / reference,
      // An integer comparison decides whether there is a part at all, so exactly 100 % has none (AC-5.15); the part is
      // measured from the mark, so a hair above the reference is a hair beyond, not a difference of two nearly equal floats.
      beyond: over ? Math.min((BAR_MARKS.over * (used - reference)) / reference, BAR_END - BAR_MARKS.over) : 0,
      estimate,
      today: elapsedPercent === null ? null : (BAR_MARKS.over * elapsedPercent) / OVER_PERCENT,
    },
  }
}

/** The level of a state (D87): close to the limit is the milder, over the graver, on track has none. */
export function levelOfState(state: ConsumptionState): Level | null {
  return state === 'on_track' ? null : state === 'close_to_limit' ? 'milder' : 'graver'
}

// ─── What the terms sold ─────────────────────────────────────────────────────

/**
 * What the terms sold, read once for every export below so that "does the block ask?", "what does it draw?" and "is
 * there a block?" can never disagree. `package` is a package with a current period; a package whose period is `null`
 * has not started (A51); one whose period is absent comes from a projects-api that predates `currentPeriod`: no period
 * is known and none is worked out here (the server owns the Europe/Zurich day), so it is not compared.
 */
type Sold =
  | { kind: 'none' }
  | { kind: 'not_started'; hourPackage: HourPackageOf }
  | { kind: 'package'; hourPackage: HourPackageOf; currentPeriod: NonNullable<HourPackageOf['currentPeriod']> }
  | { kind: 'fixed_price'; startDate: string; terms: Extract<Terms, { type: 'fixed_price' }>['terms'] }
  | { kind: 't_and_m'; terms: Extract<Terms, { type: 't_and_m' }>['terms'] }

type HourPackageOf = NonNullable<Extract<Terms, { type: 'maintenance' | 'saas' }>['terms']['hourPackage']>

function soldOf(terms: Terms | null): Sold {
  switch (terms?.type) {
    case 'fixed_price':
      return { kind: 'fixed_price', startDate: terms.startDate, terms: terms.terms }
    case 't_and_m':
      return { kind: 't_and_m', terms: terms.terms }
    case 'maintenance':
    case 'saas': {
      const hourPackage = terms.terms.hourPackage
      if (!hourPackage || hourPackage.currentPeriod === undefined) {
        return { kind: 'none' }
      }
      return hourPackage.currentPeriod === null
        ? { kind: 'not_started', hourPackage }
        : { kind: 'package', hourPackage, currentPeriod: hourPackage.currentPeriod }
    }
    default:
      return { kind: 'none' }
  }
}

export function summaryRequestOf(terms: Terms | null): SummaryRequest | null {
  const sold = soldOf(terms)
  switch (sold.kind) {
    case 'fixed_price':
    case 't_and_m':
      return { window: null }
    case 'package':
      return { window: { from: sold.currentPeriod.from, to: sold.currentPeriod.to } }
    default:
      return null
  }
}

export function consumptionOf(
  terms: Terms | null,
  summary: SummaryFigures | null,
  projectState: ProjectState,
): Consumption {
  const sold = soldOf(terms)
  // An absent day is read as one `elapsedPercentOf` cannot use: no time elapsed, never the browser's own day (AC-5.29).
  const asOf = terms?.asOf ?? ''
  // A closed or cancelled project says no state (AC-5.26); a package past its expiry says none either (AC-5.25).
  const projectSaysState = projectState !== 'closed' && projectState !== 'cancelled'
  switch (sold.kind) {
    case 'none':
      return { variant: 'none' }
    case 'not_started':
      return {
        variant: 'package_not_started',
        kind: sold.hourPackage.kind,
        packageMinutes: sold.hourPackage.hours * 60,
        startDate: sold.hourPackage.startDate,
      }
    case 'package': {
      if (summary === null || summary.windowMinutes === null) {
        return { variant: 'unavailable' }
      }
      const { hourPackage, currentPeriod } = sold
      const packageMinutes = hourPackage.hours * 60
      const usedMinutes = summary.windowMinutes
      // A capacity package without an expiry is open-ended: the server's `to` is just today, which is no end date.
      const openEnded = hourPackage.kind === 'capacity' && hourPackage.expiryDate === null
      return {
        variant: 'package',
        kind: hourPackage.kind,
        packageMinutes,
        period: { from: currentPeriod.from, to: openEnded ? null : currentPeriod.to },
        ended: currentPeriod.ended,
        usedMinutes,
        leftMinutes: Math.max(0, packageMinutes - usedMinutes),
        overByMinutes: Math.max(0, usedMinutes - packageMinutes),
        share: shareOf(usedMinutes, packageMinutes, {
          unit: 'hours',
          stateSaid: projectSaysState && !currentPeriod.ended,
          // The span is the package's period when it has an end: a yearly one, a capacity one with an expiry (AC-5.18, AC-5.19).
          elapsedPercent: openEnded ? null : elapsedPercentOf({ from: currentPeriod.from, to: currentPeriod.to }, asOf),
        }),
      }
    }
    case 'fixed_price': {
      if (summary === null) {
        return { variant: 'unavailable' }
      }
      const { estimatedManDays, maxEffortManDays } = sold.terms
      const estimatedTenths = estimatedManDays === null ? null : tenthsOfManDays(estimatedManDays)
      const maxEffortTenths = tenthsOfManDays(maxEffortManDays)
      return {
        variant: 'fixed_price',
        usedTenths: manDayTenthsOfMinutes(summary.totalMinutes),
        estimatedTenths,
        maxEffortTenths,
        share: shareOf(summary.totalMinutes, maxEffortTenths * MINUTES_PER_TENTH, {
          unit: 'man_days',
          stateSaid: projectSaysState,
          estimate: estimateMarkOf(estimatedTenths, maxEffortTenths),
          // From the terms' start date to the deadline; a deadline before the start has no span (AC-5.18, AC-5.19).
          elapsedPercent: elapsedPercentOf({ from: sold.startDate, to: sold.terms.deadline }, asOf),
        }),
      }
    }
    case 't_and_m': {
      if (summary === null) {
        return { variant: 'unavailable' }
      }
      // The total of ALL positions, summed in tenths; no position is compared on its own (D13).
      const plannedTenths = sold.terms.positions.reduce(
        (sum, position) => sum + tenthsOfManDays(position.plannedManDays),
        0,
      )
      return {
        variant: 't_and_m',
        usedTenths: manDayTenthsOfMinutes(summary.totalMinutes),
        plannedTenths,
        // No span: a time-and-material project has no time elapsed (AC-5.19).
        share: shareOf(summary.totalMinutes, plannedTenths * MINUTES_PER_TENTH, {
          unit: 'man_days',
          stateSaid: projectSaysState,
        }),
      }
    }
  }
}

// ─── The dates ───────────────────────────────────────────────────────────────

/** One date judged against the day: `null` when it has nothing to say, or is not a calendar date (AC-5.21, AC-5.22). */
function signalOf(which: DateSignal['which'], date: string, today: number): DateSignal | null {
  const day = dayNumberOf(date)
  if (day === null) return null
  const days = day - today
  // A date is a whole day: it has passed from the next day, and on its own day it is today, 0 days away (D94).
  if (days < 0) return { which, date, when: 'passed', days: -days, level: 'graver' }
  if (days <= NEAR_DAYS) return { which, date, when: 'near', days, level: 'milder' }
  return null
}

/**
 * The dates of the terms that have passed or are near at `asOf`: a fixed price's deadline, then the terms' end date of
 * any client type, each its own line even on the same day (AC-5.21–5.23). It reads the terms alone — no summary — so it
 * stands when hours cannot be loaded, for a package that has not started and for terms that sold nothing comparable
 * (AC-5.24). None for a closed or cancelled project (AC-5.26), and none when `asOf` is absent or not a calendar day
 * (an older projects-api, R10): the browser's own day is never used (AC-5.29).
 */
export function dateSignalsOf(terms: Terms | null, projectState: ProjectState): DateSignal[] {
  if (terms === null || projectState === 'closed' || projectState === 'cancelled') return []
  const today = dayNumberOf(terms.asOf ?? '')
  if (today === null) return []
  const candidates: [DateSignal['which'], string | null][] = [
    ['deadline', terms.type === 'fixed_price' ? terms.terms.deadline : null],
    ['end_date', terms.endDate],
  ]
  return candidates.flatMap(([which, date]) => {
    const signal = date === null ? null : signalOf(which, date, today)
    return signal === null ? [] : [signal]
  })
}

/**
 * Whether the consumption block exists: the terms sold something comparable (or a package that has not started), or
 * at least one date signal. The ONE rule `HoursSection` draws its divider by and `ConsumptionBlock` renders by, so the
 * two cannot disagree (AC-1.7 amended: an SLA-only project whose end date has passed or is near has a block of date
 * lines alone; one with no end date, or one more than 30 days ahead, has the widget alone).
 */
export function hasConsumptionBlock(terms: Terms | null, projectState: ProjectState): boolean {
  return soldOf(terms).kind !== 'none' || dateSignalsOf(terms, projectState).length > 0
}
