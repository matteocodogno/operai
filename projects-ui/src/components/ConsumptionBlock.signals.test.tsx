/**
 * @vitest-environment jsdom
 *
 * ConsumptionBlock — the signals of US-5 (specs/20261112-project-hours AC-5.1–5.4, AC-5.7–5.13, AC-5.18, AC-5.19, AC-5.21–5.28,
 * AC-1.7 amended; design S1.1, its 19 states; plan § Signals on the consumption block): under its facts the block says in
 * words whether the project is on track, close to what was sold or over it, how much of the period has gone, and whether a
 * date has passed or is near. The pure rules are `lib/consumption.test.ts`'s; this file is the seam between them and the
 * screen — what the state line, the bar, the pace line, the excess and the date lines say, for each state of the share and of
 * the date lines. No figure is computed here: the numbers below are the ones the spec's own examples give.
 *
 * Day counts are worked out from the `asOf` each fixture carries (projects-api's Europe/Zurich day), never from this
 * machine's clock (AC-5.29).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { Icon } from '@operai/ui'
import type { IconName } from '@operai/ui'
import { fakeApi, problem, termsOf } from '../test-support/fakeApi'
import type { FakeAnswer } from '../test-support/fakeApi'
import { TIME_ENTRY_RECORDED } from '../lib/timeEntryRecordedEvent'
import type { CurrentPeriod, ProjectState, Terms } from '../lib/types'
import ConsumptionBlock from './ConsumptionBlock'

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }))

vi.mock('shell/session', () => ({
  usePermissions: () => ({ epoch: 0, apps: [], roles: [], departments: [], permissions: [] }),
  apiFetch,
  getProjectsApiBaseUrl: () => 'http://projects-api.test',
  getAuthBaseUrl: () => 'http://auth.test',
  getActivitiesApiBaseUrl: () => 'http://activities-api.test',
  getHoursApiBaseUrl: () => 'http://hours-api.test',
  useSession: () => ({ data: { user: { id: 'u-ada', name: 'Ada Lovelace' } } }),
}))

const SUMMARY = '/time-entries/summary'

const summary = (over: Record<string, unknown> = {}) => ({
  on: { type: 'project', id: 'p1' },
  totalMinutes: 6000,
  windowMinutes: 5070,
  byWorkType: [],
  byPerson: null,
  unavailable: [],
  ...over,
})
const serve = (handler: (url: URL) => FakeAnswer | Promise<FakeAnswer>) => {
  apiFetch.mockImplementation(fakeApi({ [`GET ${SUMMARY}`]: handler }))
}
const answers = (body: Record<string, unknown>) => serve(() => ({ status: 200, body }))
const reads = () => apiFetch.mock.calls.filter(([input]) => new URL(String(input)).pathname === SUMMARY).length

const deferred = () => {
  let release: (answer: FakeAnswer) => void = () => undefined
  const answer = new Promise<FakeAnswer>((resolve) => {
    release = resolve
  })
  return { answer, release }
}

/** The Europe/Zurich day projects-api stated the terms for. Every date below is worked out from it. */
const TODAY = '2026-11-27'

const period = (from: string, to: string, ended = false): CurrentPeriod => ({ from, to, ended })
const asOf = (terms: Terms, day: string | null = TODAY): Terms => (day === null ? terms : { ...terms, asOf: day })

/** A yearly 120 h package whose current period is 2026-03-01…2027-02-28 (365 days): 50 % of it has gone on 2026-09-01. */
const yearly = (day: string | null = '2026-09-01', hours = 120, endDate: string | null = null): Terms =>
  asOf(
    termsOf(
      'maintenance',
      {
        sla: null,
        hourPackage: {
          hours,
          kind: 'yearly',
          startDate: '2026-03-01',
          expiryDate: null,
          currentPeriod: period('2026-03-01', '2027-02-28'),
        },
      },
      { endDate },
    ),
    day,
  )

const capacity = (expiryDate: string | null, currentPeriod: CurrentPeriod | null, day: string | null = TODAY): Terms =>
  asOf(
    termsOf('maintenance', {
      sla: null,
      hourPackage: { hours: 120, kind: 'capacity', startDate: '2026-03-01', expiryDate, currentPeriod },
    }),
    day,
  )

/** A fixed price starting 2026-02-01 (the fixtures' default) with a 12.0 man-day max effort (96 h). */
const fixedPrice = (
  over: {
    deadline?: string
    estimatedManDays?: number | null
    maxEffortManDays?: number
    endDate?: string | null
  } = {},
  day: string | null = TODAY,
): Terms =>
  asOf(
    termsOf(
      'fixed_price',
      {
        deadline: over.deadline ?? '2026-12-01',
        estimatedManDays: over.estimatedManDays === undefined ? 10 : over.estimatedManDays,
        maxEffortManDays: over.maxEffortManDays ?? 12,
      },
      { endDate: over.endDate ?? null },
    ),
    day,
  )

/** Positions planned at 20.0 + 4.0 = 24.0 man-days (192 h). */
const timeAndMaterial = (day: string | null = TODAY): Terms =>
  asOf(
    termsOf('t_and_m', {
      positions: [
        { profile: 'Senior developer', plannedManDays: 20 },
        { profile: 'Designer', plannedManDays: 4 },
      ],
    }),
    day,
  )

const slaOnly = (endDate: string | null, day: string | null = TODAY): Terms =>
  asOf(termsOf('maintenance', { sla: { highDays: 1, normalDays: 3 }, hourPackage: null }, { endDate }), day)

const mount = (terms: Terms | null, state: ProjectState = 'active') =>
  render(<ConsumptionBlock projectId="p1" terms={terms} state={state} />)

const id = (name: string) => `project-hours-consumption-${name}`
const part = (name: string) => screen.queryByTestId(id(name))
const stateLine = () => part('state')
const percent = () => part('percent')
const pace = () => part('pace')
const bar = () => part('bar')

const text = (element: Element | null): string => (element?.textContent ?? '').replace(/\s+/g, ' ').trim()

/** What the eye reads of an element: the spoken twin of a duration (visually hidden) is left out. */
const visible = (element: Element): string => {
  const copy = element.cloneNode(true) as Element
  copy.querySelectorAll('.visually-hidden').forEach((node) => node.remove())
  return (copy.textContent ?? '').replace(/\s+/g, ' ').trim()
}
const facts = () => screen.getByTestId(id('facts'))
const fact = (term: string): string => visible(within(facts()).getByText(term).nextElementSibling!)
const factTerms = () =>
  within(facts())
    .queryAllByRole('term')
    .map((term) => term.textContent)

