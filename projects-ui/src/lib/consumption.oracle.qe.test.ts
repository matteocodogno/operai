/**
 * QE pass 4 (specs/20261112-project-hours, US-5): a differential check of `lib/consumption.ts` against an independent oracle.
 *
 * The unit tests of `consumption.test.ts` pin the spec's own examples and a state-against-percentage property for six
 * references. This file asks a different question: is every figure of the signals what the spec's TEXT says, over a wide
 * seeded sample — including the boundaries where a rounding or a day-count slip hides (80 %, 100 %, 125 %, a leap day, a year end,
 * 30 and 31 days)? The oracle is written from the AC wording and shares nothing with the product's arithmetic: days are
 * `Date.UTC` day numbers (the product counts civil dates by integer algorithm), minutes and percentages are `BigInt` cross
 * multiplications (the product uses `Number` integer division). A mismatch is a defect in one of the two, and the oracle is
 * short enough to read against AC-5.5 to AC-5.22.
 */
import { describe, expect, it } from 'vitest'
import { consumptionOf, dateSignalsOf, elapsedPercentOf } from './consumption'
import type { CurrentPeriod, ProjectState, Terms } from './types'

// A seeded PRNG (mulberry32): the same sample on every run, so a failure is reproducible.
const prng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const pickOf = <T>(rand: () => number, list: readonly T[]): T => list[Math.floor(rand() * list.length)]!
const intIn = (rand: () => number, lo: number, hi: number): number => lo + Math.floor(rand() * (hi - lo + 1))

// ─── The oracle's days: Date.UTC day numbers ─────────────────────────────────

const dayNo = (iso: string): number => {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number]
  return Date.UTC(y, m - 1, d) / 86_400_000
}
const isoOf = (n: number): string => new Date(n * 86_400_000).toISOString().slice(0, 10)

/** AC-5.20 in words: the days gone (first day to the day before today, held between none and all) over all its days, rounded down. */
const elapsedOracle = (from: string, to: string, asOf: string): number | null => {
  const days = dayNo(to) - dayNo(from) + 1
  if (days < 1) return null
  const gone = Math.min(Math.max(dayNo(asOf) - dayNo(from), 0), days)
  return Number((100n * BigInt(gone)) / BigInt(days))
}

/** Dates that tend to hide a calendar slip: month ends, leap days, century years, year ends. */
const awkwardDays = (() => {
  const days: number[] = []
  for (const year of [1900, 1999, 2000, 2023, 2024, 2025, 2026, 2027, 2028, 2096, 2100, 2101, 2399, 2400]) {
    for (const [m, d] of [
      [1, 1],
      [1, 31],
      [2, 28],
      [2, 29],
      [3, 1],
      [4, 30],
      [6, 30],
      [8, 31],
      [12, 30],
      [12, 31],
    ] as const) {
      const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
      if (m === 2 && d === 29 && !leap) continue
      days.push(dayNo(`${year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`))
    }
  }
  return days
})()

