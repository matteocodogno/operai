/**
 * @vitest-environment jsdom
 *
 * ConsumptionBlock (specs/20261112-project-hours AC-1.1 – AC-1.6, AC-1.8, AC-1.9, AC-2.6, AC-2.8, AC-4.9, A51; design S1, § Gap
 * resolutions D81, D83, D84): what the terms sold, set against the hours hours-api says were recorded. The seam is the
 * rendered block, the one summary it asks for (and the window it asks with) and the events it listens to. It draws
 * `consumptionOf`'s answer as facts, says "unavailable" with no figure at all when the read fails, and re-reads —
 * keeping what is on screen until the answer — when Record hours announces a save on its project.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { fakeApi, problem, termsOf } from '../test-support/fakeApi'
import type { FakeAnswer } from '../test-support/fakeApi'
import { TIME_ENTRY_RECORDED } from '../lib/timeEntryRecordedEvent'
import type { CurrentPeriod, Terms } from '../lib/types'
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

/** hours-api's answer (plan § API contracts); only the two totals are read. */
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

/** A read that answers only when the test says so. */
const deferred = () => {
  let release: (answer: FakeAnswer) => void = () => undefined
  const answer = new Promise<FakeAnswer>((resolve) => {
    release = resolve
  })
  return { answer, release }
}

const reads = () =>
  apiFetch.mock.calls
    .filter(([input]) => new URL(String(input)).pathname === SUMMARY)
    .map(([input, init]) => ({
      params: Object.fromEntries(new URL(String(input)).searchParams),
      signal: (init as RequestInit | undefined)?.signal,
    }))

const period = (from: string, to: string, ended = false): CurrentPeriod => ({ from, to, ended })

// The terms of each shape, as projects-api reads them back.
const yearly = (hours = 120, currentPeriod: CurrentPeriod | null = period('2026-03-01', '2027-02-28')): Terms =>
  termsOf('maintenance', {
    sla: null,
    hourPackage: { hours, kind: 'yearly', startDate: '2026-03-01', expiryDate: null, currentPeriod },
  })

const capacity = (expiryDate: string | null, currentPeriod: CurrentPeriod | null, hours = 120): Terms =>
  termsOf('maintenance', {
    sla: null,
    hourPackage: { hours, kind: 'capacity', startDate: '2026-03-01', expiryDate, currentPeriod },
  })

const fixedPrice = (estimatedManDays: number | null): Terms =>
  termsOf('fixed_price', { deadline: '2026-12-01', estimatedManDays, maxEffortManDays: 12 })

const timeAndMaterial = (): Terms =>
  termsOf('t_and_m', {
    positions: [
      { profile: 'Senior developer', plannedManDays: 20 },
      { profile: 'Designer', plannedManDays: 4 },
    ],
  })

const slaOnly = (): Terms => termsOf('maintenance', { sla: { highDays: 1, normalDays: 3 }, hourPackage: null })

const mount = (terms: Terms | null, projectId = 'p1') =>
  render(<ConsumptionBlock projectId={projectId} terms={terms} />)

/** What the eye reads of an element: the spoken twin of a duration (visually hidden) is left out. */
const visible = (element: Element): string => {
  const copy = element.cloneNode(true) as Element
  copy.querySelectorAll('.visually-hidden').forEach((node) => node.remove())
  return (copy.textContent ?? '').replace(/\s+/g, ' ').trim()
}

const facts = () => screen.getByTestId('project-hours-consumption-facts')
const terms_ = () =>
  within(facts())
    .queryAllByRole('term')
    .map((term) => term.textContent)
/** The value shown under a term of the facts. */
const fact = (term: string): string => {
  const dt = within(facts()).getByText(term)
  return visible(dt.nextElementSibling!)
}
const group = () => screen.getByRole('group', { name: 'Consumption' })

