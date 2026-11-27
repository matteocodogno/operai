import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { consumptionOf, summaryRequestOf } from './consumption'
import type { SummaryFigures } from './consumption'
import type { CurrentPeriod, Position, Terms } from './types'

// The terms of each type as projects-api reads them back (`lib/types.ts` `Terms`).
const base = { id: 't1', startDate: '2026-03-01', endDate: null, version: 1 }

const fixedPrice = (estimatedManDays: number | null, maxEffortManDays = 12): Terms => ({
  ...base,
  type: 'fixed_price',
  terms: { deadline: '2026-12-01', estimatedManDays, maxEffortManDays },
})

const timeAndMaterial = (positions: Position[]): Terms => ({ ...base, type: 't_and_m', terms: { positions } })

// A maintenance project's hour package; `currentPeriod` is what projects-api derives (undefined: a server that predates it).
const withPackage = (
  kind: 'yearly' | 'capacity',
  packageHours: number,
  currentPeriod: CurrentPeriod | null | undefined,
  expiryDate: string | null = null,
): Terms => ({
  ...base,
  type: 'maintenance',
  terms: {
    sla: { highDays: 1, normalDays: 3 },
    hourPackage: {
      hours: packageHours,
      kind,
      startDate: '2026-03-01',
      expiryDate,
      ...(currentPeriod === undefined ? {} : { currentPeriod }),
    },
  },
})

const period = (from: string, to: string, ended = false): CurrentPeriod => ({ from, to, ended })
const yearlyPeriod = period('2026-03-01', '2027-02-28')

/** Hours and minutes as minutes: the unit every figure of a comparison is in. */
const hm = (h: number, m = 0): number => h * 60 + m

// The summary hours-api answers: the figures a comparison reads.
const hours = (totalMinutes: number, windowMinutes: number | null = null): SummaryFigures => ({
  totalMinutes,
  windowMinutes,
})

describe('man-days (AC-1.6, D27, A34): 8 hours, integer tenths, rounded once, half up', () => {
  // The plan's vectors: 480 → 1.0, 30 → 0.1 (0.0625), 24 → 0.1 (0.05, half up), 23 → 0.0, 3 600 → 7.5.
  it.each([
    [480, 10],
    [30, 1],
    [24, 1],
    [23, 0],
    [3600, 75],
    [0, 0],
  ])('%i minutes are %i tenths of a man-day', (minutes, tenths) => {
    expect(consumptionOf(fixedPrice(null), hours(minutes))).toMatchObject({
      variant: 'fixed_price',
      usedTenths: tenths,
    })
  })
})

describe('fixed price (AC-1.4): the hours recorded in man-days against the estimate (when known) and the max effort', () => {
  it('carries the estimate and the max effort in tenths; every hour recorded on the project counts (all time)', () => {
    expect(consumptionOf(fixedPrice(10, 12), hours(3600, 600))).toEqual({
      variant: 'fixed_price',
      usedTenths: 75,
      estimatedTenths: 100,
      maxEffortTenths: 120,
    })
  })

  it('leaves the estimate out (null, not zero) when the terms carry none', () => {
    expect(consumptionOf(fixedPrice(null, 12.5), hours(480))).toEqual({
      variant: 'fixed_price',
      usedTenths: 10,
      estimatedTenths: null,
      maxEffortTenths: 125,
    })
  })

  it('keeps a one-decimal figure exact: 2.3 and 0.7 are 23 and 7 tenths, with no float drift', () => {
    expect(consumptionOf(fixedPrice(2.3, 0.7), hours(0))).toMatchObject({ estimatedTenths: 23, maxEffortTenths: 7 })
  })
})

describe('time and material (AC-1.5, D13): the hours recorded in man-days against the total of all positions', () => {
  it('compares with the sum of the positions planned man-days, and shows no per-position figure', () => {
    const answer = consumptionOf(
      timeAndMaterial([
        { profile: 'Senior developer', plannedManDays: 20.5 },
        { profile: 'Designer', plannedManDays: 3.5 },
      ]),
      hours(3600),
    )

    expect(answer).toEqual({ variant: 't_and_m', usedTenths: 75, plannedTenths: 240 })
    expect(Object.keys(answer).sort()).toEqual(['plannedTenths', 'usedTenths', 'variant'])
  })

  it('sums in whole tenths, so 0.1 + 0.2 is 0.3 and not 0.30000000000000004', () => {
    const answer = consumptionOf(
      timeAndMaterial([
        { profile: 'A', plannedManDays: 0.1 },
        { profile: 'B', plannedManDays: 0.2 },
      ]),
      hours(0),
    )

    expect(answer).toMatchObject({ variant: 't_and_m', plannedTenths: 3 })
  })

  it('counts every hour recorded on the project, in or out of any window', () => {
    expect(consumptionOf(timeAndMaterial([{ profile: 'A', plannedManDays: 5 }]), hours(960, 30))).toMatchObject({
      usedTenths: 20,
    })
  })
})

