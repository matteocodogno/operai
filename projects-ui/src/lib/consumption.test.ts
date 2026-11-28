import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BAR_MARKS,
  CLOSE_TO_LIMIT_PERCENT,
  OVER_PERCENT,
  SCALE_END_PERCENT,
  consumptionOf,
  dateSignalsOf,
  elapsedPercentOf,
  hasConsumptionBlock,
  levelOfState,
  summaryRequestOf,
} from './consumption'
import * as consumption from './consumption'
import type { SummaryFigures } from './consumption'
import type { CurrentPeriod, Position, ProjectState, Terms } from './types'

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
    expect(consumptionOf(fixedPrice(null), hours(minutes), 'active')).toMatchObject({
      variant: 'fixed_price',
      usedTenths: tenths,
    })
  })
})

describe('fixed price (AC-1.4): the hours recorded in man-days against the estimate (when known) and the max effort', () => {
  it('carries the estimate and the max effort in tenths; every hour recorded on the project counts (all time)', () => {
    expect(consumptionOf(fixedPrice(10, 12), hours(3600, 600), 'active')).toEqual({
      variant: 'fixed_price',
      usedTenths: 75,
      estimatedTenths: 100,
      maxEffortTenths: 120,
      share: expect.objectContaining({ consumedPercent: 62 }), // 3 600 of 5 760 minutes (62.5)
    })
  })

  it('leaves the estimate out (null, not zero) when the terms carry none', () => {
    expect(consumptionOf(fixedPrice(null, 12.5), hours(480), 'active')).toEqual({
      variant: 'fixed_price',
      usedTenths: 10,
      estimatedTenths: null,
      maxEffortTenths: 125,
      share: expect.objectContaining({ consumedPercent: 8 }), // 480 of 6 000 minutes
    })
  })

  it('keeps a one-decimal figure exact: 2.3 and 0.7 are 23 and 7 tenths, with no float drift', () => {
    expect(consumptionOf(fixedPrice(2.3, 0.7), hours(0), 'active')).toMatchObject({
      estimatedTenths: 23,
      maxEffortTenths: 7,
    })
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
      'active',
    )

    expect(answer).toEqual({
      variant: 't_and_m',
      usedTenths: 75,
      plannedTenths: 240,
      share: expect.objectContaining({ consumedPercent: 31 }), // 3 600 of 11 520 minutes
    })
    // One total and its share: no per-position key of any kind.
    expect(Object.keys(answer).sort()).toEqual(['plannedTenths', 'share', 'usedTenths', 'variant'])
  })

  it('sums in whole tenths, so 0.1 + 0.2 is 0.3 and not 0.30000000000000004', () => {
    const answer = consumptionOf(
      timeAndMaterial([
        { profile: 'A', plannedManDays: 0.1 },
        { profile: 'B', plannedManDays: 0.2 },
      ]),
      hours(0),
      'active',
    )

    expect(answer).toMatchObject({ variant: 't_and_m', plannedTenths: 3 })
  })

  it('counts every hour recorded on the project, in or out of any window', () => {
    expect(
      consumptionOf(timeAndMaterial([{ profile: 'A', plannedManDays: 5 }]), hours(960, 30), 'active'),
    ).toMatchObject({
      usedTenths: 20,
    })
  })
})