/** An answer for the whole record has arrived: the facts are on screen. */
const loaded = () => screen.findByTestId('project-hours-consumption-facts')

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

describe('a package with a current period (AC-1.1, AC-1.2)', () => {
  it('asks hours-api once, with the period as the window, and shows the package, the period, the hours used and left', async () => {
    answers(summary({ windowMinutes: 5070 }))
    mount(yearly(120))

    await loaded()

    expect(reads().map((read) => read.params)).toEqual([
      { projectId: 'p1', windowFrom: '2026-03-01', windowTo: '2027-02-28' },
    ])
    expect(terms_()).toEqual(['Yearly package', 'Current period', 'Hours used in this period', 'Hours left'])
    expect(fact('Yearly package')).toBe('120 h')
    expect(fact('Current period')).toBe('01.03.2026 – 28.02.2027')
    expect(fact('Hours used in this period')).toBe('84 h 30')
    expect(fact('Hours left')).toBe('35 h 30')
    // The rule a reader cannot otherwise see (AC-1.2, D28).
    expect(screen.getByText('Hours left in a period do not carry over to the next one.')).not.toBeNull()
  })

  it('compares the hours of the period, not all the hours ever recorded on the project', async () => {
    answers(summary({ totalMinutes: 99_999, windowMinutes: 60 }))
    mount(yearly(120))

    await loaded()

    expect(fact('Hours used in this period')).toBe('1 h')
  })

  it('names the block for assistive technology as a group "Consumption", with no heading of its own (the card is the heading)', async () => {
    answers(summary())
    mount(yearly())

    await loaded()

    expect(group()).toBe(screen.getByTestId('project-hours-consumption'))
    expect(screen.queryAllByRole('heading')).toEqual([])
  })

  it('gives every duration a spoken twin, so no figure rests on "h" read as a letter', async () => {
    answers(summary({ windowMinutes: 5070 }))
    mount(yearly(120))

    await loaded()

    const dd = within(facts()).getByText('Hours used in this period').nextElementSibling!
    expect(dd.querySelector('.visually-hidden')?.textContent).toBe('84 hours, 30 minutes')
    expect(dd.querySelector('[aria-hidden="true"]')?.textContent).toBe('84 h 30')
  })

  it('shows a zero as a figure, the whole package left (no empty state)', async () => {
    answers(summary({ totalMinutes: 0, windowMinutes: 0 }))
    mount(yearly(120))

    await loaded()

    expect(fact('Hours used in this period')).toBe('0 min')
    expect(fact('Hours left')).toBe('120 h')
  })

  it('at exactly the package it is used up: nothing left, and not over', async () => {
    answers(summary({ windowMinutes: 7200 }))
    mount(yearly(120))

    await loaded()

    expect(fact('Hours left')).toBe('0 min')
    expect(screen.queryByText('Over by')).toBeNull()
  })

  it('once the package is exceeded, "Hours left" becomes "Over by" with the absolute figure, never a negative (D81)', async () => {
    answers(summary({ windowMinutes: 7470 }))
    mount(yearly(120))

    await loaded()

    expect(terms_()).toEqual(['Yearly package', 'Current period', 'Hours used in this period', 'Over by'])
    expect(fact('Hours used in this period')).toBe('124 h 30')
    expect(fact('Over by')).toBe('4 h 30')
    expect(screen.queryByText('Hours left')).toBeNull()
    expect(facts().textContent).not.toMatch(/[-−–]\s?4/)
  })

  it('carries no colour and no badge for an exceeded package (the sign of the figure is the signal, D80)', async () => {
    answers(summary({ windowMinutes: 9000 }))
    mount(yearly(120))

    await loaded()

    expect(screen.queryByTestId('project-hours-consumption-expired')).toBeNull()
    expect(group().querySelector('.badge')).toBeNull()
  })
})