describe('elapsedPercentOf against a Date.UTC oracle (AC-5.20, A56)', () => {
  it('agrees over 60 000 seeded spans and days across 1900–2400, calendar-awkward starts and the days around each end', () => {
    const rand = prng(20261127)
    const mismatches: string[] = []
    for (let i = 0; i < 60_000; i++) {
      const from =
        rand() < 0.5
          ? pickOf(rand, awkwardDays) + intIn(rand, -2, 2)
          : intIn(rand, dayNo('1900-01-01'), dayNo('2400-12-31'))
      const length = pickOf(rand, [1, 2, 7, 10, 30, 31, 90, 200, 365, 366, 730, 1461, intIn(rand, 1, 1500)])
      const to = from + length - 1
      // the day itself, the day before and after the start and the end, and a random day in and around the span
      const asOf = pickOf(rand, [
        from - 1,
        from,
        from + 1,
        to - 1,
        to,
        to + 1,
        to + 2,
        from + intIn(rand, -30, length + 30),
      ])
      const got = elapsedPercentOf({ from: isoOf(from), to: isoOf(to) }, isoOf(asOf))
      const want = elapsedOracle(isoOf(from), isoOf(to), isoOf(asOf))
      if (got !== want) mismatches.push(`${isoOf(from)}..${isoOf(to)} @ ${isoOf(asOf)}: got ${got}, want ${want}`)
    }

    expect(mismatches.slice(0, 5)).toEqual([])
  })

  it('has no time elapsed for a span that ends before it starts (AC-5.19) and for a date that is not on the calendar, the century leap rule included', () => {
    const rand = prng(19)
    for (let i = 0; i < 2_000; i++) {
      const from = intIn(rand, dayNo('1950-01-01'), dayNo('2300-12-31'))
      const back = intIn(rand, 1, 400)
      expect(elapsedPercentOf({ from: isoOf(from), to: isoOf(from - back) }, isoOf(from))).toBeNull()
    }
    // 29 February exists in 2000, 2024 and 2400 (divisible by 4, and by 400 when by 100) and in no other year of the list
    const valid = ['2000-02-29', '2024-02-29', '2400-02-29', '1996-02-29']
    const notDates = [
      '1900-02-29',
      '2100-02-29',
      '2200-02-29',
      '2300-02-29',
      '2023-02-29',
      '2026-02-29',
      '2026-04-31',
      '2026-13-01',
      '2026-00-10',
    ]
    for (const day of valid) expect(elapsedPercentOf({ from: day, to: '2500-01-01' }, '2500-01-02')).toBe(100)
    for (const day of notDates) {
      expect(elapsedPercentOf({ from: day, to: '2500-01-01' }, '2500-01-02')).toBeNull()
      expect(elapsedPercentOf({ from: '1800-01-01', to: day }, '2500-01-02')).toBeNull()
      expect(elapsedPercentOf({ from: '1800-01-01', to: '2500-01-01' }, day)).toBeNull()
    }
  })

  it('reads 100 only from the day after the last day, whatever the length (the A56 reason for rounding down)', () => {
    const rand = prng(56)
    for (let i = 0; i < 5_000; i++) {
      const from = intIn(rand, dayNo('1950-01-01'), dayNo('2200-12-31'))
      const length = intIn(rand, 1, 4_000)
      const to = from + length - 1
      expect(elapsedPercentOf({ from: isoOf(from), to: isoOf(to) }, isoOf(to))).toBeLessThan(100)
      expect(elapsedPercentOf({ from: isoOf(from), to: isoOf(to) }, isoOf(to + 1))).toBe(100)
      expect(elapsedPercentOf({ from: isoOf(from), to: isoOf(to) }, isoOf(from))).toBe(0)
    }
  })
})

// ─── The oracle's share: BigInt cross multiplication ─────────────────────────

type Shape = { used: number; reference: number }
const percentOracle = ({ used, reference }: Shape): number => Number((100n * BigInt(used)) / BigInt(reference))
const stateOracle = ({ used, reference }: Shape): 'on_track' | 'close_to_limit' | 'over' =>
  100n * BigInt(used) < 80n * BigInt(reference) ? 'on_track' : used < reference ? 'close_to_limit' : 'over'

/** Used minutes that sit on the edges the AC examples name — 80 %, 100 %, 125 % — one minute either side — and random ones. */
const usedAround = (rand: () => number, reference: number): number => {
  const edge = pickOf(rand, [0, 79, 80, 99, 100, 101, 124, 125, 126, 180])
  const anchor = Math.floor((reference * edge) / 100)
  return rand() < 0.7 ? Math.max(0, anchor + intIn(rand, -2, 2)) : intIn(rand, 0, Math.ceil(reference * 2.6))
}

const withPackage = (
  hours: number,
  period: CurrentPeriod,
  kind: 'yearly' | 'capacity',
  expiry: string | null,
): Terms => ({
  id: 't',
  type: 'maintenance',
  startDate: '2026-03-01',
  endDate: null,
  version: 1,
  asOf: '2026-09-01',
  terms: {
    sla: null,
    hourPackage: { hours, kind, startDate: '2026-03-01', expiryDate: expiry, currentPeriod: period },
  },
})

