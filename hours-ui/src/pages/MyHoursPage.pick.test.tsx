/**
 * @vitest-environment jsdom
 *
 * My hours, the period's date field (specs/20261116-record-hours-in-place T23; AC-5.30, AC-5.31, AC-5.21, AC-5.28, R16;
 * plan decision 14, § The address of My hours, § The table view on screen "Date field"; design F7). A day picked or typed in
 * the field of the week or of the month shows the week or the month holding it — the address written, the period read in
 * whole, the heading and the navigator following — and a day of the period shown, an emptied value, a day before the first
 * period and a day after today change nothing, write nothing and read nothing. The field is the toolbar's, so it keeps its
 * text and its focus through the read the navigation causes. Rendered through the inner router with a memory history and
 * `fakeApi` behind `apiFetch`, so an assertion about a request is about the query string the real `hoursApi` builds. The
 * field's own rules (what is complete, what is in range, what it shows on blur) are `PeriodDateField.test.tsx`'s and
 * `tablePeriod.test.ts`'s; this proves the page is wired to them, for both periods (`describe.each`).
 *
 * Today is Friday 13 November 2026 (`TODAY_INSTANT`): this week is Monday 9 – Sunday 15 November, the current month is
 * November. Chromium typed key by key is the task's real-browser check and e2e journey G's.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RouterProvider, createMemoryHistory } from '@tanstack/react-router'

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock('shell/session', async () => (await import('../test-support/fakeSession')).shellSessionMock(apiFetch))

import { createAppRouter } from '../router'
import { strings } from '../strings'
import {
  dealItem,
  dealOn,
  entriesPage,
  fakeApi,
  listsHandler,
  page,
  problem,
  projectItem,
  projectOn,
  requests,
  timeEntryView,
} from '../test-support/fakeApi'
import type { FakeHandler } from '../test-support/fakeApi'
import { LISTS, TODAY_INSTANT, totalsHandler } from '../test-support/fixtures/myHours'
import type { TimeEntryView } from '../lib/hoursApi.types'

const w = strings.table

let api: ReturnType<typeof fakeApi>

let entrySeq = 0
const entry = (day: string, minutes: number, on: TimeEntryView['on']): TimeEntryView =>
  timeEntryView({ id: `e${++entrySeq}`, day, minutes, on })

/** What the person worked on this week (13 November), the week before, and in the middle of October and of September. */
const ENTRIES: TimeEntryView[] = [
  entry('2026-11-09', 240, projectOn('p-alpha', 'Alpenstrom')),
  entry('2026-11-10', 150, projectOn('p-alpha', 'Alpenstrom')),
  entry('2026-11-03', 180, projectOn('p-alpha', 'Alpenstrom')),
  entry('2026-10-14', 90, projectOn('p-alpha', 'Alpenstrom')),
  entry('2026-10-20', 120, projectOn('p-alpha', 'Alpenstrom')),
  entry('2026-09-03', 60, dealOn('d-brera', 'Brera configurator')),
]

/** `GET /time-entries` over `items`: the ones whose day is within `from`..`to`, as the server answers a ranged read. */
const entriesInRange =
  (items: TimeEntryView[]): FakeHandler =>
  (url) => {
    const from = url.searchParams.get('from') ?? ''
    const to = url.searchParams.get('to') ?? ''
    return { status: 200, body: entriesPage(items.filter((item) => item.day >= from && item.day <= to)) }
  }

const useApi = (overrides: Parameters<typeof fakeApi>[0] = {}) => {
  api = fakeApi({
    'GET /time-lists': listsHandler(LISTS),
    'GET /time-entries': entriesInRange(ENTRIES),
    'GET /time-entries/totals': totalsHandler,
    'GET /deals': () => ({ status: 200, body: page([dealItem({ id: 'd1', title: 'Acme renewal' })]) }),
    'GET /projects': () => ({ status: 200, body: page([projectItem({ id: 'p1', name: 'Project Alpha' })]) }),
    ...overrides,
  })
  apiFetch.mockImplementation(api)
}

const renderPage = async (path: string) => {
  const history = createMemoryHistory({ initialEntries: [path] })
  const router = createAppRouter('/hours', undefined, history)
  render(<RouterProvider router={router} />)
  await screen.findByTestId('hours-my-page')
  return router
}