describe('a capacity package (AC-1.3, AC-1.9)', () => {
  it('shows its start and expiry as the package period, and the hours used in it', async () => {
    answers(summary({ windowMinutes: 600 }))
    mount(capacity('2026-09-30', period('2026-03-01', '2026-09-30')))

    await loaded()

    expect(reads().map((read) => read.params)).toEqual([
      { projectId: 'p1', windowFrom: '2026-03-01', windowTo: '2026-09-30' },
    ])
    expect(terms_()).toEqual(['Capacity package', 'Package period', 'Hours used', 'Hours left'])
    expect(fact('Package period')).toBe('01.03.2026 – 30.09.2026')
    expect(fact('Hours used')).toBe('10 h')
    expect(fact('Hours left')).toBe('110 h')
    // No carry-over note: a capacity package has one period.
    expect(screen.queryByText(/carry over/)).toBeNull()
  })

  it('without an expiry says "From <start>, no expiry" and never shows the end the server sends (today)', async () => {
    answers(summary({ windowMinutes: 600 }))
    mount(capacity(null, period('2026-03-01', '2026-11-27')))

    await loaded()

    expect(fact('Package period')).toBe('From 01.03.2026, no expiry')
    expect(facts().textContent).not.toContain('27.11.2026')
    // The server's own `to` is still the window the hours are counted in.
    expect(reads()[0]!.params).toMatchObject({ windowFrom: '2026-03-01', windowTo: '2026-11-27' })
  })

  it('past its expiry it shows the package as it stood, with an "Expired" badge beside the dates (D83)', async () => {
    answers(summary({ windowMinutes: 3000 }))
    mount(capacity('2026-09-30', period('2026-03-01', '2026-09-30', true)))

    await loaded()

    const badge = screen.getByTestId('project-hours-consumption-expired')
    expect(badge.textContent).toContain('Expired')
    // Right after the period's dates, in the same fact.
    expect(within(facts()).getByText('Package period').nextElementSibling!.contains(badge)).toBe(true)
    expect(fact('Package period')).toBe('01.03.2026 – 30.09.2026 Expired')
    expect(fact('Hours used')).toBe('50 h')
    expect(fact('Hours left')).toBe('70 h')
  })

  it('does not say "Expired" before the expiry, nor for a yearly package', async () => {
    answers(summary({ windowMinutes: 600 }))
    const { unmount } = mount(capacity('2026-12-31', period('2026-03-01', '2026-12-31', false)))
    await loaded()
    expect(screen.queryByTestId('project-hours-consumption-expired')).toBeNull()
    unmount()

    mount(yearly(120))
    await loaded()
    expect(screen.queryByTestId('project-hours-consumption-expired')).toBeNull()
  })
})

describe('a package that has not started (A51)', () => {
  it('shows the package and its start with a note, and asks hours-api for nothing', async () => {
    answers(summary())
    mount(capacity('2027-12-31', null))

    const block = await screen.findByTestId('project-hours-consumption')
    // Nothing to wait for: it is drawn from the terms alone.
    expect(within(block).getByText('Capacity package')).not.toBeNull()
    expect(fact('Capacity package')).toBe('120 h')
    expect(fact('Starts on')).toBe('01.03.2026')
    expect(screen.getByText('Hours recorded before the start date do not count against the package.')).not.toBeNull()
    expect(screen.queryByText('Hours used')).toBeNull()
    expect(screen.queryByText('Hours left')).toBeNull()
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(reads()).toEqual([])
  })

  it('has no loading and no failure state: it never reads', () => {
    mount(yearly(120, null))

    expect(screen.queryByTestId('projects-loading')).toBeNull()
    expect(screen.queryByTestId('project-hours-consumption-unavailable')).toBeNull()
    expect(reads()).toEqual([])
  })
})