describe('the share against a BigInt oracle (AC-5.5–5.9, AC-5.12–5.16, A53)', () => {
  it('a package: percentage, state, excess, "over by" and bar positions agree over 30 000 seeded hours and package sizes', () => {
    const rand = prng(5)
    const bad: string[] = []
    for (let i = 0; i < 30_000; i++) {
      const hours = intIn(rand, 1, 3_000)
      const reference = hours * 60
      const used = usedAround(rand, reference)
      const answer = consumptionOf(
        withPackage(hours, { from: '2026-03-01', to: '2027-02-28', ended: false }, 'yearly', null),
        { totalMinutes: used + 123, windowMinutes: used },
        'active',
      )
      if (answer.variant !== 'package' || answer.share === null) {
        bad.push(`no share at ${used}/${reference}`)
        continue
      }
      const { share } = answer
      const shape = { used, reference }
      if (share.consumedPercent !== percentOracle(shape))
        bad.push(`percent ${used}/${reference}: ${share.consumedPercent} != ${percentOracle(shape)}`)
      if (share.state !== stateOracle(shape))
        bad.push(`state ${used}/${reference}: ${share.state} != ${stateOracle(shape)}`)
      if ((share.excess?.unit === 'hours' ? share.excess.minutes : 0) !== Math.max(0, used - reference))
        bad.push(`excess ${used}/${reference}`)
      if (share.excess !== null && share.excess.unit !== 'hours') bad.push('package excess unit')
      if ((share.excess === null) !== used <= reference) bad.push(`excess presence ${used}/${reference}`)
      if (
        answer.overByMinutes !== Math.max(0, used - reference) ||
        answer.leftMinutes !== Math.max(0, reference - used)
      )
        bad.push(`left/over ${used}/${reference}`)
      // the bar: the fill up to the reference on a 0–125 % scale (the 100 % mark is at 80 of the bar), the part beyond never past the end
      const within = (80 * Math.min(used, reference)) / reference
      const beyond = used > reference ? Math.min((80 * (used - reference)) / reference, 20) : 0
      if (Math.abs(share.bar.within - within) > 1e-9) bad.push(`within ${used}/${reference}`)
      if (Math.abs(share.bar.beyond - beyond) > 1e-9) bad.push(`beyond ${used}/${reference}`)
      if (share.bar.beyond > 0 !== used > reference) bad.push(`beyond presence ${used}/${reference}`)
      // D92: the floored percentage never contradicts the state
      const reads = share.consumedPercent < 80 ? 'on_track' : share.consumedPercent < 100 ? 'close_to_limit' : 'over'
      if (reads !== share.state) bad.push(`percent contradicts state ${used}/${reference}`)
    }

    expect(bad.slice(0, 5)).toEqual([])
  })

  it('a fixed price and time and material: the reference is whole tenths of a man-day, the excess is rounded half up once, the estimate mark within the scale only', () => {
    const rand = prng(88)
    const bad: string[] = []
    for (let i = 0; i < 30_000; i++) {
      const maxTenths = intIn(rand, 1, 1_500)
      const reference = maxTenths * 48
      const used = usedAround(rand, reference)
      const estimateTenths = rand() < 0.2 ? null : intIn(rand, 0, Math.floor(maxTenths * 1.6))
      const fixed: Terms = {
        id: 't',
        type: 'fixed_price',
        startDate: '2026-01-01',
        endDate: null,
        version: 1,
        asOf: '2026-06-01',
        terms: {
          deadline: '2026-12-31',
          estimatedManDays: estimateTenths === null ? null : estimateTenths / 10,
          maxEffortManDays: maxTenths / 10,
        },
      }
      const f = consumptionOf(fixed, { totalMinutes: used, windowMinutes: null }, 'active')
      if (f.variant !== 'fixed_price' || f.share === null) {
        bad.push(`no share ${used}/${reference}`)
        continue
      }
      const shape = { used, reference }
      if (f.share.consumedPercent !== percentOracle(shape)) bad.push(`fixed percent ${used}/${reference}`)
      if (f.share.state !== stateOracle(shape)) bad.push(`fixed state ${used}/${reference}`)
      if (used > reference) {
        const excessMinutes = used - reference
        const tenths = Number((BigInt(excessMinutes) * 10n * 2n + 480n) / 960n) // half up, once
        if (
          f.share.excess?.unit !== 'man_days' ||
          f.share.excess.tenths !== tenths ||
          f.share.excess.belowOneTenth !== (tenths === 0)
        )
          bad.push(`fixed excess ${used}/${reference}`)
      } else if (f.share.excess !== null) bad.push(`fixed excess where none ${used}/${reference}`)
      // AC-5.17: the estimate sits at its share of the max effort when that is within the scale, ends included
      const within = estimateTenths !== null && 100 * estimateTenths <= 125 * maxTenths
      if ((f.share.bar.estimate !== null) !== within) bad.push(`estimate presence ${estimateTenths}/${maxTenths}`)
      else if (within && Math.abs(f.share.bar.estimate! - (80 * estimateTenths!) / maxTenths) > 1e-9)
        bad.push(`estimate position ${estimateTenths}/${maxTenths}`)

      // time and material: a total of positions, summed in tenths
      const positions = Array.from({ length: intIn(rand, 1, 4) }, () => intIn(rand, 1, 400))
      const planned = positions.reduce((s, p) => s + p, 0)
      const tm: Terms = {
        id: 't',
        type: 't_and_m',
        startDate: '2026-01-01',
        endDate: null,
        version: 1,
        asOf: '2026-06-01',
        terms: { positions: positions.map((p, index) => ({ profile: `P${index}`, plannedManDays: p / 10 })) },
      }
      const tmUsed = usedAround(rand, planned * 48)
      const t = consumptionOf(tm, { totalMinutes: tmUsed, windowMinutes: null }, 'active')
      if (t.variant !== 't_and_m' || t.share === null) {
        bad.push('no tm share')
        continue
      }
      if (t.share.consumedPercent !== percentOracle({ used: tmUsed, reference: planned * 48 }))
        bad.push(`tm percent ${tmUsed}/${planned * 48}`)
      if (t.share.state !== stateOracle({ used: tmUsed, reference: planned * 48 }))
        bad.push(`tm state ${tmUsed}/${planned * 48}`)
      if (t.share.elapsedPercent !== null || t.share.bar.today !== null || t.share.bar.estimate !== null)
        bad.push('tm has a span or an estimate')
    }

    expect(bad.slice(0, 5)).toEqual([])
  })

  it('no state is said for an ended capacity package and for a closed or cancelled project, whatever the hours; everything else of the share stays (AC-5.25, AC-5.26)', () => {
    const rand = prng(25)
    for (let i = 0; i < 3_000; i++) {
      const hours = intIn(rand, 1, 500)
      const used = usedAround(rand, hours * 60)
      const ended = rand() < 0.5
      const projectState = pickOf(rand, ['planned', 'active', 'on_hold', 'closed', 'cancelled'] as ProjectState[])
      const terms = withPackage(hours, { from: '2025-06-01', to: '2026-05-31', ended }, 'capacity', '2026-05-31')
      const answer = consumptionOf(terms, { totalMinutes: used, windowMinutes: used }, projectState)
      if (answer.variant !== 'package' || answer.share === null) throw new Error('a package has a share')
      const finished = projectState === 'closed' || projectState === 'cancelled'
      expect(answer.share.state === null).toBe(ended || finished)
      if (!(ended || finished)) expect(answer.share.state).toBe(stateOracle({ used, reference: hours * 60 }))
      expect(answer.share.consumedPercent).toBe(percentOracle({ used, reference: hours * 60 }))
      expect((answer.share.excess === null) === used <= hours * 60).toBe(true)
    }
  })
})