describe('hour package, current period (AC-1.1, AC-1.2): the hours recorded in the period against the package', () => {
  it('a yearly package: the package, its current period, the hours used in it (not all time) and the hours left', () => {
    expect(consumptionOf(withPackage('yearly', 120, yearlyPeriod), hours(hm(500), hm(84, 30)))).toEqual({
      variant: 'package',
      kind: 'yearly',
      packageMinutes: hm(120),
      period: { from: '2026-03-01', to: '2027-02-28' },
      ended: false,
      usedMinutes: hm(84, 30),
      leftMinutes: hm(35, 30),
      overByMinutes: 0,
    })
  })

  it('zero hours used is a figure, not an empty state: the whole package is left', () => {
    expect(consumptionOf(withPackage('yearly', 120, yearlyPeriod), hours(hm(40), 0))).toMatchObject({
      variant: 'package',
      usedMinutes: 0,
      leftMinutes: hm(120),
      overByMinutes: 0,
    })
  })

  it('exactly used up is "left 0", not "over by 0"', () => {
    expect(consumptionOf(withPackage('yearly', 120, yearlyPeriod), hours(hm(120), hm(120)))).toMatchObject({
      leftMinutes: 0,
      overByMinutes: 0,
    })
  })

  it('exceeded: the hours it is exceeded by as a positive figure, and nothing left; never a negative one (D81)', () => {
    const answer = consumptionOf(withPackage('yearly', 120, yearlyPeriod), hours(hm(200), hm(124, 30)))

    expect(answer).toMatchObject({
      variant: 'package',
      usedMinutes: hm(124, 30),
      leftMinutes: 0,
      overByMinutes: hm(4, 30),
    })
  })

  it('a capacity package with an expiry: its period runs from the start to the expiry (AC-1.3)', () => {
    const answer = consumptionOf(
      withPackage('capacity', 100, period('2026-03-01', '2026-09-30'), '2026-09-30'),
      hours(hm(100), hm(60)),
    )

    expect(answer).toMatchObject({
      variant: 'package',
      kind: 'capacity',
      period: { from: '2026-03-01', to: '2026-09-30' },
      ended: false,
      usedMinutes: hm(60),
      leftMinutes: hm(40),
    })
  })

  it('a capacity package without an expiry has no end date: the period server-side ends today, but the block must not show it', () => {
    const answer = consumptionOf(withPackage('capacity', 100, period('2026-03-01', '2026-11-27')), hours(0, hm(10)))

    expect(answer).toMatchObject({ variant: 'package', period: { from: '2026-03-01', to: null } })
  })

  it('an expired capacity package keeps its final figures and passes `ended` through (AC-1.9, D83)', () => {
    const answer = consumptionOf(
      withPackage('capacity', 100, period('2026-03-01', '2026-09-30', true), '2026-09-30'),
      hours(hm(90), hm(90)),
    )

    expect(answer).toMatchObject({
      variant: 'package',
      period: { from: '2026-03-01', to: '2026-09-30' },
      ended: true,
      usedMinutes: hm(90),
      leftMinutes: hm(10),
    })
  })

  it('one minute past the package is over by one minute, every figure whole and never negative', () => {
    const answer = consumptionOf(withPackage('capacity', 10, period('2026-03-01', '2026-09-30')), hours(0, hm(10) + 1))

    expect(answer).toMatchObject({ leftMinutes: 0, overByMinutes: 1 })
  })
})

describe('a package that has not started (A51): shown as sold, with no figure and no request', () => {
  it('carries the package and its start date, whatever the summary holds', () => {
    const terms = withPackage('capacity', 120, null)
    const expected = {
      variant: 'package_not_started',
      kind: 'capacity',
      packageMinutes: hm(120),
      startDate: '2026-03-01',
    }

    expect(consumptionOf(terms, null)).toEqual(expected)
    expect(consumptionOf(terms, hours(hm(10), hm(10)))).toEqual(expected)
  })

  it('a yearly package that has not started is the same', () => {
    expect(consumptionOf(withPackage('yearly', 60, null), null)).toEqual({
      variant: 'package_not_started',
      kind: 'yearly',
      packageMinutes: hm(60),
      startDate: '2026-03-01',
    })
  })
})