describe('a fixed price (AC-1.4, AC-1.6)', () => {
  it('compares all the hours recorded, in man-days with one decimal, with the estimate and the max effort', async () => {
    answers(summary({ totalMinutes: 3600, windowMinutes: null }))
    mount(fixedPrice(10))

    await loaded()

    // All time: no window is asked for.
    expect(reads().map((read) => read.params)).toEqual([{ projectId: 'p1' }])
    expect(terms_()).toEqual(['Man-days used', 'Estimated man-days', 'Max effort'])
    expect(fact('Man-days used')).toBe('7.5 man-days')
    expect(fact('Estimated man-days')).toBe('10.0 man-days')
    expect(fact('Max effort')).toBe('12.0 man-days')
    expect(screen.getByText('Counts all the hours recorded on the project. One man-day is 8 hours.')).not.toBeNull()
  })

  it('leaves the estimate out when the terms carry none (not "None")', async () => {
    answers(summary({ totalMinutes: 480, windowMinutes: null }))
    mount(fixedPrice(null))

    await loaded()

    expect(terms_()).toEqual(['Man-days used', 'Max effort'])
    expect(fact('Man-days used')).toBe('1.0 man-days')
    expect(facts().textContent).not.toContain('None')
  })

  it.each([
    [30, '0.1'],
    [24, '0.1'],
    [23, '0.0'],
    [0, '0.0'],
  ])('rounds %i minutes to %s man-days, half up, once', async (minutes, shown) => {
    answers(summary({ totalMinutes: minutes, windowMinutes: null }))
    mount(fixedPrice(null))

    await loaded()

    expect(fact('Man-days used')).toBe(`${shown} man-days`)
  })
})

describe('time and material (AC-1.5)', () => {
  it('compares with the total of all positions, and shows no position and no per-position figure', async () => {
    answers(summary({ totalMinutes: 3600, windowMinutes: null }))
    mount(timeAndMaterial())

    await loaded()

    expect(reads().map((read) => read.params)).toEqual([{ projectId: 'p1' }])
    expect(terms_()).toEqual(['Man-days used', 'Planned man-days'])
    expect(fact('Man-days used')).toBe('7.5 man-days')
    expect(fact('Planned man-days')).toBe('24.0 man-days')
    expect(screen.getByText('Compared with the total of all positions. One man-day is 8 hours.')).not.toBeNull()
    expect(screen.queryByText('Senior developer')).toBeNull()
    expect(screen.queryByText('Designer')).toBeNull()
    expect(screen.queryByRole('table')).toBeNull()
  })
})

describe('terms with nothing to compare (AC-1.7, D82)', () => {
  it.each([
    ['no terms', null],
    ['an SLA and no hour package', slaOnly()],
    [
      'terms from a projects-api that predates the current period',
      termsOf('maintenance', {
        sla: null,
        hourPackage: { hours: 120, kind: 'yearly', startDate: '2026-03-01', expiryDate: null },
      }),
    ],
  ])('%s: no block at all and no request', async (_name, terms) => {
    const { container } = mount(terms)

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(container.innerHTML).toBe('')
    expect(reads()).toEqual([])
  })
})