/** The shapes of an icon of the library: what proves which icon a line draws (the markup of the icon itself, not its class). */
const shapes = (name: IconName): string => {
  const { container, unmount } = render(<Icon name={name} />)
  const markup = container.querySelector('svg')!.innerHTML
  unmount()
  return markup
}
const iconOf = (element: Element | null): string => element?.querySelector('svg')?.innerHTML ?? ''
const classesOf = (element: Element | null) => (element?.getAttribute('class') ?? '').split(/\s+/)

/** An answer for the whole record has arrived: the facts are on screen. */
const loaded = () => screen.findByTestId(id('facts'))

const recorded = (detail: unknown) =>
  act(() => {
    window.dispatchEvent(new CustomEvent(TIME_ENTRY_RECORDED, { detail }))
  })

beforeEach(() => {
  apiFetch.mockReset()
})
afterEach(() => {
  cleanup()
})

describe('the state line: the state in words, an icon of its level and the consumed percentage (AC-5.1, AC-5.7–5.10, D95)', () => {
  it.each([
    ['nothing recorded', 0, 'On track', 'check', 'text-acc-text', '0%'],
    ['95 h 30 of 120 h (79.58 %)', 5730, 'On track', 'check', 'text-acc-text', '79%'],
    ['96 h of 120 h (exactly 80 %)', 5760, 'Close to the limit', 'alert', 'text-org-text', '80%'],
    ['119 h 30 of 120 h (99.58 %, 30 min left)', 7170, 'Close to the limit', 'alert', 'text-org-text', '99%'],
    ['exactly 120 h of 120 h', 7200, 'Limit reached', 'x-circle', 'text-red-text', '100%'],
    ['120 h 30 of 120 h (100.42 %, over by 30 min)', 7230, 'Over the limit', 'x-circle', 'text-red-text', '100%'],
    ['216 h of 120 h', 12960, 'Over the limit', 'x-circle', 'text-red-text', '180%'],
  ] as const)(
    'a package with %s says its state in words with its icon, and the percentage at the right',
    async (_label, minutes, words, icon, tone, shown) => {
      answers(summary({ windowMinutes: minutes }))
      mount(yearly())

      await loaded()

      expect(text(stateLine())).toBe(words)
      expect(iconOf(stateLine())).toBe(shapes(icon))
      expect(classesOf(stateLine())).toEqual(
        expect.arrayContaining([tone, 'flex', 'items-center', 'gap-2', 'text-sm', 'font-medium']),
      )
      expect(text(percent())).toBe(shown)
    },
  )

  it('draws the icon next to the words and hides it: the words say the same (AC-5.10)', async () => {
    answers(summary({ windowMinutes: 5760 }))
    mount(yearly())

    await loaded()

    const svg = stateLine()!.querySelector('svg')!
    expect(svg.getAttribute('aria-hidden')).toBe('true')
    expect(svg.hasAttribute('aria-label')).toBe(false)
    expect(stateLine()!.firstElementChild).toBe(svg)
  })

  it('gives the three states three distinct icons, and a colour class never carries a state alone (AC-5.10)', async () => {
    const seen: Record<string, string> = {}
    for (const [minutes, words] of [
      [0, 'On track'],
      [5760, 'Close to the limit'],
      [7200, 'Limit reached'],
    ] as const) {
      answers(summary({ windowMinutes: minutes }))
      const view = mount(yearly())
      await loaded()
      expect(text(stateLine())).toBe(words)
      seen[words] = iconOf(stateLine())
      view.unmount()
    }

    expect(new Set(Object.values(seen)).size).toBe(3)
  })

  it('"Limit reached" and "Over the limit" are one state: the same icon, the same tone, only the words differ (D95)', async () => {
    const lines: Element[] = []
    for (const minutes of [7200, 7230]) {
      answers(summary({ windowMinutes: minutes }))
      const view = mount(yearly())
      await loaded()
      lines.push(stateLine()!.cloneNode(true) as Element)
      view.unmount()
    }

    expect(text(lines[0]!)).toBe('Limit reached')
    expect(text(lines[1]!)).toBe('Over the limit')
    expect(iconOf(lines[0]!)).toBe(iconOf(lines[1]!))
    expect(lines[0]!.getAttribute('class')).toBe(lines[1]!.getAttribute('class'))
  })

  it('chooses the words from the excess, never from the percentage: 100 % reads "Over the limit" with an excess and "Limit reached" without', async () => {
    answers(summary({ windowMinutes: 7230 }))
    const view = mount(yearly())
    await loaded()
    expect(text(percent())).toBe('100%')
    expect(text(stateLine())).toBe('Over the limit')
    view.unmount()

    answers(summary({ windowMinutes: 7200 }))
    mount(yearly())
    await loaded()
    expect(text(percent())).toBe('100%')
    expect(text(stateLine())).toBe('Limit reached')
  })

  it('a fixed price at exactly its max effort says "Limit reached" with no excess, and one minute above it "Over the limit" beside "100%"', async () => {
    answers(summary({ totalMinutes: 5760, windowMinutes: null }))
    const view = mount(fixedPrice())
    await loaded()
    expect(text(stateLine())).toBe('Limit reached')
    expect(text(percent())).toBe('100%')
    view.unmount()

    answers(summary({ totalMinutes: 5761, windowMinutes: null }))
    mount(fixedPrice())
    await loaded()
    expect(text(stateLine())).toBe('Over the limit')
    expect(text(percent())).toBe('100%')
  })

  it('hides the percentage from assistive technology: the pace line states it, so no figure is read twice', async () => {
    answers(summary({ windowMinutes: 5070 }))
    mount(yearly())

    await loaded()

    expect(percent()!.getAttribute('aria-hidden')).toBe('true')
    expect(classesOf(percent())).toEqual(expect.arrayContaining(['font-mono', 'text-base', 'text-text', 'ml-auto']))
    expect(stateLine()!.contains(percent())).toBe(false)
    expect(stateLine()!.parentElement).toBe(percent()!.parentElement)
    expect(classesOf(stateLine()!.parentElement)).toEqual(
      expect.arrayContaining(['flex', 'items-center', 'justify-between', 'gap-3']),
    )
  })

  it('reads the state line before the bar and the pace line, and after the facts and their hint', async () => {
    answers(summary({ windowMinutes: 5070 }))
    mount(yearly())

    await loaded()

    const order = [
      facts(),
      screen.getByText('Hours left in a period do not carry over to the next one.'),
      stateLine()!,
      bar()!,
      pace()!,
    ]
    for (let index = 0; index < order.length - 1; index += 1) {
      expect(
        order[index]!.compareDocumentPosition(order[index + 1]!) & Node.DOCUMENT_POSITION_FOLLOWING,
        `${index}`,
      ).toBeTruthy()
    }
  })
})