describe('hour package, current period (AC-1.1, AC-1.2): the hours recorded in the period against the package', () => {
  it('a yearly package: the package, its current period, the hours used in it (not all time) and the hours left', () => {
    expect(consumptionOf(withPackage('yearly', 120, yearlyPeriod), hours(hm(500), hm(84, 30)), 'active')).toEqual({
      variant: 'package',
      kind: 'yearly',
      packageMinutes: hm(120),
      period: { from: '2026-03-01', to: '2027-02-28' },
      ended: false,
      usedMinutes: hm(84, 30),
      leftMinutes: hm(35, 30),
      overByMinutes: 0,
      share: expect.objectContaining({ consumedPercent: 70 }),
    })
  })

  it('zero hours used is a figure, not an empty state: the whole package is left', () => {
    expect(consumptionOf(withPackage('yearly', 120, yearlyPeriod), hours(hm(40), 0), 'active')).toMatchObject({
      variant: 'package',
      usedMinutes: 0,
      leftMinutes: hm(120),
      overByMinutes: 0,
    })
  })

  it('exactly used up is "left 0", not "over by 0"', () => {
    expect(consumptionOf(withPackage('yearly', 120, yearlyPeriod), hours(hm(120), hm(120)), 'active')).toMatchObject({
      leftMinutes: 0,
      overByMinutes: 0,
    })
  })

  it('exceeded: the hours it is exceeded by as a positive figure, and nothing left; never a negative one (D81)', () => {
    const answer = consumptionOf(withPackage('yearly', 120, yearlyPeriod), hours(hm(200), hm(124, 30)), 'active')

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
      'active',
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
    const answer = consumptionOf(
      withPackage('capacity', 100, period('2026-03-01', '2026-11-27')),
      hours(0, hm(10)),
      'active',
    )

    expect(answer).toMatchObject({ variant: 'package', period: { from: '2026-03-01', to: null } })
  })

  it('an expired capacity package keeps its final figures and passes `ended` through (AC-1.9, D83)', () => {
    const answer = consumptionOf(
      withPackage('capacity', 100, period('2026-03-01', '2026-09-30', true), '2026-09-30'),
      hours(hm(90), hm(90)),
      'active',
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
    const answer = consumptionOf(
      withPackage('capacity', 10, period('2026-03-01', '2026-09-30')),
      hours(0, hm(10) + 1),
      'active',
    )

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

    expect(consumptionOf(terms, null, 'active')).toEqual(expected)
    expect(consumptionOf(terms, hours(hm(10), hm(10)), 'active')).toEqual(expected)
  })

  it('a yearly package that has not started is the same', () => {
    expect(consumptionOf(withPackage('yearly', 60, null), null, 'active')).toEqual({
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
    expect(consumptionOf(terms, hours(hm(100), hm(100)), 'active')).toEqual({ variant: 'none' })
    expect(consumptionOf(terms, null, 'active')).toEqual({ variant: 'none' })
  })

  it('a package from a projects-api that predates the period is not compared either: no period is known and none is guessed', () => {
    expect(consumptionOf(withPackage('yearly', 120, undefined), hours(hm(100), hm(100)), 'active')).toEqual({
      variant: 'none',
    })
  })
})

describe('no hours figure without the hours (AC-4.9): a comparison whose summary could not be read is unavailable', () => {
  it.each<[string, Terms]>([
    ['a yearly package', withPackage('yearly', 120, yearlyPeriod)],
    ['a fixed price', fixedPrice(10)],
    ['time and material', timeAndMaterial([{ profile: 'A', plannedManDays: 5 }])],
  ])('%s with no summary shows no figure at all', (_label, terms) => {
    expect(consumptionOf(terms, null, 'active')).toEqual({ variant: 'unavailable' })
  })

  it('a package whose window figure is missing from the summary is unavailable, never read as zero hours used', () => {
    expect(consumptionOf(withPackage('yearly', 120, yearlyPeriod), hours(hm(40), null), 'active')).toEqual({
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
      expect(consumptionOf(terms, null, 'active')).toEqual({ variant: 'unavailable' })
    }
    for (const terms of asksNothing) {
      expect(summaryRequestOf(terms)).toBeNull()
      expect(consumptionOf(terms, null, 'active')).toEqual(consumptionOf(terms, hours(hm(10), hm(10)), 'active'))
    }
  })
})

describe('consumed percentage of an hour package (AC-5.1, AC-5.5, D88, D92): the exact percentage rounded down, uncapped', () => {
  it('is the hours recorded in the period (not all time) as a share of the package: 84 h 30 of 120 h is 70 (AC-5.1)', () => {
    const answer = consumptionOf(withPackage('yearly', 120, yearlyPeriod), hours(hm(500), hm(84, 30)), 'active')

    expect(answer).toMatchObject({ variant: 'package', share: { consumedPercent: 70 } })
  })

  // AC-5.5's own vectors, all of a 120 h package (7 200 min): the floor, and beyond 100 % as it is.
  it.each([
    [4500, 62], // 62.5
    [7170, 99], // 99.58
    [8370, 116], // 116.25
    [8430, 117], // 117.08
    [12960, 180],
    [30, 0], // 0.42
    [0, 0],
    [7200, 100],
    [7271, 100], // 100.99
    [7272, 101],
  ])('%i of 7 200 minutes reads %i %%', (used, percent) => {
    const answer = consumptionOf(withPackage('yearly', 120, yearlyPeriod), hours(hm(900), used), 'active')

    expect(answer).toMatchObject({ variant: 'package', share: { consumedPercent: percent } })
  })
})

describe('consumed percentage of a fixed price and of time and material (AC-5.2, AC-5.3, D88)', () => {
  it('a fixed price: 72 h against a max effort of 12.0 man-days is 75, with or without an estimate (the estimate is never the base)', () => {
    expect(consumptionOf(fixedPrice(null, 12), hours(hm(72)), 'active')).toMatchObject({
      variant: 'fixed_price',
      share: { consumedPercent: 75 },
    })
    expect(consumptionOf(fixedPrice(3, 12), hours(hm(72)), 'active')).toMatchObject({
      variant: 'fixed_price',
      share: { consumedPercent: 75 },
    })
  })

  it('time and material: 60 h against positions planned at 10.0 and 14.0 man-days (192 h) is 31, summed in tenths (AC-5.3)', () => {
    const answer = consumptionOf(
      timeAndMaterial([
        { profile: 'Senior developer', plannedManDays: 10 },
        { profile: 'Designer', plannedManDays: 14 },
      ]),
      hours(hm(60)),
      'active',
    )

    expect(answer).toMatchObject({ variant: 't_and_m', share: { consumedPercent: 31 } })
  })
})

describe('the state (AC-5.6–5.9, D87, A53): decided on the exact minutes against the exact reference', () => {
  const pkg = (used: number) => consumptionOf(withPackage('yearly', 120, yearlyPeriod), hours(hm(900), used), 'active')

  it.each([
    [0, 'on_track'],
    [5730, 'on_track'], // 79.58 %, which reads 79 (AC-5.7)
    [5759, 'on_track'],
    [5760, 'close_to_limit'], // exactly 80 % (AC-5.8)
    [7170, 'close_to_limit'], // 99.58 %, 30 min left
    [7199, 'close_to_limit'],
    [7200, 'over'], // exactly the reference (AC-5.9)
    [7230, 'over'],
  ])('%i of 7 200 minutes is %s', (used, state) => {
    expect(pkg(used)).toMatchObject({ variant: 'package', share: { state } })
  })

  it('goes by the exact minutes, never by the man-days shown: 19 h of 3.0 man-days reads 79, on track, while it shows 2.4 (AC-5.6)', () => {
    const answer = consumptionOf(fixedPrice(null, 3), hours(hm(19)), 'active')

    expect(answer).toMatchObject({
      variant: 'fixed_price',
      usedTenths: 24,
      share: { consumedPercent: 79, state: 'on_track' },
    })
  })

  // The percentage is floored and the thresholds are whole numbers, so it never contradicts the state (D92): below 80
  // exactly when on track, 80–99 exactly when close to the limit, 100 or more exactly when over. Checked on every
  // used minute from nothing to two and a half times the reference, for references of 120 h, 24 h, 192 h and 1.1 man-days.
  it.each<[string, () => Terms, number]>([
    ['a 120 h package', () => withPackage('yearly', 120, yearlyPeriod), 7200],
    ['a 24 h package', () => withPackage('yearly', 24, yearlyPeriod), 1440],
    ['a 192 h package', () => withPackage('yearly', 192, yearlyPeriod), 11520],
    ['a fixed price of 3.0 man-days', () => fixedPrice(null, 3), 1440],
    ['a fixed price of 1.1 man-days', () => fixedPrice(null, 1.1), 528],
    ['time and material of 24.0 man-days', () => timeAndMaterial([{ profile: 'A', plannedManDays: 24 }]), 11520],
  ])('never reads against its state, for %s', (_label, build, reference) => {
    const terms = build()
    const mismatches: number[] = []
    for (let used = 0; used <= reference * 2.5; used++) {
      const answer = consumptionOf(terms, hours(used, used), 'active')
      if (!('share' in answer) || answer.share === null) throw new Error('a comparison has a share')
      const { consumedPercent, state } = answer.share
      const expected = consumedPercent < 80 ? 'on_track' : consumedPercent < 100 ? 'close_to_limit' : 'over'
      if (state !== expected) mismatches.push(used)
    }

    expect(mismatches).toEqual([])
  })
})

describe('the excess (AC-5.9, AC-5.12, AC-5.13, D86): the hours beyond the reference, positive, none at or below it', () => {
  it('a package: nothing at or below the package (exactly 100 % is over with no excess), the hours beyond it above (AC-5.9)', () => {
    const at = (used: number) => consumptionOf(withPackage('yearly', 120, yearlyPeriod), hours(hm(900), used), 'active')

    expect(at(7199)).toMatchObject({ share: { excess: null } })
    expect(at(7200)).toMatchObject({ share: { state: 'over', excess: null }, leftMinutes: 0, overByMinutes: 0 })
    expect(at(7230)).toMatchObject({ share: { state: 'over', excess: { unit: 'hours', minutes: 30 } } })
  })

  it('a package: the one figure AC-1.1 calls "over by", for the percentage and for the hours alike (AC-5.12)', () => {
    const answer = consumptionOf(withPackage('yearly', 120, yearlyPeriod), hours(hm(900), hm(124, 30)), 'active')

    expect(answer).toMatchObject({ overByMinutes: hm(4, 30), share: { excess: { unit: 'hours', minutes: hm(4, 30) } } })
  })

  it('a fixed price: 108 h against a max effort of 12.0 man-days (96 h) is 112 % and 1.5 man-days over (AC-5.12)', () => {
    expect(consumptionOf(fixedPrice(null, 12), hours(hm(108)), 'active')).toMatchObject({
      share: { consumedPercent: 112, excess: { unit: 'man_days', tenths: 15, belowOneTenth: false } },
    })
  })

  it('time and material the same: 120 h against 10.0 man-days (80 h) is 150 % and 40 h, 5.0 man-days, over (AC-5.12)', () => {
    expect(
      consumptionOf(timeAndMaterial([{ profile: 'A', plannedManDays: 10 }]), hours(hm(120)), 'active'),
    ).toMatchObject({
      share: { consumedPercent: 150, excess: { unit: 'man_days', tenths: 50, belowOneTenth: false } },
    })
  })

  it('exactly the max effort is over with no excess, and one minute above it is over by less than 0.1 man-day (AC-5.9, AC-5.13)', () => {
    expect(consumptionOf(fixedPrice(null, 12), hours(5760), 'active')).toMatchObject({
      share: { state: 'over', excess: null },
    })
    expect(consumptionOf(fixedPrice(null, 12), hours(5761), 'active')).toMatchObject({
      share: { state: 'over', excess: { unit: 'man_days', tenths: 0, belowOneTenth: true } },
    })
  })

  it.each([
    [540, 0, true], // 9 h against 1.1 man-days (528 min): 12 min over, 0.025 man-day (AC-5.13's example)
    [551, 0, true], // 23 min over: 0.048
    [552, 1, false], // 24 min over: 0.05, half up
    [528 + 48, 1, false],
  ])(
    '9 h against 1.1 man-days and its neighbours: %i min used is %i tenth(s) over, below one tenth: %s',
    (used, tenths, below) => {
      expect(consumptionOf(fixedPrice(null, 1.1), hours(used), 'active')).toMatchObject({
        share: { excess: { unit: 'man_days', tenths, belowOneTenth: below } },
      })
    },
  )

  it('the man-day excess is the used tenths less the reference tenths, whenever there is one (AC-5.12)', () => {
    const differences: number[] = []
    for (let used = 529; used <= 2000; used++) {
      const answer = consumptionOf(fixedPrice(null, 1.1), hours(used), 'active')
      if (answer.variant !== 'fixed_price' || answer.share?.excess?.unit !== 'man_days') throw new Error('an excess')
      if (answer.share.excess.tenths !== answer.usedTenths - answer.maxEffortTenths) differences.push(used)
    }

    expect(differences).toEqual([])
  })
})

describe('the bar (AC-5.14–5.16, D86): positions in percent of its length, its scale 0–125 % of the reference', () => {
  const bar = (used: number) => {
    const answer = consumptionOf(withPackage('yearly', 120, yearlyPeriod), hours(hm(900), used), 'active')
    if (answer.variant !== 'package' || answer.share === null) throw new Error('a package comparison')
    return answer.share.bar
  }

  it('the marks sit at 80 % and 100 % of the reference, i.e. at 64 and 80 of the bar (AC-5.14)', () => {
    expect(BAR_MARKS).toEqual({ closeToLimit: 64, over: 80 })
    expect([CLOSE_TO_LIMIT_PERCENT, OVER_PERCENT, SCALE_END_PERCENT]).toEqual([80, 100, 125])
  })

  it('nothing used fills nothing; exactly the reference fills four fifths of the bar, with no part beyond (AC-5.14, AC-5.15)', () => {
    expect(bar(0)).toMatchObject({ within: 0, beyond: 0 })
    expect(bar(3600)).toMatchObject({ within: 40, beyond: 0 })
    expect(bar(7200)).toMatchObject({ within: 80, beyond: 0 })
  })

  it('the part beyond exists exactly when the hours are above the reference: 7 200 has none, 7 201 has one (AC-5.15)', () => {
    expect(bar(7200).beyond).toBe(0)
    expect(bar(7201).beyond).toBeGreaterThan(0)
    expect(bar(7199).beyond).toBe(0)
  })

  it('above the reference the part before it stays full and the part beyond grows: 112.5 % ends 10 past the mark', () => {
    expect(bar(8100)).toMatchObject({ within: 80, beyond: 10 })
  })

  it('at exactly 125 % the fill reaches the end of the bar with nothing cut off (AC-5.16)', () => {
    expect(bar(9000)).toMatchObject({ within: 80, beyond: 20 })
  })

  it('past 125 % the bar stays filled to its end while the percentage reads in full: 180 % is 80 + 20 and "180" (AC-5.16)', () => {
    const answer = consumptionOf(withPackage('yearly', 120, yearlyPeriod), hours(hm(900), 12960), 'active')

    expect(answer).toMatchObject({ share: { consumedPercent: 180, bar: { within: 80, beyond: 20 } } })
  })
})

describe('the estimate mark (AC-5.17, D86): a fixed price with an estimate, at its share of the max effort, within the scale', () => {
  const estimateMark = (estimated: number | null, maxEffort: number) => {
    const answer = consumptionOf(fixedPrice(estimated, maxEffort), hours(0), 'active')
    if (answer.variant !== 'fixed_price' || answer.share === null) throw new Error('a fixed price comparison')
    return answer.share.bar.estimate
  }

  it('10.0 man-days against a max effort of 12.0 is at 83 % of the reference: 66.67 of the bar', () => {
    expect(estimateMark(10, 12)).toBeCloseTo(66.67, 2)
  })

  it('an estimate of 0 is at the start; one of exactly 125 % of the max effort is at the end', () => {
    expect(estimateMark(0, 12)).toBe(0)
    expect(estimateMark(15, 12)).toBe(100)
  })

  it('an estimate beyond 125 % of the max effort has no mark: 15.1 against 12.0 (and the next tenth up from the edge)', () => {
    expect(estimateMark(15.1, 12)).toBeNull()
    expect(estimateMark(12.6, 10)).toBeNull()
    expect(estimateMark(12.5, 10)).toBe(100)
  })

  it('a fixed price without an estimate, a package and time and material have no mark', () => {
    expect(estimateMark(null, 12)).toBeNull()

    const pkg = consumptionOf(withPackage('yearly', 120, yearlyPeriod), hours(0, 0), 'active')
    const tm = consumptionOf(timeAndMaterial([{ profile: 'A', plannedManDays: 5 }]), hours(0), 'active')
    expect(pkg).toMatchObject({ share: { bar: { estimate: null } } })
    expect(tm).toMatchObject({ share: { bar: { estimate: null } } })
  })

  it('the estimate stays in the figures, in whole tenths, whether or not it has a mark (AC-1.4)', () => {
    expect(consumptionOf(fixedPrice(15.1, 12), hours(0), 'active')).toMatchObject({ estimatedTenths: 151 })
  })
})

describe('elapsedPercentOf (AC-5.20, A56): the days gone of a span, today not counted, both ends counted, rounded down', () => {
  const tenDays = { from: '2026-03-01', to: '2026-03-10' }

  // AC-5.20's own vectors: 0 % up to and including the first day, 100 % only from the day after the last day, never beyond.
  it.each([
    ['2026-02-28', 0], // before the span
    ['2026-03-01', 0], // its first day
    ['2026-03-05', 40],
    ['2026-03-10', 90], // its last day
    ['2026-03-11', 100], // the day after
    ['2026-12-31', 100], // long after: never beyond
  ])('over 1–10 March 2026, on %s it is %i %%', (asOf, percent) => {
    expect(elapsedPercentOf(tenDays, asOf)).toBe(percent)
  })

  it('a span of 365 days is 99 % on its last day (364 days gone) and 100 % the day after, as is a 366-day one on its last day: 99', () => {
    expect(elapsedPercentOf({ from: '2026-03-01', to: '2027-02-28' }, '2027-02-28')).toBe(99)
    expect(elapsedPercentOf({ from: '2026-03-01', to: '2027-02-28' }, '2027-03-01')).toBe(100)
    expect(elapsedPercentOf({ from: '2027-03-01', to: '2028-02-29' }, '2028-02-29')).toBe(99)
    expect(elapsedPercentOf({ from: '2027-03-01', to: '2028-02-29' }, '2028-03-01')).toBe(100)
  })

  it('a span of one day is 0 % on that day and 100 % the day after', () => {
    expect(elapsedPercentOf({ from: '2026-03-01', to: '2026-03-01' }, '2026-03-01')).toBe(0)
    expect(elapsedPercentOf({ from: '2026-03-01', to: '2026-03-01' }, '2026-03-02')).toBe(100)
  })

  it('counts the days of a span across a year end: 20 December to 9 January is 21 days, 11 gone on 31 December', () => {
    const span = { from: '2026-12-20', to: '2027-01-09' }

    expect(elapsedPercentOf(span, '2026-12-31')).toBe(52) // 11 of 21
    expect(elapsedPercentOf(span, '2027-01-01')).toBe(57) // 12 of 21
  })

  it('counts a 29 February in a leap year and none in a common one', () => {
    expect(elapsedPercentOf({ from: '2028-02-28', to: '2028-03-01' }, '2028-02-29')).toBe(33) // 1 of 3
    expect(elapsedPercentOf({ from: '2028-02-28', to: '2028-03-01' }, '2028-03-01')).toBe(66) // 2 of 3
    expect(elapsedPercentOf({ from: '2027-02-28', to: '2027-03-01' }, '2027-03-01')).toBe(50) // 1 of 2
  })

  it('a span that ends before it starts has no time elapsed (AC-5.19)', () => {
    expect(elapsedPercentOf({ from: '2026-03-10', to: '2026-03-01' }, '2026-03-05')).toBeNull()
  })

  it.each([
    '',
    'today',
    '2026-3-5',
    '2026-03-5',
    '20260305',
    '2026-03-05T10:00:00Z',
    '2026-13-01',
    '2026-02-30',
    '2027-02-29',
    '2026-00-10',
    '2026-03-00',
    '0000-03-01',
  ])('an asOf of %j is read as absent: no time elapsed, never a guess', (asOf) => {
    expect(elapsedPercentOf(tenDays, asOf)).toBeNull()
  })

  it('a span with a date that is not a date has no time elapsed', () => {
    expect(elapsedPercentOf({ from: '2026-03-01', to: '2026-02-30' }, '2026-03-05')).toBeNull()
    expect(elapsedPercentOf({ from: 'soon', to: '2026-03-10' }, '2026-03-05')).toBeNull()
  })
})

describe('the time elapsed and the today mark (AC-5.18, AC-5.19, D90): over the span the terms have, at the day projects-api states', () => {
  /** The terms as projects-api reads them back with the day it derived them for (`asOf`, AC-5.29). */
  const at = (terms: Terms, asOf: string | undefined): Terms => (asOf === undefined ? terms : { ...terms, asOf })
  const between = (startDate: string, deadline: string, asOf: string | undefined, maxEffort = 12): Terms =>
    at(
      {
        ...base,
        type: 'fixed_price',
        startDate,
        terms: { deadline, estimatedManDays: null, maxEffortManDays: maxEffort },
      },
      asOf,
    )
  const shareOfAnswer = (answer: ReturnType<typeof consumptionOf>) => {
    if (!('share' in answer) || answer.share === null) throw new Error('a comparison has a share')
    return answer.share
  }

  it('a yearly package: the days gone of its current period; the mark at 0.8 times it (AC-5.18)', () => {
    // 1 March 2026 to 28 February 2027 is 365 days; 184 are gone on 1 September (31+30+31+30+31+31 from 1 March).
    const terms = at(withPackage('yearly', 120, yearlyPeriod), '2026-09-01')
    const share = shareOfAnswer(consumptionOf(terms, hours(0, hm(40)), 'active'))

    expect(share.elapsedPercent).toBe(50)
    expect(share.bar.today).toBeCloseTo(40, 10)
  })

  it('a capacity package with an expiry: from its start to its expiry, before it and after it (an expired one reads 100) (AC-5.18)', () => {
    const before = at(withPackage('capacity', 100, period('2026-03-01', '2026-09-30'), '2026-09-30'), '2026-06-01')
    const after = at(withPackage('capacity', 100, period('2026-03-01', '2026-09-30', true), '2026-09-30'), '2026-10-15')

    expect(shareOfAnswer(consumptionOf(before, hours(0, hm(10)), 'active')).elapsedPercent).toBe(42) // 92 of 214 days
    expect(shareOfAnswer(consumptionOf(after, hours(0, hm(10)), 'active'))).toMatchObject({
      elapsedPercent: 100,
      bar: { today: 80 },
    })
  })

  it('a fixed price: from its terms start date to its deadline (AC-5.18)', () => {
    const share = shareOfAnswer(consumptionOf(between('2026-03-01', '2026-03-10', '2026-03-05'), hours(0), 'active'))

    expect(share.elapsedPercent).toBe(40)
    expect(share.bar.today).toBeCloseTo(32, 10)
  })

  it('the mark is at the start before the span and at the 100 % mark once it is over (0 and 80)', () => {
    expect(
      shareOfAnswer(consumptionOf(between('2026-03-01', '2026-03-10', '2026-02-01'), hours(0), 'active')),
    ).toMatchObject({
      elapsedPercent: 0,
      bar: { today: 0 },
    })
    expect(
      shareOfAnswer(consumptionOf(between('2026-03-01', '2026-03-10', '2026-04-01'), hours(0), 'active')),
    ).toMatchObject({
      elapsedPercent: 100,
      bar: { today: 80 },
    })
  })

  it('a capacity package without an expiry, time and material and a deadline before the start date show no time elapsed (AC-5.19)', () => {
    const open = at(withPackage('capacity', 100, period('2026-03-01', '2026-11-27')), '2026-11-27')
    const tm = at(timeAndMaterial([{ profile: 'A', plannedManDays: 5 }]), '2026-11-27')
    const backwards = between('2026-03-10', '2026-03-01', '2026-03-05')

    for (const terms of [open, tm, backwards]) {
      expect(shareOfAnswer(consumptionOf(terms, hours(hm(10), hm(10)), 'active'))).toMatchObject({
        elapsedPercent: null,
        bar: { today: null },
      })
    }
  })

  it('does not move with the hours: more minutes in the same terms change the percentage and not the time elapsed (AC-5.28)', () => {
    const terms = { ...withPackage('yearly', 120, yearlyPeriod), asOf: '2026-09-01' }
    const before = shareOfAnswer(consumptionOf(terms, hours(0, hm(40)), 'active'))
    const after = shareOfAnswer(consumptionOf(terms, hours(0, hm(41)), 'active'))

    expect(after.consumedPercent).toBeGreaterThan(before.consumedPercent)
    expect(after.elapsedPercent).toBe(before.elapsedPercent)
    expect(after.bar.today).toBe(before.bar.today)
  })

  it.each<[string, string | undefined]>([
    ['absent (a projects-api that predates it)', undefined],
    ['empty', ''],
    ['malformed', '27.11.2026'],
    ['not a calendar day', '2026-02-30'],
  ])('an asOf that is %s gives no time elapsed and no mark, and still the percentage (R10)', (_label, asOf) => {
    const terms = at(withPackage('yearly', 120, yearlyPeriod), asOf)

    expect(shareOfAnswer(consumptionOf(terms, hours(0, hm(60)), 'active'))).toMatchObject({
      consumedPercent: 50,
      elapsedPercent: null,
      bar: { today: null },
    })
  })
})

describe('where no state is said (AC-5.25, AC-5.26, D91, D93): the figures stay, only the state goes', () => {
  const expired = (asOf = '2026-10-15') => ({
    ...withPackage('capacity', 120, period('2026-03-01', '2026-09-30', true), '2026-09-30'),
    asOf,
  })

  it('an expired capacity package says no state even if it went over, and keeps its percentage, excess and bar (AC-5.25)', () => {
    const answer = consumptionOf(expired(), hours(hm(900), 8430), 'active') // 117.08 % of 120 h

    expect(answer).toMatchObject({
      variant: 'package',
      ended: true,
      share: {
        consumedPercent: 117,
        state: null,
        excess: { unit: 'hours', minutes: 1230 },
        bar: { within: 80 },
      },
    })
    if (answer.variant !== 'package' || answer.share === null) throw new Error('a package comparison')
    expect(answer.share.bar.beyond).toBeGreaterThan(0)
  })

  it('an expired capacity package that stayed within its hours says no state either, not "on track"', () => {
    expect(consumptionOf(expired(), hours(hm(900), 7000), 'active')).toMatchObject({ share: { state: null } })
  })

  it('on the expiry day itself the package has not expired and has its state like any other (AC-5.25)', () => {
    const lastDay = {
      ...withPackage('capacity', 120, period('2026-03-01', '2026-09-30'), '2026-09-30'),
      asOf: '2026-09-30',
    }

    expect(consumptionOf(lastDay, hours(hm(900), 8430), 'active')).toMatchObject({
      ended: false,
      share: { state: 'over' },
    })
  })

  it.each<ProjectState>(['closed', 'cancelled'])(
    'a %s project says no state, with the percentage, excess, bar and time elapsed read as for any other (AC-5.26)',
    (state) => {
      const terms = { ...withPackage('yearly', 120, yearlyPeriod), asOf: '2026-09-01' }

      expect(consumptionOf(terms, hours(0, 8430), state)).toMatchObject({
        share: {
          consumedPercent: 117,
          state: null,
          excess: { unit: 'hours', minutes: 1230 },
          elapsedPercent: 50,
        },
      })
      expect(consumptionOf(fixedPrice(10, 12), hours(hm(108)), state)).toMatchObject({
        share: { consumedPercent: 112, state: null, excess: { unit: 'man_days', tenths: 15 } },
      })
      expect(
        consumptionOf(timeAndMaterial([{ profile: 'A', plannedManDays: 10 }]), hours(hm(60)), state),
      ).toMatchObject({
        share: { consumedPercent: 75, state: null },
      })
    },
  )

  it.each<ProjectState>(['planned', 'active', 'on_hold'])(
    'its state is said on a project that is %s (AC-5.26)',
    (state) => {
      expect(consumptionOf(withPackage('yearly', 120, yearlyPeriod), hours(0, 8430), state)).toMatchObject({
        share: { state: 'over' },
      })
      expect(consumptionOf(fixedPrice(null, 12), hours(hm(10)), state)).toMatchObject({ share: { state: 'on_track' } })
    },
  )
})

describe('no share where nothing is compared (AC-5.4): no percentage, state, excess, bar or time elapsed', () => {
  it('no terms, an SLA and no hour package, a package that has not started and a read that failed carry no share at all', () => {
    const slaOnly: Terms = {
      ...base,
      type: 'maintenance',
      terms: { sla: { highDays: 1, normalDays: 3 }, hourPackage: null },
    }
    const notStarted = withPackage('capacity', 120, null)
    const answers = [
      consumptionOf(null, hours(hm(10), hm(10)), 'active'),
      consumptionOf(slaOnly, hours(hm(10), hm(10)), 'active'),
      consumptionOf(notStarted, hours(hm(10), hm(10)), 'active'),
      consumptionOf(withPackage('yearly', 120, yearlyPeriod), null, 'active'),
      consumptionOf(fixedPrice(10), null, 'active'),
      consumptionOf(timeAndMaterial([{ profile: 'A', plannedManDays: 5 }]), null, 'active'),
    ]

    for (const answer of answers) {
      expect(answer).not.toHaveProperty('share')
    }
  })

  // The schemas forbid a reference of zero (F17), but a hand-built one must not divide by it or print "NaN %".
  it.each<[string, Terms]>([
    ['a package of 0 hours', withPackage('yearly', 0, yearlyPeriod)],
    ['a fixed price with a max effort of 0', fixedPrice(null, 0)],
    ['time and material with no position', timeAndMaterial([])],
    ['time and material planned at 0', timeAndMaterial([{ profile: 'A', plannedManDays: 0 }])],
  ])('%s has a share of null, never a figure from a division by zero', (_label, terms) => {
    const answer = consumptionOf(terms, hours(hm(10), hm(10)), 'active')

    expect(answer).toHaveProperty('share', null)
  })

  it('the figures of the terms stay when there is no share: the package still says its hours used and left', () => {
    expect(consumptionOf(withPackage('yearly', 0, yearlyPeriod), hours(hm(10), hm(10)), 'active')).toMatchObject({
      variant: 'package',
      usedMinutes: hm(10),
      leftMinutes: 0,
      overByMinutes: hm(10),
      share: null,
    })
  })
})

describe('dateSignalsOf (AC-5.21–5.24, D89, D94): the terms end date and a fixed price deadline against the day projects-api states', () => {
  /** SLA and hours terms with an end date, as `asOf` days stated by the server. */
  const ending = (endDate: string | null, asOf: string | null = '2026-11-27'): Terms => ({
    ...base,
    type: 'maintenance',
    terms: { sla: { highDays: 1, normalDays: 3 }, hourPackage: null },
    endDate,
    ...(asOf === null ? {} : { asOf }),
  })
  const fixedPriceDue = (deadline: string, endDate: string | null, asOf: string | null = '2026-11-27'): Terms => ({
    ...base,
    type: 'fixed_price',
    terms: { deadline, estimatedManDays: null, maxEffortManDays: 12 },
    endDate,
    ...(asOf === null ? {} : { asOf }),
  })

  it.each([
    ['2026-11-26', 1], // the day after: passed by 1 day (AC-5.21)
    ['2026-11-25', 2],
    ['2026-05-11', 200],
    ['2025-11-27', 365],
  ])('an end date of %s has passed by %i day(s), at the graver level (AC-5.21)', (endDate, days) => {
    expect(dateSignalsOf(ending(endDate), 'active')).toEqual([
      { which: 'end_date', date: endDate, when: 'passed', days, level: 'graver' },
    ])
  })

  it.each([
    ['2026-11-27', 0], // the day itself: today, not passed (D94)
    ['2026-11-28', 1],
    ['2026-12-27', 30], // exactly 30 days ahead is said (AC-5.22)
  ])('an end date of %s is near, in %i day(s), at the milder level (AC-5.22)', (endDate, days) => {
    expect(dateSignalsOf(ending(endDate), 'active')).toEqual([
      { which: 'end_date', date: endDate, when: 'near', days, level: 'milder' },
    ])
  })

  it('31 days ahead says nothing (AC-5.22)', () => {
    expect(dateSignalsOf(ending('2026-12-28'), 'active')).toEqual([])
  })

  it('counts across a year end and over a 29 February: 30 days is near, 31 is not (AC-5.22)', () => {
    expect(dateSignalsOf(ending('2027-01-14', '2026-12-15'), 'active')).toMatchObject([{ when: 'near', days: 30 }])
    expect(dateSignalsOf(ending('2027-01-15', '2026-12-15'), 'active')).toEqual([])
    expect(dateSignalsOf(ending('2028-03-16', '2028-02-15'), 'active')).toMatchObject([{ when: 'near', days: 30 }])
    expect(dateSignalsOf(ending('2028-03-17', '2028-02-15'), 'active')).toEqual([])
    expect(dateSignalsOf(ending('2027-03-16', '2027-02-15'), 'active')).toMatchObject([{ when: 'near', days: 29 }])
  })

  it('a fixed price has its deadline first, then its end date, each judged on its own (AC-5.21, AC-5.23)', () => {
    expect(dateSignalsOf(fixedPriceDue('2026-12-07', '2026-11-20'), 'active')).toEqual([
      { which: 'deadline', date: '2026-12-07', when: 'near', days: 10, level: 'milder' },
      { which: 'end_date', date: '2026-11-20', when: 'passed', days: 7, level: 'graver' },
    ])
  })

  it('the deadline comes first whether it falls before the end date or after it: the order is by kind, not by date (AC-5.23)', () => {
    const early = dateSignalsOf(fixedPriceDue('2026-11-20', '2026-12-07'), 'active')
    const late = dateSignalsOf(fixedPriceDue('2026-12-07', '2026-11-20'), 'active')

    expect(early.map((signal) => [signal.which, signal.when])).toEqual([
      ['deadline', 'passed'],
      ['end_date', 'near'],
    ])
    expect(late.map((signal) => [signal.which, signal.when])).toEqual([
      ['deadline', 'near'],
      ['end_date', 'passed'],
    ])
  })

  it('a deadline and an end date on the same day are two lines, the deadline first (AC-5.23)', () => {
    const signals = dateSignalsOf(fixedPriceDue('2026-12-01', '2026-12-01'), 'active')

    expect(signals.map((signal) => signal.which)).toEqual(['deadline', 'end_date'])
    expect(signals.map((signal) => signal.days)).toEqual([4, 4])
  })

  it('a date with nothing to say gives no line, and terms without an end date have none for it (AC-5.23)', () => {
    expect(dateSignalsOf(fixedPriceDue('2026-12-07', null), 'active')).toMatchObject([{ which: 'deadline' }])
    expect(dateSignalsOf(fixedPriceDue('2027-06-01', '2027-06-01'), 'active')).toEqual([])
    expect(dateSignalsOf(ending(null), 'active')).toEqual([])
  })

  it('only a fixed price has a deadline: time and material and a package have their end date alone (AC-5.21)', () => {
    const tm: Terms = { ...base, type: 't_and_m', terms: { positions: [] }, endDate: '2026-11-26', asOf: '2026-11-27' }

    expect(dateSignalsOf(tm, 'active')).toMatchObject([{ which: 'end_date', when: 'passed', days: 1 }])
  })

  it.each<ProjectState>(['closed', 'cancelled'])('a %s project shows no date signal at all (AC-5.26, D93)', (state) => {
    expect(dateSignalsOf(fixedPriceDue('2026-11-20', '2026-12-07'), state)).toEqual([])
  })

  it.each<ProjectState>(['planned', 'active', 'on_hold'])(
    'the dates show on a project that is %s (AC-5.26)',
    (state) => {
      expect(dateSignalsOf(ending('2026-11-26'), state)).toHaveLength(1)
    },
  )

  it('reads the terms alone: it shows for terms that sold nothing comparable and for a package that has not started (AC-5.24)', () => {
    expect(dateSignalsOf(ending('2026-11-26'), 'active')).toHaveLength(1) // an SLA and no hour package
    const notStarted: Terms = { ...withPackage('capacity', 120, null), endDate: '2026-11-26', asOf: '2026-11-27' }
    expect(dateSignalsOf(notStarted, 'active')).toHaveLength(1)
    expect(dateSignalsOf.length).toBe(2) // (terms, projectState): no summary, no person, no role
  })

  it.each<[string, string | null]>([
    ['absent', null],
    ['empty', ''],
    ['malformed', '27.11.2026'],
    ['not a calendar day', '2026-02-30'],
  ])('an asOf that is %s gives no date signal, never a guess (R10)', (_label, asOf) => {
    expect(dateSignalsOf(fixedPriceDue('2026-11-20', '2026-11-26', asOf), 'active')).toEqual([])
  })

  it('no terms and a date that is not a date give none', () => {
    expect(dateSignalsOf(null, 'active')).toEqual([])
    expect(dateSignalsOf(ending('soon'), 'active')).toEqual([])
  })
})

describe('hasConsumptionBlock (AC-1.7 amended, D82, D89): a compared or not-started variant, or at least one date signal', () => {
  const slaOnly = (endDate: string | null, asOf = '2026-11-27'): Terms => ({
    ...base,
    type: 'maintenance',
    terms: { sla: { highDays: 1, normalDays: 3 }, hourPackage: null },
    endDate,
    asOf,
  })

  it('no terms: never a block', () => {
    expect(hasConsumptionBlock(null, 'active')).toBe(false)
  })

  it('terms of an SLA and no hour package with no end date, or one more than 30 days ahead: the widget alone', () => {
    expect(hasConsumptionBlock(slaOnly(null), 'active')).toBe(false)
    expect(hasConsumptionBlock(slaOnly('2026-12-28'), 'active')).toBe(false)
  })

  it('the same terms whose end date has passed or is near: a block of date lines alone', () => {
    expect(hasConsumptionBlock(slaOnly('2026-11-26'), 'active')).toBe(true)
    expect(hasConsumptionBlock(slaOnly('2026-11-27'), 'active')).toBe(true)
    expect(hasConsumptionBlock(slaOnly('2026-12-27'), 'active')).toBe(true)
  })

  it.each<ProjectState>(['closed', 'cancelled'])(
    'the same terms of a %s project: the widget alone, whatever the date',
    (state) => {
      expect(hasConsumptionBlock(slaOnly('2026-11-26'), state)).toBe(false)
    },
  )

  it('a package, a fixed price, time and material and a package that has not started always have one (their figures need no date)', () => {
    const everything: Terms[] = [
      withPackage('yearly', 120, yearlyPeriod),
      withPackage('capacity', 120, null),
      fixedPrice(null),
      timeAndMaterial([{ profile: 'A', plannedManDays: 5 }]),
    ]

    for (const terms of everything) {
      expect(hasConsumptionBlock(terms, 'active')).toBe(true)
    }
  })

  it('a closed or cancelled project keeps its block of figures: only the state and the dates go (AC-5.26)', () => {
    expect(hasConsumptionBlock(fixedPrice(null), 'closed')).toBe(true)
    expect(hasConsumptionBlock(withPackage('yearly', 120, yearlyPeriod), 'cancelled')).toBe(true)
  })

  it('a package from a projects-api that predates the period, with no date to judge: nothing to compare, so none', () => {
    expect(hasConsumptionBlock(withPackage('yearly', 120, undefined), 'active')).toBe(false)
  })

  it('terms with nothing in them (a SaaS project with an empty set) have none', () => {
    expect(hasConsumptionBlock({ ...base, type: 'saas', terms: { sla: null, hourPackage: null } }, 'active')).toBe(
      false,
    )
  })

  it('agrees with what the block would draw: a figure variant of consumptionOf, or a date signal', () => {
    const cases: [Terms | null, ProjectState][] = [
      [null, 'active'],
      [slaOnly(null), 'active'],
      [slaOnly('2026-11-26'), 'active'],
      [slaOnly('2026-11-26'), 'closed'],
      [withPackage('capacity', 120, null), 'active'],
      [withPackage('yearly', 120, undefined), 'active'],
      [fixedPrice(null), 'cancelled'],
    ]

    for (const [terms, state] of cases) {
      const figures = consumptionOf(terms, hours(hm(10), hm(10)), state).variant !== 'none'
      expect(hasConsumptionBlock(terms, state)).toBe(figures || dateSignalsOf(terms, state).length > 0)
    }
  })
})

describe('levelOfState (D87): the milder level is a warning, the graver a danger, and on track has none', () => {
  it.each([
    ['on_track', null],
    ['close_to_limit', 'milder'],
    ['over', 'graver'],
  ] as const)('%s is %s', (state, level) => {
    expect(levelOfState(state)).toBe(level)
  })
})

describe('no clock, no time zone, no viewer (AC-5.29, AC-5.27): every signal is a function of what it is given', () => {
  const source = readFileSync(fileURLToPath(new URL('./consumption.ts', import.meta.url)), 'utf8')
  const originalTz = process.env.TZ

  afterEach(() => {
    vi.useRealTimers()
    if (originalTz === undefined) delete process.env.TZ
    else process.env.TZ = originalTz
  })

  it('the module reads no clock: no Date.now( and no new Date( anywhere in its source (AC-5.29)', () => {
    expect(source).not.toContain('Date.now(')
    expect(source).not.toContain('new Date(')
  })

  /** Every signal of one project, worked out in one go from the terms as projects-api read them. */
  const signalsOnAPage = () => {
    const terms: Terms = {
      ...base,
      type: 'fixed_price',
      terms: { deadline: '2026-12-07', estimatedManDays: 10, maxEffortManDays: 12 },
      endDate: '2026-11-20',
      asOf: '2026-11-27',
    }
    const yearly: Terms = { ...withPackage('yearly', 120, yearlyPeriod), asOf: '2026-11-27' }
    return [
      consumptionOf(terms, hours(hm(60)), 'active'),
      consumptionOf(yearly, hours(0, hm(60)), 'active'),
      dateSignalsOf(terms, 'active'),
      hasConsumptionBlock(terms, 'active'),
      elapsedPercentOf({ from: '2026-03-01', to: '2027-02-28' }, '2026-11-27'),
    ]
  }

  it("answers the same whatever day the browser holds and whatever its time zone is: the day is the server's (AC-5.29)", () => {
    const expected = signalsOnAPage()

    for (const [now, zone] of [
      ['2020-01-01T00:00:00Z', 'UTC'],
      ['2026-11-27T23:59:59Z', 'Pacific/Kiritimati'], // already the 28th there
      ['2026-11-27T00:00:00Z', 'Pacific/Pago_Pago'], // still the 26th there
      ['2031-06-30T12:00:00Z', 'Europe/Zurich'],
    ]) {
      vi.useFakeTimers()
      vi.setSystemTime(new Date(now))
      process.env.TZ = zone

      expect(signalsOnAPage()).toEqual(expected)

      vi.useRealTimers()
    }
  })

  it('no function takes a person, a role or a permission: each is a function of the terms, the state and the figures alone (AC-5.27)', () => {
    const arities = Object.fromEntries(
      Object.entries(consumption as Record<string, unknown>)
        .filter(([, value]) => typeof value === 'function')
        .map(([name, fn]) => [name, (fn as (...args: unknown[]) => unknown).length]),
    )

    expect(arities).toEqual({
      consumptionOf: 3, // (terms, summary, projectState)
      dateSignalsOf: 2, // (terms, projectState)
      elapsedPercentOf: 2, // (span, asOf)
      hasConsumptionBlock: 2, // (terms, projectState)
      levelOfState: 1,
      summaryRequestOf: 1,
    })
  })
})

describe('no money anywhere (AC-1.8)', () => {
  it('the module imports types only: no formatter, no library, nothing that could format an amount', () => {
    const source = readFileSync(fileURLToPath(new URL('./consumption.ts', import.meta.url)), 'utf8')
    const imports = source.match(/^import .*$/gm) ?? []

    expect(imports).toEqual(["import type { HourPackageKind, ProjectState, Terms } from './types'"])
  })
})