describe('loading and unavailable (AC-2.6, AC-4.9)', () => {
  it('says it is loading, with no figure, until the answer arrives', async () => {
    const pending = deferred()
    serve(() => pending.answer)
    mount(yearly())

    expect(screen.getByText('Loading consumption…')).not.toBeNull()
    expect(screen.queryByTestId('project-hours-consumption-facts')).toBeNull()

    await act(async () => pending.release({ status: 200, body: summary() }))
    await loaded()
    expect(screen.queryByText('Loading consumption…')).toBeNull()
  })

  it.each([
    ['hours-api is down (503)', () => problem(503, 'host_unavailable')],
    ['the project is not readable (404)', () => problem(404, 'not_found')],
    ['the network fails', () => Promise.reject(new TypeError('Failed to fetch')) as unknown as FakeAnswer],
    ['the answer has no usable totals', () => ({ status: 200, body: { on: { type: 'project', id: 'p1' } } })],
    [
      'the answer has no window total for a window asked for',
      () => ({ status: 200, body: summary({ windowMinutes: null }) }),
    ],
  ])('%s: a warning with Retry and no hours figure at all, nothing lower than the truth', async (_name, answer) => {
    serve(answer)
    mount(yearly())

    const banner = await screen.findByTestId('project-hours-consumption-unavailable')

    expect(banner.getAttribute('role')).toBe('alert')
    expect(banner.textContent).toContain('Consumption is unavailable')
    expect(banner.textContent).toContain(
      'Operai could not load the hours recorded on this project, so no comparison is shown rather than one that could be too low. Try again in a moment.',
    )
    expect(within(banner).getByRole('button', { name: 'Retry' })).not.toBeNull()
    // No figure: not the used hours, not the left ones, and the sold figures are not repeated (the Terms card holds them).
    expect(screen.queryByTestId('project-hours-consumption-facts')).toBeNull()
    expect(screen.queryByText('120 h')).toBeNull()
    expect(screen.queryByText('Hours left')).toBeNull()
    expect(screen.queryByText('Hours used in this period')).toBeNull()
    expect(group().contains(banner)).toBe(true)
  })

  it('the same for a fixed price: no man-days used, no estimate, no max effort', async () => {
    serve(() => problem(503, 'host_unavailable'))
    mount(fixedPrice(10))

    await screen.findByTestId('project-hours-consumption-unavailable')

    expect(screen.queryByText('Man-days used')).toBeNull()
    expect(screen.queryByText('Estimated man-days')).toBeNull()
    expect(screen.queryByText('Max effort')).toBeNull()
  })

  it('does not take focus when it first fails (the person is reading the page, not the card)', async () => {
    serve(() => problem(503, 'host_unavailable'))
    mount(yearly())

    await screen.findByTestId('project-hours-consumption-unavailable')

    expect(document.activeElement).toBe(document.body)
  })
})

describe('Retry', () => {
  it('shows the loading state, then the figures, and moves focus to the block, which the Retry button no longer is there to hold', async () => {
    let attempt = 0
    serve(() => (++attempt === 1 ? problem(503, 'host_unavailable') : { status: 200, body: summary() }))
    mount(yearly())
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }))

    await loaded()

    expect(reads()).toHaveLength(2)
    expect(screen.queryByTestId('project-hours-consumption-unavailable')).toBeNull()
    expect(document.activeElement).toBe(group())
  })

  it('a Retry that fails shows the alert again, and the block holds the focus', async () => {
    serve(() => problem(503, 'host_unavailable'))
    mount(yearly())
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }))

    await waitFor(() => expect(reads()).toHaveLength(2))
    const banner = await screen.findByTestId('project-hours-consumption-unavailable')
    await waitFor(() => expect(document.activeElement).toBe(group()))
    expect(banner.getAttribute('role')).toBe('alert')
  })
})