describe('the pace line: the consumed percentage and, when there is one, the time elapsed (AC-5.1–5.3, AC-5.18, AC-5.19)', () => {
  it('a yearly package: "Used 82% of the hours with 50% of the period elapsed" (5 904 of 7 200 minutes, half of the 365 days gone)', async () => {
    answers(summary({ windowMinutes: 5904 }))
    mount(yearly('2026-09-01'))

    await loaded()

    expect(text(pace())).toBe('Used 82% of the hours with 50% of the period elapsed')
    expect(classesOf(pace())).toEqual(expect.arrayContaining(['text-xs', 'text-soft']))
    expect(pace()!.tagName).toBe('P')
  })

  it('reads the consumed percentage from the hours of the period, not from all the hours ever recorded (AC-5.1)', async () => {
    answers(summary({ totalMinutes: 99_999, windowMinutes: 5070 }))
    mount(yearly('2026-09-01'))

    await loaded()

    expect(text(pace())).toBe('Used 70% of the hours with 50% of the period elapsed')
    expect(text(percent())).toBe('70%')
  })

  it('a capacity package with an expiry has its time elapsed too, over its start date to its expiry', async () => {
    answers(summary({ windowMinutes: 3000 }))
    // 2026-03-01 … 2026-12-31 is 306 days; to 2026-11-27 is 271 gone: 88 %.
    mount(capacity('2026-12-31', period('2026-03-01', '2026-12-31')))

    await loaded()

    expect(text(pace())).toBe('Used 41% of the hours with 88% of the period elapsed')
  })

  it('a capacity package without an expiry states the percentage alone, "Used 70% of the hours": no end to measure to (AC-5.19)', async () => {
    answers(summary({ windowMinutes: 5040 }))
    mount(capacity(null, period('2026-03-01', TODAY)))

    await loaded()

    expect(text(pace())).toBe('Used 70% of the hours')
    expect(screen.queryByText('Today')).toBeNull()
  })

  it('a fixed price: "Used 75% of the max effort with 40% of the time to the deadline elapsed" (72 h of 96 h; the 1st to the 10th, the 5th)', async () => {
    answers(summary({ totalMinutes: 4320, windowMinutes: null }))
    // Starts 2026-02-01 (the fixtures' default): 10 days to 2026-02-10, 4 gone on the 5th.
    mount(fixedPrice({ deadline: '2026-02-10' }, '2026-02-05'))

    await loaded()

    expect(text(pace())).toBe('Used 75% of the max effort with 40% of the time to the deadline elapsed')
  })

  it('a fixed price whose deadline is before its start date states the percentage alone (AC-5.19)', async () => {
    answers(summary({ totalMinutes: 4320, windowMinutes: null }))
    mount(fixedPrice({ deadline: '2026-01-15' }))

    await loaded()

    expect(text(pace())).toBe('Used 75% of the max effort')
  })

  it('time and material: "Used 31% of the planned man-days" (60 h of 24.0 man-days), and never a time elapsed (AC-5.19)', async () => {
    answers(summary({ totalMinutes: 3600, windowMinutes: null }))
    mount(timeAndMaterial())

    await loaded()

    expect(text(pace())).toBe('Used 31% of the planned man-days')
  })

  it('reads in full beyond 125 %: "Used 180% …", not 125 and not capped (AC-5.16)', async () => {
    answers(summary({ windowMinutes: 12960 }))
    mount(yearly('2026-09-01'))

    await loaded()

    expect(text(pace())).toBe('Used 180% of the hours with 50% of the period elapsed')
    expect(text(percent())).toBe('180%')
  })

  it('writes a percentage through the formatter: "1,234%" in English, from the floored integer (AC-3.2)', async () => {
    // 1 234 % of 120 h is 1 480.8 h: 88 848 minutes → 1 234.0 %.
    answers(summary({ windowMinutes: 88_848 }))
    mount(yearly('2026-09-01'))

    await loaded()

    expect(text(pace())).toBe('Used 1,234% of the hours with 50% of the period elapsed')
  })

  it('states a time elapsed of 0 % and of 100 % like any other', async () => {
    answers(summary({ windowMinutes: 0 }))
    const view = mount(yearly('2026-03-01'))
    await loaded()
    expect(text(pace())).toBe('Used 0% of the hours with 0% of the period elapsed')
    view.unmount()

    answers(summary({ windowMinutes: 0 }))
    mount(yearly('2027-03-01'))
    await loaded()
    expect(text(pace())).toBe('Used 0% of the hours with 100% of the period elapsed')
  })

  it("a projects-api that does not say the day (no asOf) gives the percentage alone, never the browser's own day (R10)", async () => {
    answers(summary({ windowMinutes: 5070 }))
    mount(yearly(null))

    await loaded()

    expect(text(pace())).toBe('Used 70% of the hours')
    expect(screen.queryByText('Today')).toBeNull()
  })

  it('is the line the percentage is READ from: it states the same figure the state line shows, once', async () => {
    answers(summary({ windowMinutes: 5070 }))
    mount(yearly('2026-09-01'))

    await loaded()

    expect(text(pace())).toContain(text(percent()))
    expect(percent()!.getAttribute('aria-hidden')).toBe('true')
    expect(pace()!.hasAttribute('aria-hidden')).toBe(false)
  })
})

