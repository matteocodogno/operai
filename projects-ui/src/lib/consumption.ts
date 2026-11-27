/**
 * Consumption: what a project's terms sold, set against the hours recorded on it (specs/20261112-project-hours US-1,
 * AC-1.1–1.9; plan § Consumption). Pure: two complete answers go in (the terms projects-api reads back, the summary
 * hours-api answers for the project) and one figure per fact comes out, with no I/O, no clock and no formatting —
 * the block formats with the library's `formatDuration`, `formatNumber` and `formatDate`.
 *
 * Hours are compared as whole minutes, man-days as integer tenths (`tenths = roundHalfUp(minutes × 10 / 480)`, D27,
 * A34), so nothing here goes through a float and a figure is rounded once. This module imports types only: no money
 * formatter, no amount, price or rate exists anywhere in it (AC-1.8).
 *
 * Why it lives in projects-ui, not in a service (plan D-P3): projects-api owns the terms and derives the package
 * period (`currentPeriod`), hours-api owns the hours, and the screen that owns the comparison composes the two. The
 * server-side alerts of specs/20261112-project-alerts rebuild this rule on their own path.
 *
 * How a caller uses it: `summaryRequestOf(terms)` says whether the block has to ask the summary and for which window
 * (`null`: nothing to ask — no terms to compare, or a package that has not started); once the answer is in (or the
 * request failed: pass `null`) `consumptionOf(terms, summary)` says what to draw.
 */
import type { HourPackageKind, Terms } from './types'

/** What the summary answers that a comparison reads (`SummaryAnswer.totalMinutes` and `.windowMinutes`, plan § API). */
export type SummaryFigures = { totalMinutes: number; windowMinutes: number | null }

/**
 * What `ConsumptionBlock` asks the summary for, decided from the terms alone: the package's current period as the
 * window (`windowFrom`/`windowTo`), or all time (`window: null`) for a fixed price and time and material.
 */
export type SummaryRequest = { window: { from: string; to: string } | null }

export type Consumption =
  /** No terms, or terms that sold nothing to compare with (an SLA and no hour package, D82): no block at all. */
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
    }
  | { variant: 'fixed_price'; usedTenths: number; estimatedTenths: number | null; maxEffortTenths: number }
  | { variant: 't_and_m'; usedTenths: number; plannedTenths: number }

/** A man-day is 8 hours (D27). */
const MINUTES_PER_MAN_DAY = 8 * 60

/** Minutes as tenths of a man-day: `roundHalfUp(minutes × 10 / 480)`, in integers. */
const manDayTenthsOfMinutes = (minutes: number): number =>
  Math.floor((minutes * 10 * 2 + MINUTES_PER_MAN_DAY) / (MINUTES_PER_MAN_DAY * 2))

/**
 * A man-day figure projects-api sends (a number with at most one decimal) as whole tenths, so the comparison and any
 * sum stay in integers. The `Math.round` only strips float noise (`2.3 * 10` and the like), never a real digit.
 */
const tenthsOfManDays = (manDays: number): number => Math.round(manDays * 10)

/**
 * What the terms sold, read once for both exports below so that "does the block ask?" and "what does it draw?" can
 * never disagree. `package` is a package with a current period; a package whose period is `null` has not started
 * (A51); one whose period is absent comes from a projects-api that predates `currentPeriod`: no period is known and
 * none is worked out here (the server owns the Europe/Zurich day), so it is not compared.
 */
type Sold =
  | { kind: 'none' }
  | { kind: 'not_started'; hourPackage: HourPackageOf }
  | { kind: 'package'; hourPackage: HourPackageOf; currentPeriod: NonNullable<HourPackageOf['currentPeriod']> }
  | { kind: 'fixed_price'; terms: Extract<Terms, { type: 'fixed_price' }>['terms'] }
  | { kind: 't_and_m'; terms: Extract<Terms, { type: 't_and_m' }>['terms'] }

type HourPackageOf = NonNullable<Extract<Terms, { type: 'maintenance' | 'saas' }>['terms']['hourPackage']>

function soldOf(terms: Terms | null): Sold {
  switch (terms?.type) {
    case 'fixed_price':
      return { kind: 'fixed_price', terms: terms.terms }
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

export function consumptionOf(terms: Terms | null, summary: SummaryFigures | null): Consumption {
  const sold = soldOf(terms)
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
      return {
        variant: 'package',
        kind: hourPackage.kind,
        packageMinutes,
        // A capacity package without an expiry is open-ended: the server's `to` is just today, which is no end date.
        period: {
          from: currentPeriod.from,
          to: hourPackage.kind === 'capacity' && hourPackage.expiryDate === null ? null : currentPeriod.to,
        },
        ended: currentPeriod.ended,
        usedMinutes,
        leftMinutes: Math.max(0, packageMinutes - usedMinutes),
        overByMinutes: Math.max(0, usedMinutes - packageMinutes),
      }
    }
    case 'fixed_price': {
      if (summary === null) {
        return { variant: 'unavailable' }
      }
      const { estimatedManDays, maxEffortManDays } = sold.terms
      return {
        variant: 'fixed_price',
        usedTenths: manDayTenthsOfMinutes(summary.totalMinutes),
        estimatedTenths: estimatedManDays === null ? null : tenthsOfManDays(estimatedManDays),
        maxEffortTenths: tenthsOfManDays(maxEffortManDays),
      }
    }
    case 't_and_m': {
      if (summary === null) {
        return { variant: 'unavailable' }
      }
      return {
        variant: 't_and_m',
        usedTenths: manDayTenthsOfMinutes(summary.totalMinutes),
        // The total of ALL positions, summed in tenths; no position is compared on its own (D13).
        plannedTenths: sold.terms.positions.reduce(
          (sum, position) => sum + tenthsOfManDays(position.plannedManDays),
          0,
        ),
      }
    }
  }
}