describe('after a save made with Record hours (AC-2.8, D84)', () => {
  const projectEvent = { on: 'project', targetId: 'p1' }

  it('reads again when the event names this project, and shows the new figures without a reload', async () => {
    let windowMinutes = 5070
    serve(() => ({ status: 200, body: summary({ windowMinutes }) }))
    mount(yearly(120))
    await loaded()
    expect(fact('Hours used in this period')).toBe('84 h 30')

    windowMinutes = 5130
    recorded(projectEvent)

    await waitFor(() => expect(fact('Hours used in this period')).toBe('85 h 30'))
    expect(fact('Hours left')).toBe('34 h 30')
    expect(reads().map((read) => read.params)).toEqual([
      { projectId: 'p1', windowFrom: '2026-03-01', windowTo: '2027-02-28' },
      { projectId: 'p1', windowFrom: '2026-03-01', windowTo: '2027-02-28' },
    ])
  })

  it('keeps the figures on screen, with no skeleton, until the answer arrives', async () => {
    serve(() => ({ status: 200, body: summary({ windowMinutes: 5070 }) }))
    mount(yearly(120))
    await loaded()
    const again = deferred()
    serve(() => again.answer)

    recorded(projectEvent)

    await waitFor(() => expect(reads()).toHaveLength(2))
    expect(fact('Hours used in this period')).toBe('84 h 30')
    expect(screen.queryByText('Loading consumption…')).toBeNull()
    expect(screen.queryByTestId('projects-loading')).toBeNull()

    await act(async () => again.release({ status: 200, body: summary({ windowMinutes: 5130 }) }))
    await waitFor(() => expect(fact('Hours used in this period')).toBe('85 h 30'))
  })

  it('works for a fixed price too (all time)', async () => {
    let total = 3600
    serve(() => ({ status: 200, body: summary({ totalMinutes: total, windowMinutes: null }) }))
    mount(fixedPrice(10))
    await loaded()
    expect(fact('Man-days used')).toBe('7.5 man-days')

    total = 4080
    recorded(projectEvent)

    await waitFor(() => expect(fact('Man-days used')).toBe('8.5 man-days'))
  })

  it('a failed re-read shows the usual warning with Retry and no figure, never the old one as if it were current', async () => {
    serve(() => ({ status: 200, body: summary() }))
    mount(yearly(120))
    await loaded()
    serve(() => problem(503, 'host_unavailable'))

    recorded(projectEvent)

    const banner = await screen.findByTestId('project-hours-consumption-unavailable')
    expect(within(banner).getByRole('button', { name: 'Retry' })).not.toBeNull()
    expect(screen.queryByTestId('project-hours-consumption-facts')).toBeNull()
    // The person did not ask for this read, so it does not take their focus.
    expect(document.activeElement).toBe(document.body)
  })

  it.each([
    ['another project', { on: 'project', targetId: 'p2' }],
    ['a deal with the same id', { on: 'deal', targetId: 'p1' }],
    ['other work', { on: 'none', targetId: '' }],
    ['a blank target', { on: 'project', targetId: ' ' }],
    ['an extra member', { on: 'project', targetId: 'p1', minutes: 60 }],
    ['an unknown kind', { on: 'meeting', targetId: 'p1' }],
    ['a target that is not text', { on: 'project', targetId: 1 }],
    ['no detail', undefined],
    ['a detail that is not an object', 'p1'],
  ])('ignores an event naming %s: it is not a save on this project', async (_name, detail) => {
    answers(summary())
    mount(yearly(120))
    await loaded()

    recorded(detail)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })

    expect(reads()).toHaveLength(1)
    expect(screen.queryByText('Loading consumption…')).toBeNull()
  })

  it('ignores a plain Event with the right name but no detail', async () => {
    answers(summary())
    mount(yearly(120))
    await loaded()

    act(() => {
      window.dispatchEvent(new Event(TIME_ENTRY_RECORDED))
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })

    expect(reads()).toHaveLength(1)
  })

  it('a burst of events is one re-read', async () => {
    answers(summary())
    mount(yearly(120))
    await loaded()

    act(() => {
      for (let count = 0; count < 5; count += 1) {
        window.dispatchEvent(new CustomEvent(TIME_ENTRY_RECORDED, { detail: projectEvent }))
      }
    })
    await waitFor(() => expect(reads()).toHaveLength(2))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })

    expect(reads()).toHaveLength(2)
  })

  it('an event while a read is still in flight restarts it: the first is aborted and its late answer is dropped', async () => {
    const first = deferred()
    const second = deferred()
    const queue = [first, second]
    serve(() => queue.shift()!.answer)
    mount(yearly(120))
    await waitFor(() => expect(reads()).toHaveLength(1))

    recorded(projectEvent)
    await waitFor(() => expect(reads()).toHaveLength(2))

    expect(reads()[0]!.signal?.aborted).toBe(true)
    expect(reads()[1]!.signal?.aborted).toBe(false)
    await act(async () => first.release({ status: 200, body: summary({ windowMinutes: 60 }) }))
    expect(screen.queryByTestId('project-hours-consumption-facts')).toBeNull()
    await act(async () => second.release({ status: 200, body: summary({ windowMinutes: 120 }) }))
    await loaded()
    expect(fact('Hours used in this period')).toBe('2 h')
  })

  it('stops listening when the block goes: no read after it unmounts', async () => {
    answers(summary())
    const { unmount } = mount(yearly(120))
    await loaded()
    unmount()

    recorded(projectEvent)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })

    expect(reads()).toHaveLength(1)
  })

  it('a package that has not started has nothing to re-read, and an event changes nothing', async () => {
    mount(yearly(120, null))

    recorded(projectEvent)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })

    expect(reads()).toEqual([])
    expect(fact('Starts on')).toBe('01.03.2026')
  })
})