describe('the bar in the block: drawn from the share, hidden from assistive technology (AC-5.11, AC-5.14–5.17, AC-5.25, AC-5.26)', () => {
  const fillWidth = () => part('bar-fill')?.style.width ?? null
  const track = () => part('bar-track')

  it('is drawn under the state line, hidden from assistive technology, with the test ids e2e F reads', async () => {
    answers(summary({ windowMinutes: 5070 }))
    mount(yearly('2026-09-01'))

    await loaded()

    expect(bar()!.getAttribute('aria-hidden')).toBe('true')
    expect(track()).not.toBeNull()
    expect(bar()!.contains(track())).toBe(true)
    expect(screen.getByTestId('project-hours-consumption').contains(bar())).toBe(true)
    expect(stateLine()!.compareDocumentPosition(bar()!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('fills in proportion to the consumed percentage on a 0–125 % scale: 100 % fills four fifths (AC-5.14)', async () => {
    answers(summary({ windowMinutes: 7200 }))
    mount(yearly())

    await loaded()

    expect(fillWidth()).toBe('80%')
    expect(part('bar-beyond')).toBeNull()
  })

  it('draws the part beyond the 100 % mark as an element of its own, and none at exactly 100 % (AC-5.15)', async () => {
    answers(summary({ windowMinutes: 7201 }))
    mount(yearly())

    await loaded()

    expect(part('bar-beyond')).not.toBeNull()
    expect(part('bar-beyond')!.style.left).toBe('80%')
  })

  it('fills to the end of the track at 180 %, with the percentage reading in full (AC-5.16)', async () => {
    answers(summary({ windowMinutes: 12960 }))
    mount(yearly())

    await loaded()

    expect(fillWidth()).toBe('80%')
    expect(part('bar-beyond')!.style.width).toBe('20%')
    expect(text(percent())).toBe('180%')
  })

  it('carries no today mark for a package without an end, and one for a package with it, at 0.8 of the time elapsed (AC-5.18, AC-5.19)', async () => {
    answers(summary({ windowMinutes: 5040 }))
    const open = mount(capacity(null, period('2026-03-01', TODAY)))
    await loaded()
    expect(part('bar-today')).toBeNull()
    open.unmount()

    answers(summary({ windowMinutes: 5040 }))
    mount(yearly('2026-09-01'))
    await loaded()
    // 50 % of the period has gone: the mark is at 0.8 × 50 of the bar's length.
    expect(part('bar-today')!.style.left).toBe('40%')
    expect(within(bar()!).getByText('Today')).not.toBeNull()
  })

  it('a fixed price whose terms carry an estimate draws its diamond at its share of the max effort: 10.0 of 12.0 is 66.67 % of the bar (AC-5.17)', async () => {
    answers(summary({ totalMinutes: 3600, windowMinutes: null }))
    mount(fixedPrice({ estimatedManDays: 10 }))

    await loaded()

    expect(Number.parseFloat(part('bar-estimate')!.style.left)).toBeCloseTo(66.6667, 3)
    expect(within(bar()!).getByText('Estimate')).not.toBeNull()
    // The estimate is in the facts too, so the block reads complete without the bar (AC-5.11).
    expect(fact('Estimated man-days')).toBe('10.0 man-days')
  })

  it.each([
    ['no estimate', fixedPrice({ estimatedManDays: null })],
    ['an estimate beyond 125 % of the max effort (15.1 of 12.0)', fixedPrice({ estimatedManDays: 15.1 })],
    ['time and material', timeAndMaterial()],
    ['a package', yearly()],
  ])('draws no estimate diamond for %s', async (_name, terms) => {
    answers(summary({ totalMinutes: 3600, windowMinutes: 3600 }))
    mount(terms)

    await loaded()

    expect(part('bar-estimate')).toBeNull()
    expect(screen.queryByText('Estimate')).toBeNull()
  })

  it.each([
    ['on track', 0, 'bg-acc-solid'],
    ['close to the limit', 5760, 'bg-org'],
    ['over', 7200, 'bg-red'],
  ])('fills in the tone of the state said: %s is %s', async (_state, minutes, fill) => {
    answers(summary({ windowMinutes: minutes }))
    mount(yearly())

    await loaded()

    // A zero fills nothing, so the tone of an empty bar is seen on the state line instead.
    if (minutes === 0) expect(part('bar-fill')).toBeNull()
    else expect(classesOf(part('bar-fill'))).toContain(fill)
  })

  it('draws neutral, with neutral stripes, when no state is said: an expired capacity package, however far over (AC-5.25, D96)', async () => {
    answers(summary({ windowMinutes: 8430 }))
    mount(capacity('2026-09-30', period('2026-03-01', '2026-09-30', true), '2026-11-27'))

    await loaded()

    expect(stateLine()).toBeNull()
    expect(text(percent())).toBe('117%')
    expect(classesOf(part('bar-fill'))).toContain('bg-soft')
    expect(classesOf(part('bar-beyond'))).toContain('from-soft')
    expect(classesOf(part('bar-fill'))).not.toContain('bg-red')
    // The package expired on 2026-09-30, the day counted to is 2026-11-27: all of the period has gone (100 %).
    expect(text(pace())).toBe('Used 117% of the hours with 100% of the period elapsed')
    expect(part('bar-today')!.style.left).toBe('80%')
  })

  it.each<ProjectState>(['closed', 'cancelled'])(
    'a project that is %s says no state and draws its bar neutral, with its percentage and its time elapsed kept (AC-5.26)',
    async (state) => {
      answers(summary({ windowMinutes: 7230 }))
      mount(yearly('2026-09-01'), state)

      await loaded()

      expect(stateLine()).toBeNull()
      expect(text(percent())).toBe('100%')
      expect(classesOf(part('bar-fill'))).toContain('bg-soft')
      expect(text(pace())).toBe('Used 100% of the hours with 50% of the period elapsed')
      expect(part('bar-today')).not.toBeNull()
    },
  )

  it.each<ProjectState>(['planned', 'active', 'on_hold'])('a project that is %s says its state', async (state) => {
    answers(summary({ windowMinutes: 5760 }))
    mount(yearly(), state)

    await loaded()

    expect(text(stateLine())).toBe('Close to the limit')
  })

  it('on the expiry day itself the capacity package has not ended and says its state like any other (AC-5.25)', async () => {
    answers(summary({ windowMinutes: 8430 }))
    mount(capacity('2026-11-27', period('2026-03-01', '2026-11-27', false)))

    await loaded()

    expect(text(stateLine())).toBe('Over the limit')
    expect(screen.queryByTestId(id('expired'))).toBeNull()
  })

  it('is not an interactive control, a meter or a progress bar: the lines say what it shows', async () => {
    answers(summary({ windowMinutes: 5070 }))
    mount(yearly('2026-09-01'))

    await loaded()

    expect(screen.queryByRole('meter')).toBeNull()
    expect(screen.queryByRole('progressbar')).toBeNull()
    expect(bar()!.querySelector('[tabindex], button, a, [title]')).toBeNull()
  })
})

describe('no share, no signals: AC-5.4 (design S1.1 cases 9, 15, 16, 19)', () => {
  const none = () => {
    expect(stateLine()).toBeNull()
    expect(percent()).toBeNull()
    expect(bar()).toBeNull()
    expect(pace()).toBeNull()
  }

  it('a package that has not started shows its facts and no state, bar, percentage or pace line, and reads nothing', async () => {
    mount(capacity('2027-12-31', null))

    await screen.findByTestId(id('facts'))

    none()
    expect(reads()).toBe(0)
  })

  it('while the hours load: the skeleton, and none of the signals', async () => {
    const pending = deferred()
    serve(() => pending.answer)
    mount(yearly('2026-09-01'))

    expect(screen.getByText('Loading consumption…')).not.toBeNull()
    none()

    await act(async () => pending.release({ status: 200, body: summary() }))
    await loaded()
    expect(stateLine()).not.toBeNull()
  })

  it.each([
    ['hours-api is down', () => problem(503, 'host_unavailable')],
    ['the answer has no window total', () => ({ status: 200, body: summary({ windowMinutes: null }) })],
  ])(
    'when the hours cannot be loaded (%s): the warning, and no percentage, state, bar or pace line (AC-4.9)',
    async (_name, answer) => {
      serve(answer)
      mount(yearly('2026-09-01'))

      await screen.findByTestId(id('unavailable'))

      none()
    },
  )

  it('a reference that is not above zero (hand-built terms) shows its facts and no signal: no division by zero, no "NaN %"', async () => {
    answers(summary({ totalMinutes: 3600, windowMinutes: null }))
    mount(fixedPrice({ maxEffortManDays: 0 }))

    await loaded()

    none()
    expect(document.body.textContent).not.toMatch(/NaN|Infinity/)
  })

  it('terms with nothing to compare draw nothing, and no signal either', () => {
    const { container } = mount(slaOnly(null))

    expect(container.innerHTML).toBe('')
  })
})

describe('the excess: an "Over by" fact, in the unit the terms are sold in (AC-5.12, AC-5.13; D81)', () => {
  it('a fixed price over its max effort gains a last fact "Over by": 108 h of 96 h is 112 % and 1.5 man-days over', async () => {
    answers(summary({ totalMinutes: 6480, windowMinutes: null }))
    mount(fixedPrice({ estimatedManDays: 10 }))

    await loaded()

    expect(factTerms()).toEqual(['Man-days used', 'Estimated man-days', 'Max effort', 'Over by'])
    expect(fact('Man-days used')).toBe('13.5 man-days')
    expect(fact('Over by')).toBe('1.5 man-days')
    expect(text(percent())).toBe('112%')
    expect(text(stateLine())).toBe('Over the limit')
  })

  it('has it last whether or not the terms carry an estimate', async () => {
    answers(summary({ totalMinutes: 6480, windowMinutes: null }))
    mount(fixedPrice({ estimatedManDays: null }))

    await loaded()

    expect(factTerms()).toEqual(['Man-days used', 'Max effort', 'Over by'])
  })

  it('time and material over the total of its positions gains it too: 200 h of 24.0 man-days (192 h) is 1.0 man-day over', async () => {
    answers(summary({ totalMinutes: 12000, windowMinutes: null }))
    mount(timeAndMaterial())

    await loaded()

    expect(factTerms()).toEqual(['Man-days used', 'Planned man-days', 'Over by'])
    expect(fact('Over by')).toBe('1.0 man-days')
    expect(text(percent())).toBe('104%')
  })

  it.each([
    ['nothing recorded', 0],
    ['below the reference', 4320],
    ['close to the limit', 5000],
    ['exactly the reference (96 h)', 5760],
  ])('a fixed price with %s has no "Over by": it is shown only when over', async (_name, minutes) => {
    answers(summary({ totalMinutes: minutes, windowMinutes: null }))
    mount(fixedPrice())

    await loaded()

    expect(factTerms()).toEqual(['Man-days used', 'Estimated man-days', 'Max effort'])
    expect(screen.queryByText('Over by')).toBeNull()
  })

  it.each([
    [11520, 'time and material at exactly its reference'],
    [11000, 'time and material below it'],
  ])('time and material with %i minutes (%s) has no "Over by"', async (minutes) => {
    answers(summary({ totalMinutes: minutes, windowMinutes: null }))
    mount(timeAndMaterial())

    await loaded()

    expect(factTerms()).toEqual(['Man-days used', 'Planned man-days'])
  })

  it.each([
    ['9 h against a max effort of 1.1 man-days (528 min): 12 min over', 540, 1.1],
    ['23 min over', 528 + 23, 1.1],
  ])(
    'says "Less than 0.1 man-day", never "0.0", for an excess that would round to nothing: %s',
    async (_name, minutes, maxEffort) => {
      answers(summary({ totalMinutes: minutes, windowMinutes: null }))
      mount(fixedPrice({ maxEffortManDays: maxEffort, estimatedManDays: null }))

      await loaded()

      expect(fact('Over by')).toBe('Less than 0.1 man-day')
      expect(facts().textContent).not.toMatch(/0\.0/)
      expect(text(stateLine())).toBe('Over the limit')
    },
  )

  it('24 min over is a tenth, half up: "0.1 man-days"', async () => {
    answers(summary({ totalMinutes: 528 + 24, windowMinutes: null }))
    mount(fixedPrice({ maxEffortManDays: 1.1, estimatedManDays: null }))

    await loaded()

    expect(fact('Over by')).toBe('0.1 man-days')
  })

  it('a package keeps its excess as the "Over by" it already was, with no second fact (AC-5.12, D81)', async () => {
    answers(summary({ windowMinutes: 7470 }))
    mount(yearly())

    await loaded()

    expect(factTerms()).toEqual(['Yearly package', 'Current period', 'Hours used in this period', 'Over by'])
    expect(fact('Over by')).toBe('4 h 30')
    expect(screen.getAllByText('Over by')).toHaveLength(1)
  })

  it('at exactly 100 % a package still says "Hours left 0 min" and no excess, beside "Limit reached" (AC-5.9)', async () => {
    answers(summary({ windowMinutes: 7200 }))
    mount(yearly())

    await loaded()

    expect(fact('Hours left')).toBe('0 min')
    expect(screen.queryByText('Over by')).toBeNull()
    expect(text(stateLine())).toBe('Limit reached')
  })

  it('still reads where no state is said: an expired package keeps its "Over by" (AC-5.25)', async () => {
    answers(summary({ windowMinutes: 8430 }))
    mount(capacity('2026-09-30', period('2026-03-01', '2026-09-30', true)))

    await loaded()

    expect(fact('Over by')).toBe('20 h 30')
    expect(stateLine()).toBeNull()
  })

  it('says it in the facts, not in the state line: the state line holds the state and the percentage only', async () => {
    answers(summary({ totalMinutes: 6480, windowMinutes: null }))
    mount(fixedPrice())

    await loaded()

    expect(stateLine()!.parentElement!.textContent).not.toContain('1.5')
    expect(stateLine()!.parentElement!.textContent).not.toContain('man-day')
  })
})

describe('the date lines: a date that has passed or is near, said in words, with its date and an icon of its level (AC-5.10, AC-5.21–5.23)', () => {
  const deadline = () => part('date-deadline')
  const endDate = () => part('date-end-date')
  /** The two paragraphs of a line: the words (with the level icon), then the date (with the calendar icon). */
  const paragraphs = (line: Element | null) => Array.from(line?.querySelectorAll(':scope > p') ?? [])

  /** The fixed price of the owner's mock, on 2026-11-27: deadline 27 days ago (31.10.2026), an end date in 23 days (20.12.2026). */
  const mock = () => fixedPrice({ deadline: '2026-10-31', endDate: '2026-12-20' })

  it('says which date, how long ago or how soon, and shows the date: "Deadline passed 27 days ago" and "End date in 23 days"', async () => {
    answers(summary({ totalMinutes: 6480, windowMinutes: null }))
    mount(mock())

    await loaded()

    const [deadlineWords, deadlineDate] = paragraphs(deadline())
    expect(text(deadlineWords)).toBe('Deadline passed 27 days ago')
    expect(text(deadlineDate)).toBe('31.10.2026')
    expect(deadlineDate!.querySelector('time')!.getAttribute('datetime')).toBe('2026-10-31')
    const [endWords, endDateDate] = paragraphs(endDate())
    expect(text(endWords)).toBe('End date in 23 days')
    expect(text(endDateDate)).toBe('20.12.2026')
    expect(endDateDate!.querySelector('time')!.getAttribute('datetime')).toBe('2026-12-20')
  })

  it("draws the graver level for a date that has passed and the milder for one that is near, in the level's own tokens (AC-5.10)", async () => {
    answers(summary({ totalMinutes: 6480, windowMinutes: null }))
    mount(mock())

    await loaded()

    expect(classesOf(deadline())).toEqual(
      expect.arrayContaining([
        'border-red/40',
        'bg-red/10',
        'text-red-text',
        'border',
        'rounded-md',
        'px-3',
        'py-2',
        'text-sm',
      ]),
    )
    expect(classesOf(endDate())).toEqual(
      expect.arrayContaining([
        'border-org/40',
        'bg-org/10',
        'text-org-text',
        'border',
        'rounded-md',
        'px-3',
        'py-2',
        'text-sm',
      ]),
    )
    expect(classesOf(deadline())).not.toContain('border-org/40')
    expect(classesOf(endDate())).not.toContain('border-red/40')
  })

  it('leads the words with the level icon (the danger glyph for passed, the warning glyph for near), and the date with a calendar', async () => {
    answers(summary({ totalMinutes: 6480, windowMinutes: null }))
    mount(mock())

    await loaded()

    const [deadlineWords, deadlineDate] = paragraphs(deadline())
    expect(iconOf(deadlineWords!)).toBe(shapes('x-circle'))
    expect(iconOf(deadlineDate!)).toBe(shapes('calendar'))
    expect(deadlineWords!.firstElementChild!.tagName.toLowerCase()).toBe('svg')
    const [endWords, endDateDate] = paragraphs(endDate())
    expect(iconOf(endWords!)).toBe(shapes('alert'))
    expect(iconOf(endDateDate!)).toBe(shapes('calendar'))
    // The icons are decoration: the words say the same.
    for (const svg of Array.from(deadline()!.querySelectorAll('svg')))
      expect(svg.getAttribute('aria-hidden')).toBe('true')
  })

  it('draws the date in the mono figure style and the words in the medium weight', async () => {
    answers(summary({ totalMinutes: 6480, windowMinutes: null }))
    mount(mock())

    await loaded()

    const [words, date] = paragraphs(deadline())
    expect(classesOf(words)).toEqual(expect.arrayContaining(['flex', 'items-center', 'gap-2', 'font-medium']))
    expect(classesOf(date)).toEqual(
      expect.arrayContaining(['flex', 'items-center', 'gap-1.5', 'font-mono', 'text-xs', 'text-text']),
    )
  })

  it('puts the deadline first and the end date second, after the pace line: the reading order', async () => {
    answers(summary({ totalMinutes: 6480, windowMinutes: null }))
    mount(mock())

    await loaded()

    const order = [pace()!, deadline()!, endDate()!]
    for (let index = 0; index < order.length - 1; index += 1) {
      expect(order[index]!.compareDocumentPosition(order[index + 1]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    }
  })

  it.each([
    ['a deadline today', fixedPrice({ deadline: TODAY }), 'date-deadline', 'Deadline is today', 'alert'],
    [
      'an end date today',
      fixedPrice({ endDate: TODAY, deadline: '2027-06-01' }),
      'date-end-date',
      'End date is today',
      'alert',
    ],
    [
      'a deadline yesterday',
      fixedPrice({ deadline: '2026-11-26' }),
      'date-deadline',
      'Deadline passed 1 day ago',
      'x-circle',
    ],
    [
      'an end date yesterday',
      fixedPrice({ endDate: '2026-11-26', deadline: '2027-06-01' }),
      'date-end-date',
      'End date passed 1 day ago',
      'x-circle',
    ],
    ['a deadline tomorrow', fixedPrice({ deadline: '2026-11-28' }), 'date-deadline', 'Deadline in 1 day', 'alert'],
    [
      'a deadline 30 days ahead',
      fixedPrice({ deadline: '2026-12-27' }),
      'date-deadline',
      'Deadline in 30 days',
      'alert',
    ],
    [
      'an end date 30 days ahead',
      fixedPrice({ endDate: '2026-12-27', deadline: '2027-06-01' }),
      'date-end-date',
      'End date in 30 days',
      'alert',
    ],
  ])('%s says its words, with the icon of its level', async (_name, terms, testId, words, icon) => {
    answers(summary({ totalMinutes: 0, windowMinutes: null }))
    mount(terms)

    await loaded()

    expect(text(paragraphs(part(testId))[0])).toBe(words)
    expect(iconOf(paragraphs(part(testId))[0]!)).toBe(shapes(icon as IconName))
  })

  it('says nothing for a date 31 days ahead or more, and nothing for a terms without an end date (AC-5.22, AC-5.23)', async () => {
    answers(summary({ totalMinutes: 0, windowMinutes: null }))
    mount(fixedPrice({ deadline: '2026-12-28', endDate: '2027-01-15' }))

    await loaded()

    expect(deadline()).toBeNull()
    expect(endDate()).toBeNull()
  })

  it('a date that is today has not passed (D94), and passes from the next day', async () => {
    answers(summary({ totalMinutes: 0, windowMinutes: null }))
    const first = mount(fixedPrice({ deadline: '2026-11-27' }, '2026-11-27'))
    await loaded()
    expect(text(paragraphs(deadline())[0])).toBe('Deadline is today')
    first.unmount()

    answers(summary({ totalMinutes: 0, windowMinutes: null }))
    mount(fixedPrice({ deadline: '2026-11-27' }, '2026-11-28'))
    await loaded()
    expect(text(paragraphs(deadline())[0])).toBe('Deadline passed 1 day ago')
  })

  it('a fixed price whose deadline and end date fall on the same day has two lines, the deadline first, each its own (AC-5.23)', async () => {
    answers(summary({ totalMinutes: 0, windowMinutes: null }))
    mount(fixedPrice({ deadline: '2026-12-05', endDate: '2026-12-05' }))

    await loaded()

    expect(text(paragraphs(deadline())[0])).toBe('Deadline in 8 days')
    expect(text(paragraphs(endDate())[0])).toBe('End date in 8 days')
    expect(deadline()!.compareDocumentPosition(endDate()!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('judges each on its own: a deadline that has passed beside an end date far ahead has one line', async () => {
    answers(summary({ totalMinutes: 0, windowMinutes: null }))
    mount(fixedPrice({ deadline: '2026-10-01', endDate: '2027-03-01' }))

    await loaded()

    expect(deadline()).not.toBeNull()
    expect(endDate()).toBeNull()
  })

  it('every client type with an end date has its end-date line, and only a fixed price has a deadline line', async () => {
    answers(summary({ windowMinutes: 5070 }))
    const withEnd = (terms: Terms, endDateValue: string): Terms => ({ ...terms, endDate: endDateValue })
    const package_ = withEnd(yearly(TODAY), '2026-12-10')
    mount(package_)
    await loaded()
    expect(text(paragraphs(endDate())[0])).toBe('End date in 13 days')
    expect(deadline()).toBeNull()
    cleanup()

    answers(summary({ totalMinutes: 3600, windowMinutes: null }))
    mount(withEnd(timeAndMaterial(), '2026-11-20'))
    await loaded()
    expect(text(paragraphs(endDate())[0])).toBe('End date passed 7 days ago')
    expect(deadline()).toBeNull()
  })

  it('has no role and no live region: a date signal is not an alert', async () => {
    answers(summary({ totalMinutes: 6480, windowMinutes: null }))
    mount(mock())

    await loaded()

    for (const line of [deadline()!, endDate()!]) {
      expect(line.hasAttribute('role')).toBe(false)
      expect(line.hasAttribute('aria-live')).toBe(false)
      expect(line.querySelector('[role], [aria-live], [tabindex]')).toBeNull()
    }
  })

  it("reads the day projects-api stated (asOf), never the browser's own: the same terms a month later say another count", async () => {
    answers(summary({ totalMinutes: 0, windowMinutes: null }))
    mount(fixedPrice({ deadline: '2026-12-05' }, '2026-12-01'))

    await loaded()

    expect(text(paragraphs(deadline())[0])).toBe('Deadline in 4 days')
  })

  it('shows no date line when the terms carry no day (a projects-api that predates asOf, R10)', async () => {
    answers(summary({ totalMinutes: 6480, windowMinutes: null }))
    mount(fixedPrice({ deadline: '2026-10-31', endDate: '2026-12-20' }, null))

    await loaded()

    expect(deadline()).toBeNull()
    expect(endDate()).toBeNull()
    // The percentage and the state still show: only what reads today is withheld.
    expect(text(percent())).toBe('112%')
  })

  it.each<ProjectState>(['closed', 'cancelled'])(
    'a project that is %s shows no date line, and keeps its figures (AC-5.26)',
    async (state) => {
      answers(summary({ totalMinutes: 6480, windowMinutes: null }))
      mount(mock(), state)

      await loaded()

      expect(deadline()).toBeNull()
      expect(endDate()).toBeNull()
      expect(text(percent())).toBe('112%')
    },
  )

  it.each<ProjectState>(['planned', 'active', 'on_hold'])(
    'a project that is %s shows its date lines',
    async (state) => {
      answers(summary({ totalMinutes: 6480, windowMinutes: null }))
      mount(mock(), state)

      await loaded()

      expect(deadline()).not.toBeNull()
      expect(endDate()).not.toBeNull()
    },
  )

  describe('they read the terms alone, so they show wherever the hours do not (AC-5.24, AC-4.9)', () => {
    it('beside the "Consumption is unavailable" warning, below it', async () => {
      serve(() => problem(503, 'host_unavailable'))
      mount(mock())

      const banner = await screen.findByTestId(id('unavailable'))

      expect(deadline()).not.toBeNull()
      expect(endDate()).not.toBeNull()
      expect(banner.compareDocumentPosition(deadline()!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      // No hours figure: not the percentage, not a state, not the bar, not the pace line.
      expect(percent()).toBeNull()
      expect(stateLine()).toBeNull()
      expect(bar()).toBeNull()
      expect(pace()).toBeNull()
      expect(screen.getByRole('group', { name: 'Consumption' }).contains(deadline())).toBe(true)
    })

    it('while the hours load, at once, below the skeleton', async () => {
      const pending = deferred()
      serve(() => pending.answer)
      mount(mock())

      const skeleton = screen.getByTestId('projects-loading')

      expect(deadline()).not.toBeNull()
      expect(endDate()).not.toBeNull()
      expect(skeleton.compareDocumentPosition(deadline()!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      expect(text(paragraphs(deadline())[0])).toBe('Deadline passed 27 days ago')
      await act(async () => pending.release({ status: 200, body: summary({ totalMinutes: 0, windowMinutes: null }) }))
      await loaded()
      expect(deadline()).not.toBeNull()
    })

    it('for a package that has not started, below its facts, with nothing read', async () => {
      const notStarted = asOf(
        termsOf(
          'maintenance',
          {
            sla: null,
            hourPackage: {
              hours: 120,
              kind: 'capacity',
              startDate: '2027-03-01',
              expiryDate: null,
              currentPeriod: null,
            },
          },
          { endDate: '2026-12-01' },
        ),
      )
      mount(notStarted)

      await screen.findByTestId(id('facts'))

      expect(text(paragraphs(endDate())[0])).toBe('End date in 4 days')
      expect(facts().compareDocumentPosition(endDate()!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      expect(stateLine()).toBeNull()
      expect(reads()).toBe(0)
    })

    it('for terms of an SLA and no hour package: a block of the date line alone, no facts, no share and no read (AC-1.7 amended)', async () => {
      mount(slaOnly('2026-11-30'))

      const line = await screen.findByTestId(id('date-end-date'))

      expect(text(paragraphs(line)[0])).toBe('End date in 3 days')
      expect(screen.queryByTestId(id('facts'))).toBeNull()
      expect(stateLine()).toBeNull()
      expect(bar()).toBeNull()
      expect(pace()).toBeNull()
      expect(screen.getByRole('group', { name: 'Consumption' }).contains(line)).toBe(true)
      expect(reads()).toBe(0)
      // Nothing precedes it, so no gap above it either (the region is the dates' parent's parent).
      expect(classesOf(line.parentElement!.parentElement)).not.toContain('mt-4')
    })

    it('an SLA-only project whose end date passed says so: "End date passed 12 days ago", beside the date', async () => {
      mount(slaOnly('2026-11-15'))

      const line = await screen.findByTestId(id('date-end-date'))

      expect(text(paragraphs(line)[0])).toBe('End date passed 12 days ago')
      expect(text(paragraphs(line)[1])).toBe('15.11.2026')
    })

    it.each([
      ['no end date', null],
      ['an end date 31 days ahead', '2026-12-28'],
    ])('SLA-only terms with %s have no block at all', (_name, endDateValue) => {
      const { container } = mount(slaOnly(endDateValue))

      expect(container.innerHTML).toBe('')
    })

    it('an SLA-only project that is closed has no block even with a passed end date (AC-5.26)', () => {
      const { container } = mount(slaOnly('2026-11-15'), 'closed')

      expect(container.innerHTML).toBe('')
    })
  })

  it('leaves a gap above them when the share precedes them, and none when they stand alone', async () => {
    answers(summary({ totalMinutes: 6480, windowMinutes: null }))
    const withShare = mount(mock())
    await loaded()
    expect(classesOf(deadline()!.parentElement)).toContain('mt-3')
    // The region itself sits under the facts and their hint.
    expect(classesOf(deadline()!.parentElement!.parentElement)).toContain('mt-4')
    withShare.unmount()

    mount(slaOnly('2026-11-30'))
    await screen.findByTestId(id('date-end-date'))
    expect(classesOf(endDate()!.parentElement)).not.toContain('mt-3')
  })

  it('wraps: the box is a wrapping flex row, so at 320 px the date drops under the words', async () => {
    answers(summary({ totalMinutes: 6480, windowMinutes: null }))
    mount(mock())

    await loaded()

    expect(classesOf(deadline())).toEqual(
      expect.arrayContaining(['flex', 'flex-wrap', 'items-center', 'justify-between', 'gap-x-3', 'gap-y-1', 'w-full']),
    )
  })
})

describe('after a save made with Record hours: the percentage, the bar, the state and the excess move; the time elapsed and the dates do not (AC-5.28, A52)', () => {
  const projectEvent = { on: 'project', targetId: 'p1' }

  it("moves the percentage, the state, the bar, the excess and the pace line's share, and not the time elapsed, the today mark or the date lines", async () => {
    let totalMinutes = 4320
    serve(() => ({ status: 200, body: summary({ totalMinutes, windowMinutes: null }) }))
    // Starts 2026-02-01; the deadline 2026-02-10 and the day 2026-02-05: 40 % of the time gone; end date 2026-02-12 is in 7 days.
    mount(fixedPrice({ deadline: '2026-02-10', endDate: '2026-02-12' }, '2026-02-05'))
    await loaded()
    expect(text(percent())).toBe('75%')
    expect(text(stateLine())).toBe('On track')
    expect(text(pace())).toBe('Used 75% of the max effort with 40% of the time to the deadline elapsed')
    const marked = part('bar-today')!.style.left
    const lines = [text(part('date-deadline')), text(part('date-end-date'))]
    expect(part('bar-fill')!.style.width).toBe('60%')
    expect(part('bar-beyond')).toBeNull()
    expect(factTerms()).toEqual(['Man-days used', 'Estimated man-days', 'Max effort'])

    totalMinutes = 6480
    recorded(projectEvent)

    await waitFor(() => expect(text(percent())).toBe('112%'))
    expect(text(stateLine())).toBe('Over the limit')
    expect(text(pace())).toBe('Used 112% of the max effort with 40% of the time to the deadline elapsed')
    expect(part('bar-fill')!.style.width).toBe('80%')
    expect(part('bar-beyond')).not.toBeNull()
    expect(fact('Over by')).toBe('1.5 man-days')
    // What reads today did not move: the same day, the same mark, the same lines.
    expect(part('bar-today')!.style.left).toBe(marked)
    expect([text(part('date-deadline')), text(part('date-end-date'))]).toEqual(lines)
    expect(reads()).toBe(2)
  })

  it('keeps the share and the date lines on screen, with no skeleton, until the answer arrives', async () => {
    serve(() => ({ status: 200, body: summary({ totalMinutes: 4320, windowMinutes: null }) }))
    mount(fixedPrice({ deadline: '2026-02-10', endDate: '2026-02-12' }, '2026-02-05'))
    await loaded()
    const again = deferred()
    serve(() => again.answer)

    recorded(projectEvent)

    await waitFor(() => expect(reads()).toBe(2))
    expect(text(percent())).toBe('75%')
    expect(part('date-deadline')).not.toBeNull()
    expect(bar()).not.toBeNull()
    expect(screen.queryByText('Loading consumption…')).toBeNull()

    await act(async () => again.release({ status: 200, body: summary({ totalMinutes: 4800, windowMinutes: null }) }))
    await waitFor(() => expect(text(percent())).toBe('83%'))
  })

  it('a package: the percentage and the state turn over with the hours, and the period elapsed stays', async () => {
    let windowMinutes = 5000
    serve(() => ({ status: 200, body: summary({ windowMinutes }) }))
    mount(yearly('2026-09-01'))
    await loaded()
    expect(text(stateLine())).toBe('On track')
    expect(text(pace())).toBe('Used 69% of the hours with 50% of the period elapsed')

    windowMinutes = 7200
    recorded(projectEvent)

    await waitFor(() => expect(text(stateLine())).toBe('Limit reached'))
    expect(text(pace())).toBe('Used 100% of the hours with 50% of the period elapsed')
    expect(fact('Hours left')).toBe('0 min')
  })

  it('a failed re-read shows the usual warning with no signal and no percentage, the date lines staying below it', async () => {
    serve(() => ({ status: 200, body: summary({ totalMinutes: 4320, windowMinutes: null }) }))
    mount(fixedPrice({ deadline: '2026-02-10' }, '2026-02-12'))
    await loaded()
    expect(part('date-deadline')).not.toBeNull()
    serve(() => problem(503, 'host_unavailable'))

    recorded(projectEvent)

    await screen.findByTestId(id('unavailable'))
    expect(percent()).toBeNull()
    expect(stateLine()).toBeNull()
    expect(bar()).toBeNull()
    expect(pace()).toBeNull()
    expect(part('date-deadline')).not.toBeNull()
  })
})