// ─── The oracle's date lines ─────────────────────────────────────────────────

describe('dateSignalsOf against a Date.UTC oracle (AC-5.21–5.24, D89, D94)', () => {
  it('judges a deadline and an end date on their own, in whole days from the page day, over 20 000 seeded pairs and project states', () => {
    const rand = prng(21)
    const bad: string[] = []
    for (let i = 0; i < 20_000; i++) {
      const asOfDay = rand() < 0.5 ? pickOf(rand, awkwardDays) : intIn(rand, dayNo('1950-01-01'), dayNo('2300-12-31'))
      const offset = () => pickOf(rand, [-400, -31, -2, -1, 0, 1, 2, 29, 30, 31, 32, 400, intIn(rand, -60, 60)])
      const deadlineOffset = offset()
      const endOffset = offset()
      const hasEnd = rand() < 0.8
      const projectState = pickOf(rand, ['planned', 'active', 'on_hold', 'closed', 'cancelled'] as ProjectState[])
      const terms: Terms = {
        id: 't',
        type: 'fixed_price',
        startDate: '1900-01-01',
        endDate: hasEnd ? isoOf(asOfDay + endOffset) : null,
        version: 1,
        asOf: isoOf(asOfDay),
        terms: { deadline: isoOf(asOfDay + deadlineOffset), estimatedManDays: null, maxEffortManDays: 1 },
      }
      const got = dateSignalsOf(terms, projectState)
      const want: { which: string; when: 'passed' | 'near'; days: number }[] = []
      if (projectState !== 'closed' && projectState !== 'cancelled') {
        for (const [which, off] of [
          ['deadline', deadlineOffset],
          ['end_date', hasEnd ? endOffset : null],
        ] as const) {
          if (off === null) continue
          if (off < 0) want.push({ which, when: 'passed', days: -off })
          else if (off <= 30) want.push({ which, when: 'near', days: off })
        }
      }
      const gotShort = got.map((s) => ({ which: s.which, when: s.when, days: s.days }))
      if (JSON.stringify(gotShort) !== JSON.stringify(want))
        bad.push(
          `@${isoOf(asOfDay)} deadline ${deadlineOffset} end ${hasEnd ? endOffset : 'none'} ${projectState}: ${JSON.stringify(gotShort)} != ${JSON.stringify(want)}`,
        )
      for (const s of got) {
        if (s.level !== (s.when === 'passed' ? 'graver' : 'milder')) bad.push('level')
        // the signal carries its own date, to be shown beside the words (AC-5.21)
        const own = s.which === 'deadline' ? deadlineOffset : endOffset
        if (s.date !== isoOf(asOfDay + own)) bad.push(`date ${s.date}`)
      }
    }

    expect(bad.slice(0, 5)).toEqual([])
  })
})