describe('when the terms change under the block', () => {
  it('a new window is a new read, and the old window figures are not shown for it', async () => {
    answers(summary({ windowMinutes: 5070 }))
    const view = mount(yearly(120, period('2026-03-01', '2027-02-28')))
    await loaded()
    const next = deferred()
    serve(() => next.answer)

    view.rerender(<ConsumptionBlock projectId="p1" terms={yearly(120, period('2027-03-01', '2028-02-29'))} />)

    await waitFor(() => expect(reads()).toHaveLength(2))
    expect(reads()[1]!.params).toMatchObject({ windowFrom: '2027-03-01', windowTo: '2028-02-29' })
    expect(screen.getByText('Loading consumption…')).not.toBeNull()
    expect(screen.queryByTestId('project-hours-consumption-facts')).toBeNull()
    await act(async () => next.release({ status: 200, body: summary({ windowMinutes: 60 }) }))
    await loaded()
    expect(fact('Hours used in this period')).toBe('1 h')
    expect(fact('Current period')).toBe('01.03.2027 – 29.02.2028')
  })

  it('the same window with other terms (the package edited) is drawn again with no new read', async () => {
    answers(summary({ windowMinutes: 5070 }))
    const view = mount(yearly(120))
    await loaded()
    expect(fact('Hours left')).toBe('35 h 30')

    // A fresh object for the same window, as the page's re-read after a terms save hands over.
    view.rerender(<ConsumptionBlock projectId="p1" terms={yearly(150)} />)

    await waitFor(() => expect(fact('Hours left')).toBe('65 h 30'))
    expect(reads()).toHaveLength(1)
  })

  it('terms that stop having anything to compare take the block away', async () => {
    answers(summary())
    const view = mount(yearly(120))
    await loaded()

    view.rerender(<ConsumptionBlock projectId="p1" terms={slaOnly()} />)

    expect(screen.queryByTestId('project-hours-consumption')).toBeNull()
  })
})

describe('a different project', () => {
  it('asks again for the project it is now about', async () => {
    answers(summary())
    const view = mount(yearly(120), 'p1')
    await loaded()

    view.rerender(<ConsumptionBlock projectId="p2" terms={yearly(120)} />)

    await waitFor(() => expect(reads()).toHaveLength(2))
    expect(reads()[1]!.params).toMatchObject({ projectId: 'p2' })
  })

  it('listens for the events of the new project, not the old one', async () => {
    answers(summary())
    const view = mount(yearly(120), 'p1')
    await loaded()
    view.rerender(<ConsumptionBlock projectId="p2" terms={yearly(120)} />)
    await waitFor(() => expect(reads()).toHaveLength(2))
    await loaded()

    recorded({ on: 'project', targetId: 'p1' })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(reads()).toHaveLength(2)

    recorded({ on: 'project', targetId: 'p2' })
    await waitFor(() => expect(reads()).toHaveLength(3))
  })
})