const entriesCalls = () => requests(api, 'GET /time-entries')
const urlOf = (router: Awaited<ReturnType<typeof renderPage>>) =>
  Object.fromEntries(new URLSearchParams(router.state.location.searchStr))
const spanOf = (call: ReturnType<typeof entriesCalls>[number]) => [call.query['from'], call.query['to']]

const heading = () => screen.getByTestId('hours-table-heading')
const button = (name: string) => screen.getByRole('button', { name })
const dateField = (label: string) => screen.getByLabelText(label) as HTMLInputElement
const settled = () => waitFor(() => expect(screen.queryByTestId('hours-table-skeleton')).toBeNull())
const setValue = (input: HTMLInputElement, value: string) => fireEvent.change(input, { target: { value } })
const blur = (input: HTMLInputElement) => act(() => input.blur())

beforeEach(() => {
  apiFetch.mockReset()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(TODAY_INSTANT))
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

type Case = {
  kind: 'week' | 'month'
  label: string
  /** The address of the current period, and of a past one (the week before, October). */
  now: string
  past: string
  /** What the address holds for the past period, and the heading, span and reference day it makes. */
  pastUrl: Record<string, string>
  pastHeading: string
  pastSpan: string[]
  pastReference: string
  /** A day of the period shown when it is `now` and another when it is `past`, other than the day the field shows. */
  inNow: string
  inPast: string
  /** A day of another period, which is neither: and what the page shows and writes for it. */
  elsewhere: string
  elsewhereUrl: Record<string, string>
  elsewhereHeading: string
  elsewhereSpan: string[]
  elsewhereReference: string
  /** The period the field shows for a day of `now` that is today's own: the current one, with an address with no keys. */
  nowUrl: Record<string, string>
  nowHeading: string
}

const WEEK: Case = {
  kind: 'week',
  label: w.week.pick.label,
  now: '/hours',
  past: '/hours?week=2026-11-02',
  pastUrl: { week: '2026-11-02' },
  pastHeading: 'Week 02.11.2026 – 08.11.2026',
  pastSpan: ['2026-11-02', '2026-11-08'],
  pastReference: '2026-11-02',
  inNow: '2026-11-11',
  inPast: '2026-11-05',
  elsewhere: '2026-10-14',
  elsewhereUrl: { week: '2026-10-12' },
  elsewhereHeading: 'Week 12.10.2026 – 18.10.2026',
  elsewhereSpan: ['2026-10-12', '2026-10-18'],
  elsewhereReference: '2026-10-12',
  nowUrl: {},
  nowHeading: 'Week 09.11.2026 – 15.11.2026',
}

const MONTH: Case = {
  kind: 'month',
  label: w.month.pick.label,
  now: '/hours?view=month',
  past: '/hours?view=month&month=2026-10',
  pastUrl: { view: 'month', month: '2026-10' },
  pastHeading: 'October 2026',
  pastSpan: ['2026-10-01', '2026-10-31'],
  pastReference: '2026-10-01',
  inNow: '2026-11-02',
  inPast: '2026-10-28',
  elsewhere: '2026-09-03',
  elsewhereUrl: { view: 'month', month: '2026-09' },
  elsewhereHeading: 'September 2026',
  elsewhereSpan: ['2026-09-01', '2026-09-30'],
  elsewhereReference: '2026-09-01',
  nowUrl: { view: 'month' },
  nowHeading: 'November 2026',
}

describe.each([WEEK, MONTH])('the date field of the $kind, in the page', (c) => {
  describe('what it shows (AC-5.30, G21)', () => {
    it('is in the toolbar of the table view, showing today on the current period, up to today, and not on the List', async () => {
      useApi()
      await renderPage(c.now)
      await screen.findByTestId('hours-table-table')
      const field = dateField(c.label)
      expect(screen.getByTestId('hours-table-toolbar').contains(field)).toBe(true)
      expect(field.value).toBe('2026-11-13')
      expect(field.max).toBe('2026-11-13')
      cleanup()
      apiFetch.mockReset()
      useApi()
      await renderPage('/hours?view=list')
      expect(screen.queryByLabelText(c.label)).toBeNull()
    })

    it('shows the first day of a past period, from its address', async () => {
      useApi()
      await renderPage(c.past)
      await screen.findByTestId('hours-table-table')
      expect(dateField(c.label).value).toBe(c.pastReference)
    })

    it('shows the new period’s reference day when another control moves the period: the navigator’s Previous', async () => {
      useApi()
      await renderPage(c.now)
      await screen.findByTestId('hours-table-table')
      await userEvent.click(button(w[c.kind].nav.previous))
      await waitFor(() => expect(entriesCalls()).toHaveLength(2))
      await settled()
      expect(dateField(c.label).value).toBe(c.kind === 'week' ? '2026-11-02' : '2026-10-01')
      await userEvent.click(button(w[c.kind].nav.current))
      await waitFor(() => expect(entriesCalls()).toHaveLength(3))
      await settled()
      expect(dateField(c.label).value).toBe('2026-11-13')
    })

    it('shows the other kind’s own field after the Period switch: its label, and the reference day of the period it shows', async () => {
      useApi()
      await renderPage(c.now)
      await screen.findByTestId('hours-table-table')
      const other = c.kind === 'week' ? 'month' : 'week'
      await userEvent.click(screen.getByRole('radio', { name: w.period[other] }))
      await waitFor(() => expect(entriesCalls()).toHaveLength(2))
      await settled()
      // Today is in both the current week and the current month.
      expect(dateField(w[other].pick.label).value).toBe('2026-11-13')
      expect(dateField(w[other].pick.label).max).toBe('2026-11-13')
    })
  })

  describe('a day in another period shows that period (AC-5.30)', () => {
    it('writes the address, reads the period’s whole span once, and heads, labels and navigates by the period it holds', async () => {
      useApi()
      const router = await renderPage(c.now)
      await screen.findByTestId('hours-table-table')

      setValue(dateField(c.label), c.elsewhere)

      await waitFor(() => expect(entriesCalls()).toHaveLength(2))
      expect(entriesCalls().map(spanOf).at(-1)).toEqual(c.elsewhereSpan)
      expect(entriesCalls().at(-1)!.query).toMatchObject({ whose: 'mine', limit: '500' })
      expect(urlOf(router)).toEqual(c.elsewhereUrl)
      await waitFor(() => expect(heading().textContent).toBe(c.elsewhereHeading))
      await screen.findByTestId('hours-table-table')
      // The period's Next is available: it is before the current one (AC-5.28).
      expect(button(w[c.kind].nav.next).getAttribute('aria-disabled')).toBeNull()
      expect(button(w[c.kind].nav.current).getAttribute('aria-disabled')).toBeNull()
    })

    it('keeps the day just picked and the focus in the field through the read, and shows the reference day once it loses focus', async () => {
      useApi()
      await renderPage(c.now)
      await screen.findByTestId('hours-table-table')
      const field = dateField(c.label)
      await userEvent.click(field)
      expect(document.activeElement).toBe(field)

      setValue(field, c.elsewhere)
      await waitFor(() => expect(heading().textContent).toBe(c.elsewhereHeading))
      await screen.findByTestId('hours-table-table')

      expect(dateField(c.label)).toBe(field)
      expect(document.activeElement).toBe(field)
      expect(field.value).toBe(c.elsewhere)
      blur(field)
      expect(field.value).toBe(c.elsewhereReference)
    })

    it('goes from one past period to another, and back to the current one with an address that holds no period', async () => {
      useApi()
      const router = await renderPage(c.past)
      await screen.findByTestId('hours-table-table')

      setValue(dateField(c.label), c.elsewhere)
      await waitFor(() => expect(heading().textContent).toBe(c.elsewhereHeading))
      await settled()
      expect(urlOf(router)).toEqual(c.elsewhereUrl)

      setValue(dateField(c.label), '2026-11-13')
      await waitFor(() => expect(heading().textContent).toBe(c.nowHeading))
      await settled()
      expect(urlOf(router)).toEqual(c.nowUrl)
      expect(button(w[c.kind].nav.next).getAttribute('aria-disabled')).toBe('true')
    })

    it('keeps every filter, in the address and in the read (AC-5.21, AC-5.22)', async () => {
      useApi()
      const router = await renderPage(`${c.now}${c.now.includes('?') ? '&' : '?'}category=tc-formazione`)
      await screen.findByTestId('hours-table-table')

      setValue(dateField(c.label), c.elsewhere)

      await waitFor(() => expect(entriesCalls()).toHaveLength(2))
      expect(entriesCalls().at(-1)!.query).toMatchObject({ categoryId: 'tc-formazione' })
      expect(entriesCalls().map(spanOf).at(-1)).toEqual(c.elsewhereSpan)
      expect(urlOf(router)).toEqual({ ...c.elsewhereUrl, category: 'tc-formazione' })
    })

    it('reads a typed date once, in full, however many keys it took', async () => {
      useApi()
      const router = await renderPage(c.now)
      await screen.findByTestId('hours-table-table')
      const field = dateField(c.label)
      await userEvent.clear(field)
      await userEvent.type(field, c.elsewhere)
      await waitFor(() => expect(heading().textContent).toBe(c.elsewhereHeading))
      await settled()
      expect(entriesCalls().map(spanOf)).toEqual([
        c.kind === 'week' ? ['2026-11-09', '2026-11-15'] : ['2026-11-01', '2026-11-30'],
        c.elsewhereSpan,
      ])
      expect(urlOf(router)).toEqual(c.elsewhereUrl)
    })
  })

  describe('nothing is read for a day that is not a period to show (AC-5.30, AC-5.31, R16)', () => {
    /** Every refusal leaves the address, the heading and the reads as they were. */
    const expectNothingChanged = async (
      router: Awaited<ReturnType<typeof renderPage>>,
      url: Record<string, string>,
    ) => {
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(entriesCalls()).toHaveLength(1)
      expect(urlOf(router)).toEqual(url)
      expect(heading().textContent).toBe(c.nowHeading)
    }

    it('a day of the period shown changes nothing, today and another day of it', async () => {
      useApi()
      const router = await renderPage(c.now)
      await screen.findByTestId('hours-table-table')
      setValue(dateField(c.label), c.inNow)
      await expectNothingChanged(router, c.nowUrl)
      setValue(dateField(c.label), '2026-11-13')
      await expectNothingChanged(router, c.nowUrl)
    })

    it('a day of a past period shown, another day of it, changes nothing either', async () => {
      useApi()
      const router = await renderPage(c.past)
      await screen.findByTestId('hours-table-table')
      setValue(dateField(c.label), c.inPast)
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(entriesCalls()).toHaveLength(1)
      expect(urlOf(router)).toEqual(c.pastUrl)
      expect(heading().textContent).toBe(c.pastHeading)
    })

    it('an emptied value, tomorrow and a day far in the future change nothing, and the reference day is given back on blur', async () => {
      useApi()
      const router = await renderPage(c.now)
      await screen.findByTestId('hours-table-table')
      const field = dateField(c.label)
      await userEvent.click(field)
      for (const value of ['', '2026-11-14', '2027-06-01', '9999-12-31']) {
        setValue(field, value)
        await expectNothingChanged(router, c.nowUrl)
        expect(field.value).toBe(value)
      }
      blur(field)
      expect(field.value).toBe('2026-11-13')
    })

    it('a day before the first period changes nothing: the intermediate years of a date typed digit by digit', async () => {
      useApi()
      const router = await renderPage(c.now)
      await screen.findByTestId('hours-table-table')
      const field = dateField(c.label)
      await userEvent.click(field)
      for (const value of ['0002-10-14', '0020-10-14', '0202-10-14', c.kind === 'week' ? '2000-01-02' : '1999-12-31'])
        setValue(field, value)
      await expectNothingChanged(router, c.nowUrl)
      // … and the complete day then reads its period, once.
      setValue(field, c.elsewhere)
      await waitFor(() => expect(entriesCalls()).toHaveLength(2))
      await settled()
      expect(entriesCalls().map(spanOf).at(-1)).toEqual(c.elsewhereSpan)
    })

    it('the first period the address accepts can be picked: 2000-01-03 for a week, 2000-01-01 for a month', async () => {
      useApi()
      await renderPage(c.now)
      await screen.findByTestId('hours-table-table')
      const first = c.kind === 'week' ? '2000-01-03' : '2000-01-01'
      expect(dateField(c.label).min).toBe(first)
      setValue(dateField(c.label), first)
      await waitFor(() => expect(entriesCalls()).toHaveLength(2))
      expect(entriesCalls().map(spanOf).at(-1)).toEqual(
        c.kind === 'week' ? ['2000-01-03', '2000-01-09'] : ['2000-01-01', '2000-01-31'],
      )
    })
  })

  describe('it stays mounted through every read, and keeps what was typed while it has focus (R16)', () => {
    it('is the same input through the skeleton of the read it caused', async () => {
      let release: () => void = () => {}
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      useApi({
        'GET /time-entries': async (url, init, params) => {
          if (url.searchParams.get('from') === c.elsewhereSpan[0]) await gate
          return entriesInRange(ENTRIES)(url, init, params)
        },
      })
      await renderPage(c.now)
      await screen.findByTestId('hours-table-table')
      const field = dateField(c.label)
      await userEvent.click(field)

      setValue(field, c.elsewhere)
      await screen.findByTestId('hours-table-skeleton')
      expect(dateField(c.label)).toBe(field)
      expect(document.activeElement).toBe(field)
      expect(field.value).toBe(c.elsewhere)
      release()
      await screen.findByTestId('hours-table-table')
      expect(dateField(c.label)).toBe(field)
      expect(document.activeElement).toBe(field)
    })

    it('is the same input through a read that fails, and Retry reads the period it caused', async () => {
      let failing = false
      useApi({
        'GET /time-entries': (url, init, params) =>
          failing && url.searchParams.get('from') === c.elsewhereSpan[0]
            ? { status: 500, body: problem(500) }
            : entriesInRange(ENTRIES)(url, init, params),
      })
      await renderPage(c.now)
      await screen.findByTestId('hours-table-table')
      const field = dateField(c.label)
      await userEvent.click(field)

      failing = true
      setValue(field, c.elsewhere)
      await screen.findByTestId('hours-table-error')
      expect(screen.queryByTestId('hours-table-table')).toBeNull()
      expect(dateField(c.label)).toBe(field)
      expect(field.value).toBe(c.elsewhere)
      expect(heading().textContent).toBe(c.elsewhereHeading)
    })

    it('is the same input through the deal filter’s refusal, which replaces the grid and not the toolbar', async () => {
      useApi({
        'GET /time-entries': (url, init, params) =>
          url.searchParams.has('dealId')
            ? { status: 503, body: problem(503, 'host_unavailable') }
            : entriesInRange(ENTRIES)(url, init, params),
      })
      await renderPage(c.now)
      await screen.findByTestId('hours-table-table')
      const field = dateField(c.label)
      await userEvent.click(field)
      setValue(field, '')

      await userEvent.type(screen.getByRole('combobox', { name: strings.filters.deal.label }), 'a')
      await userEvent.click(await screen.findByRole('option', { name: /Acme renewal/ }))
      await screen.findByTestId('hours-deal-filter-unavailable')

      expect(dateField(c.label)).toBe(field)
      expect(screen.getByTestId('hours-table-toolbar').contains(field)).toBe(true)
    })

    it('is the same input through an empty period', async () => {
      useApi({ 'GET /time-entries': entriesInRange([]) })
      await renderPage(c.now)
      await screen.findByTestId('hours-table-empty')
      const field = dateField(c.label)
      setValue(field, c.elsewhere)
      await waitFor(() => expect(heading().textContent).toBe(c.elsewhereHeading))
      await screen.findByTestId('hours-table-empty')
      expect(dateField(c.label)).toBe(field)
    })
  })
})

describe('the month keeps the week it was reached from, whichever way the month is changed (AC-5.27, D26)', () => {
  it('a month picked in the field leaves `week` in the address, as the navigator does, for the way back to the week', async () => {
    useApi()
    const router = await renderPage('/hours?view=month&month=2026-10&week=2026-10-12')
    await screen.findByTestId('hours-table-table')

    setValue(dateField(w.month.pick.label), '2026-09-03')
    await waitFor(() => expect(heading().textContent).toBe('September 2026'))
    await settled()

    expect(urlOf(router)).toEqual({ view: 'month', month: '2026-09', week: '2026-10-12' })
  })
})

describe('the date field and the shell around it', () => {
  it('is the table view’s: the Table tab shows it, the List does not, and the way back finds it again', async () => {
    useApi()
    await renderPage('/hours')
    await screen.findByTestId('hours-table-table')
    expect(screen.queryByLabelText(w.week.pick.label)).not.toBeNull()

    await userEvent.click(screen.getByRole('tab', { name: w.view.list }))
    await waitFor(() => expect(screen.queryByLabelText(w.week.pick.label)).toBeNull())

    await userEvent.click(screen.getByRole('tab', { name: w.view.table }))
    expect(await screen.findByLabelText(w.week.pick.label)).not.toBeNull()
    expect(within(screen.getByTestId('hours-table-toolbar')).getByLabelText(w.week.pick.label)).not.toBeNull()
  })
})