describe('nothing comparable (AC-1.7, D82): no consumption block at all', () => {
  it.each<[string, Terms | null]>([
    ['no terms (an internal project, or one made by hand without them)', null],
    [
      'maintenance with an SLA and no hour package',
      { ...base, type: 'maintenance', terms: { sla: { highDays: 1, normalDays: 3 }, hourPackage: null } },
    ],
    ['a SaaS project with an empty set of terms', { ...base, type: 'saas', terms: { sla: null, hourPackage: null } }],
  ])('%s', (_label, terms) => {
    expect(consumptionOf(terms, hours(hm(100), hm(100)))).toEqual({ variant: 'none' })
    expect(consumptionOf(terms, null)).toEqual({ variant: 'none' })
  })

  it('a package from a projects-api that predates the period is not compared either: no period is known and none is guessed', () => {
    expect(consumptionOf(withPackage('yearly', 120, undefined), hours(hm(100), hm(100)))).toEqual({ variant: 'none' })
  })
})

describe('no hours figure without the hours (AC-4.9): a comparison whose summary could not be read is unavailable', () => {
  it.each<[string, Terms]>([
    ['a yearly package', withPackage('yearly', 120, yearlyPeriod)],
    ['a fixed price', fixedPrice(10)],
    ['time and material', timeAndMaterial([{ profile: 'A', plannedManDays: 5 }])],
  ])('%s with no summary shows no figure at all', (_label, terms) => {
    expect(consumptionOf(terms, null)).toEqual({ variant: 'unavailable' })
  })

  it('a package whose window figure is missing from the summary is unavailable, never read as zero hours used', () => {
    expect(consumptionOf(withPackage('yearly', 120, yearlyPeriod), hours(hm(40), null))).toEqual({
      variant: 'unavailable',
    })
  })
})

describe('summaryRequestOf: what the block asks the summary for, from the terms alone', () => {
  it('a package with a current period asks for that window, so period 2 never counts period 1 (AC-1.2)', () => {
    expect(summaryRequestOf(withPackage('yearly', 120, period('2027-03-01', '2028-02-29')))).toEqual({
      window: { from: '2027-03-01', to: '2028-02-29' },
    })
  })

  it('a capacity package without an expiry asks for the window the server gave, which ends today (AC-1.3)', () => {
    expect(summaryRequestOf(withPackage('capacity', 100, period('2026-03-01', '2026-11-27')))).toEqual({
      window: { from: '2026-03-01', to: '2026-11-27' },
    })
  })

  it('a fixed price and time and material ask for all time: no window', () => {
    expect(summaryRequestOf(fixedPrice(null))).toEqual({ window: null })
    expect(summaryRequestOf(timeAndMaterial([{ profile: 'A', plannedManDays: 5 }]))).toEqual({ window: null })
  })

  it.each<[string, Terms | null]>([
    ['no terms', null],
    ['an SLA and no hour package', { ...base, type: 'maintenance', terms: { sla: null, hourPackage: null } }],
    ['a package that has not started (no request is made, A51)', withPackage('capacity', 120, null)],
    ['a package from a server that predates the period', withPackage('yearly', 120, undefined)],
  ])('%s asks nothing', (_label, terms) => {
    expect(summaryRequestOf(terms)).toBeNull()
  })

  it('agrees with consumptionOf for every kind of terms: a request is made exactly when the figures are needed', () => {
    const everything: Terms[] = [
      withPackage('yearly', 120, yearlyPeriod),
      withPackage('capacity', 100, period('2026-03-01', '2026-09-30', true), '2026-09-30'),
      fixedPrice(10),
      timeAndMaterial([{ profile: 'A', plannedManDays: 5 }]),
    ]
    const asksNothing: (Terms | null)[] = [
      null,
      withPackage('capacity', 120, null),
      withPackage('yearly', 120, undefined),
      { ...base, type: 'saas', terms: { sla: null, hourPackage: null } },
    ]

    for (const terms of everything) {
      expect(summaryRequestOf(terms)).not.toBeNull()
      expect(consumptionOf(terms, null)).toEqual({ variant: 'unavailable' })
    }
    for (const terms of asksNothing) {
      expect(summaryRequestOf(terms)).toBeNull()
      expect(consumptionOf(terms, null)).toEqual(consumptionOf(terms, hours(hm(10), hm(10))))
    }
  })
})

describe('no money anywhere (AC-1.8)', () => {
  it('the module imports types only: no formatter, no library, nothing that could format an amount', () => {
    const source = readFileSync(fileURLToPath(new URL('./consumption.ts', import.meta.url)), 'utf8')
    const imports = source.match(/^import .*$/gm) ?? []

    expect(imports).toEqual(["import type { HourPackageKind, Terms } from './types'"])
  })
})
