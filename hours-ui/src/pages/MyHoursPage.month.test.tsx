/**
 * @vitest-environment jsdom
 *
 * My hours, the month (specs/20261116-record-hours-in-place T22; AC-5.2, AC-5.5, AC-5.21, AC-5.22, AC-5.25–AC-5.29,
 * AC-5.32, AC-4.6; plan § The address of My hours, § `TablePeriod`, § The period's read; design F3, S7). The Period switch
 * between week and month and what each writes to the address, the month's addresses and the read each makes (its span, its
 * filters, nothing of the future), the navigator over months, the filters through every switch and the refusal that
 * replaces the month's grid. Rendered through the inner router with a memory history and `fakeApi` behind `apiFetch`, so an
 * assertion about a request is about the query string the real `hoursApi` builds. The month's own grid is `TableView`'s and
 * `tableGrid`'s; Edit, Delete and Add hours from a month cell are `MyHoursPage.cells.test.tsx`'s (run for both periods).
 *
 * Today is Friday 13 November 2026 (`TODAY_INSTANT`) unless a case says otherwise: this week is Monday 9 – Sunday 15 November
 * and the current month is November, which has 30 days and begins on a Sunday.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RouterProvider, createMemoryHistory } from '@tanstack/react-router'

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock('shell/session', async () => (await import('../test-support/fakeSession')).shellSessionMock(apiFetch))

import { createAppRouter } from '../router'
import HoursShell from '../components/HoursShell'
import { strings } from '../strings'
import {
  dealItem,
  dealOn,
  entriesPage,
  fakeApi,
  listsHandler,
  otherWorkOn,
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

const f = strings.filters
const w = strings.table

let api: ReturnType<typeof fakeApi>

let entrySeq = 0
const entry = (day: string, minutes: number, on: TimeEntryView['on']): TimeEntryView =>
  timeEntryView({ id: `e${++entrySeq}`, day, minutes, on })

/** What the person worked on in November (this week and the week before) and in October (a week of its middle, and its 20th and 21st). */
const ENTRIES: TimeEntryView[] = [
  entry('2026-11-09', 240, projectOn('p-alpha', 'Alpenstrom')),
  entry('2026-11-10', 150, projectOn('p-alpha', 'Alpenstrom')),
  entry('2026-11-11', 60, dealOn('d-brera', 'Brera configurator')),
  entry('2026-11-03', 180, projectOn('p-alpha', 'Alpenstrom')),
  entry('2026-10-14', 90, projectOn('p-alpha', 'Alpenstrom')),
  entry('2026-10-20', 120, projectOn('p-alpha', 'Alpenstrom')),
  entry('2026-10-21', 60, otherWorkOn('Formazione', 'tc-formazione')),
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
const totalsCalls = () => requests(api, 'GET /time-entries/totals')
const urlOf = (router: Awaited<ReturnType<typeof renderPage>>) =>
  Object.fromEntries(new URLSearchParams(router.state.location.searchStr))

const viewTab = (name: string) => screen.getByRole('tab', { name })
const heading = () => screen.getByTestId('hours-table-heading')
const rowOf = (key: string) => screen.getByTestId(`hours-table-row-${key}`)
const radio = (name: string) => screen.getByRole('radio', { name }) as HTMLInputElement
const nav = (kind: 'week' | 'month') => w[kind].nav
const button = (name: string) => screen.getByRole('button', { name })
const select = (name: string) => screen.getByRole('combobox', { name }) as HTMLSelectElement
const dayHeaders = () => within(screen.getByRole('table')).getAllByRole('columnheader').slice(1, -1)
const spanOf = (call: ReturnType<typeof entriesCalls>[number]) => [call.query['from'], call.query['to']]

const pickDeal = async () => {
  await userEvent.type(screen.getByRole('combobox', { name: f.deal.label }), 'a')
  await userEvent.click(await screen.findByRole('option', { name: /Acme renewal/ }))
}

const setToday = (iso: string) => vi.setSystemTime(new Date(iso))

/** The period has been read, whether it holds hours or not: no skeleton is left. */
const settled = () => waitFor(() => expect(screen.queryByTestId('hours-table-skeleton')).toBeNull())

beforeEach(() => {
  apiFetch.mockReset()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(TODAY_INSTANT))
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('the month at its own address (AC-5.2, AC-5.25)', () => {
  it('?view=month opens the current month: its heading, the Month radio, one read of its 30 days and none of the List’s', async () => {
    useApi()
    await renderPage('/hours?view=month')
    await screen.findByTestId('hours-table-table')

    expect(heading().textContent).toBe('November 2026')
    expect(viewTab(w.view.table).getAttribute('aria-selected')).toBe('true')
    expect(radio(w.period.month).checked).toBe(true)
    expect(radio(w.period.week).checked).toBe(false)
    expect(entriesCalls().map((request) => request.query)).toEqual([
      { whose: 'mine', from: '2026-11-01', to: '2026-11-30', limit: '500' },
    ])
    expect(totalsCalls()).toHaveLength(0)
    expect(screen.queryByTestId('hours-entries')).toBeNull()
  })

  it('draws one column for each of the 30 days and the figures of the month’s entries: November’s three weeks of Alpenstrom', async () => {
    useApi()
    await renderPage('/hours?view=month')
    await screen.findByTestId('hours-table-table')

    expect(dayHeaders()).toHaveLength(30)
    // 4 h + 2 h 30 + 3 h on Alpenstrom, 1 h on Brera: 10 h 30 and 1 h, none of October's
    const total = (key: string) => within(rowOf(key)).getAllByRole('cell').at(-1)?.textContent
    expect(total('project:p-alpha')).toBe('9 h 30')
    expect(total('deal:d-brera')).toBe('1 h')
    expect(within(rowOf('total')).getAllByRole('cell').at(-1)?.textContent).toBe('10 h 30')
    expect(screen.queryByTestId('hours-table-row-category:tc-formazione')).toBeNull()
  })

  it('?view=month&month=2026-10 opens October: 31 days, its own read, and the entries of that month only', async () => {
    useApi()
    await renderPage('/hours?view=month&month=2026-10')
    await screen.findByTestId('hours-table-table')

    expect(heading().textContent).toBe('October 2026')
    expect(dayHeaders()).toHaveLength(31)
    expect(entriesCalls().map(spanOf)).toEqual([['2026-10-01', '2026-10-31']])
    const total = (key: string) => within(rowOf(key)).getAllByRole('cell').at(-1)?.textContent
    expect(total('project:p-alpha')).toBe('3 h 30')
    expect(total('category:tc-formazione')).toBe('1 h')
    expect(screen.queryByTestId('hours-table-row-deal:d-brera')).toBeNull()
    // October is before the current month: Next is there
    expect(button(nav('month').next).getAttribute('aria-disabled')).toBeNull()
  })

  it.each(['/hours?view=month&month=2026-12', '/hours?view=month&month=2027-01', '/hours?view=month&month=9999-12'])(
    '%s names a month after the current one: the current month is shown and read, with Next unavailable, nothing of the future sent (AC-5.29)',
    async (path) => {
      useApi()
      const router = await renderPage(path)
      await screen.findByTestId('hours-table-table')

      expect(heading().textContent).toBe('November 2026')
      expect(entriesCalls().map(spanOf)).toEqual([['2026-11-01', '2026-11-30']])
      expect(button(nav('month').next).getAttribute('aria-disabled')).toBe('true')
      // an address that was clamped is not rewritten
      expect(urlOf(router)['month']).toBe(path.split('month=')[2] ?? path.split('&month=')[1])
    },
  )

  it.each(['nope', '2026-1', '2026-13', '2026-00', '1999-12', '2026-10-05', '202610'])(
    '?view=month&month=%s is not a month hours-api answers for: the current month is read, a pasted link never makes a refused request',
    async (named) => {
      useApi()
      await renderPage(`/hours?view=month&month=${named}`)
      await screen.findByTestId('hours-table-table')

      expect(heading().textContent).toBe('November 2026')
      expect(entriesCalls().map(spanOf)).toEqual([['2026-11-01', '2026-11-30']])
    },
  )

  it('reads `month` in the month only: ?month=2026-10 without view=month is the week, and `week` is ignored in the month', async () => {
    useApi()
    await renderPage('/hours?month=2026-10')
    await screen.findByTestId('hours-table-table')
    expect(entriesCalls().map(spanOf)).toEqual([['2026-11-09', '2026-11-15']])
    cleanup()
    apiFetch.mockReset()
    useApi()
    await renderPage('/hours?view=month&week=2026-10-12')
    await screen.findByTestId('hours-table-table')
    expect(entriesCalls().map(spanOf)).toEqual([['2026-11-01', '2026-11-30']])
  })

  it('a click on an empty cell of the month opens no dialog and sends nothing (AC-5.32)', async () => {
    useApi()
    await renderPage('/hours?view=month')
    await screen.findByTestId('hours-table-table')
    const reads = apiFetch.mock.calls.length

    await userEvent.click(within(rowOf('project:p-alpha')).getAllByRole('cell')[0]!)
    await userEvent.click(within(rowOf('deal:d-brera')).getAllByRole('cell')[29]!)

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(apiFetch.mock.calls).toHaveLength(reads)
  })
})

describe('the navigator over months (AC-5.5, AC-5.28)', () => {
  it('Previous month reads the month before and writes view=month and month=<YYYY-MM>', async () => {
    useApi()
    const router = await renderPage('/hours?view=month')
    await screen.findByTestId('hours-table-table')

    await userEvent.click(button(nav('month').previous))

    await waitFor(() => expect(entriesCalls()).toHaveLength(2))
    expect(spanOf(entriesCalls()[1]!)).toEqual(['2026-10-01', '2026-10-31'])
    expect(urlOf(router)).toEqual({ view: 'month', month: '2026-10' })
    await waitFor(() => expect(heading().textContent).toBe('October 2026'))
    await screen.findByTestId('hours-table-table')
  })

  it('steps back over the turn of a year and over a month of 28 days, reading each in whole', async () => {
    useApi()
    await renderPage('/hours?view=month&month=2026-03')
    await settled()

    await userEvent.click(button(nav('month').previous))
    await waitFor(() => expect(heading().textContent).toBe('February 2026'))
    expect(spanOf(entriesCalls().at(-1)!)).toEqual(['2026-02-01', '2026-02-28'])
    cleanup()
    apiFetch.mockReset()
    useApi()
    await renderPage('/hours?view=month&month=2026-01')
    await settled()
    await userEvent.click(button(nav('month').previous))
    await waitFor(() => expect(heading().textContent).toBe('December 2025'))
    expect(spanOf(entriesCalls().at(-1)!)).toEqual(['2025-12-01', '2025-12-31'])
  })

  it('Next month reads the month after, up to the current one, and then keeps the focus on Next, now unavailable (R18)', async () => {
    useApi()
    const router = await renderPage('/hours?view=month&month=2026-10')
    await screen.findByTestId('hours-table-table')

    button(nav('month').next).focus()
    await userEvent.keyboard('{Enter}')

    await waitFor(() => expect(heading().textContent).toBe('November 2026'))
    expect(spanOf(entriesCalls().at(-1)!)).toEqual(['2026-11-01', '2026-11-30'])
    // the current month is the default one: view=month stays, the month is taken out
    expect(urlOf(router)).toEqual({ view: 'month' })
    expect(button(nav('month').next).getAttribute('aria-disabled')).toBe('true')
    expect(document.activeElement).toBe(button(nav('month').next))
    const reads = entriesCalls().length
    await userEvent.keyboard('{Enter}')
    expect(entriesCalls()).toHaveLength(reads)
  })

  it('This month returns to the current month from a past one, and is unavailable on it', async () => {
    useApi()
    const router = await renderPage('/hours?view=month&month=2026-05')
    await settled()
    expect(button(nav('month').current).getAttribute('aria-disabled')).toBeNull()

    await userEvent.click(button(nav('month').current))

    await waitFor(() => expect(heading().textContent).toBe('November 2026'))
    expect(urlOf(router)).toEqual({ view: 'month' })
    expect(button(nav('month').current).getAttribute('aria-disabled')).toBe('true')
  })

  it('Previous month on January 2000, the first month hours-api answers for, is unavailable and asks for nothing', async () => {
    useApi()
    const router = await renderPage('/hours?view=month&month=2000-01')
    await settled()
    const reads = entriesCalls().length

    expect(button(nav('month').previous).getAttribute('aria-disabled')).toBe('true')
    await userEvent.click(button(nav('month').previous))

    expect(entriesCalls()).toHaveLength(reads)
    expect(urlOf(router)).toEqual({ view: 'month', month: '2000-01' })
  })
})

describe('the Period switch, week to month (AC-5.26, D25)', () => {
  it('from the current week, Month shows the current month and writes view=month alone', async () => {
    useApi()
    const router = await renderPage('/hours')
    await screen.findByTestId('hours-table-table')

    await userEvent.click(radio(w.period.month))

    await waitFor(() => expect(heading().textContent).toBe('November 2026'))
    await screen.findByTestId('hours-table-table')
    expect(spanOf(entriesCalls().at(-1)!)).toEqual(['2026-11-01', '2026-11-30'])
    expect(urlOf(router)).toEqual({ view: 'month' })
    expect(radio(w.period.month).checked).toBe(true)
  })

  it('from a past week, Month shows the month of its Monday and keeps the week in the address for the way back', async () => {
    useApi()
    const router = await renderPage('/hours?week=2026-10-12')
    await screen.findByTestId('hours-table-table')

    await userEvent.click(radio(w.period.month))

    await waitFor(() => expect(heading().textContent).toBe('October 2026'))
    expect(spanOf(entriesCalls().at(-1)!)).toEqual(['2026-10-01', '2026-10-31'])
    expect(urlOf(router)).toEqual({ view: 'month', month: '2026-10', week: '2026-10-12' })
  })

  it('from the current week that straddles two months (Mon 30 Nov – Sun 6 Dec, today Wednesday 2 December), Month is December (D25)', async () => {
    setToday('2026-12-02T12:00:00.000Z')
    useApi()
    await renderPage('/hours')
    await settled()
    expect(heading().textContent).toBe(w.week.title('30.11.2026 – 06.12.2026'))

    await userEvent.click(radio(w.period.month))

    await waitFor(() => expect(heading().textContent).toBe('December 2026'))
    expect(spanOf(entriesCalls().at(-1)!)).toEqual(['2026-12-01', '2026-12-31'])
  })

  it('from that same week once it is a past week (today Wednesday 9 December), Month is November, the month of its Monday', async () => {
    setToday('2026-12-09T12:00:00.000Z')
    useApi()
    await renderPage('/hours?week=2026-11-30')
    await settled()

    await userEvent.click(radio(w.period.month))

    await waitFor(() => expect(heading().textContent).toBe('November 2026'))
    expect(spanOf(entriesCalls().at(-1)!)).toEqual(['2026-11-01', '2026-11-30'])
  })

  it('leaves the focus on the radio that was used, and the toolbar mounted through the read', async () => {
    useApi()
    await renderPage('/hours')
    await screen.findByTestId('hours-table-table')
    const toolbar = screen.getByTestId('hours-table-toolbar')

    await userEvent.click(radio(w.period.month))
    await waitFor(() => expect(heading().textContent).toBe('November 2026'))
    await screen.findByTestId('hours-table-table')

    expect(screen.getByTestId('hours-table-toolbar')).toBe(toolbar)
    expect(document.activeElement).toBe(radio(w.period.month))
  })

  it('the arrow keys switch too: → on Week shows the month, and the other arrow shows the week again', async () => {
    useApi()
    // user-event reads `CSS.escape` to move between the radios of a group; jsdom has none.
    vi.stubGlobal('CSS', { escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, '\\$&') })
    await renderPage('/hours')
    await screen.findByTestId('hours-table-table')

    radio(w.period.week).focus()
    await userEvent.keyboard('{ArrowRight}')
    await waitFor(() => expect(heading().textContent).toBe('November 2026'))
    await screen.findByTestId('hours-table-table')
    await userEvent.keyboard('{ArrowLeft}')
    await waitFor(() => expect(heading().textContent).toBe(w.week.title('09.11.2026 – 15.11.2026')))
    vi.unstubAllGlobals()
  })
})

describe('the Period switch, month to week (AC-5.27, D26)', () => {
  it('returns to the week the month was reached from: week, month, week lands on the past week it left', async () => {
    useApi()
    const router = await renderPage('/hours?week=2026-10-12')
    await screen.findByTestId('hours-table-table')

    await userEvent.click(radio(w.period.month))
    await waitFor(() => expect(heading().textContent).toBe('October 2026'))
    await screen.findByTestId('hours-table-table')
    await userEvent.click(radio(w.period.week))

    await waitFor(() => expect(heading().textContent).toBe(w.week.title('12.10.2026 – 18.10.2026')))
    await screen.findByTestId('hours-table-table')
    expect(spanOf(entriesCalls().at(-1)!)).toEqual(['2026-10-12', '2026-10-18'])
    expect(urlOf(router)).toEqual({ week: '2026-10-12' })
  })

  it('returns to the current week from the current month, whose address holds no week', async () => {
    useApi()
    const router = await renderPage('/hours?view=month')
    await screen.findByTestId('hours-table-table')

    await userEvent.click(radio(w.period.week))

    await waitFor(() => expect(heading().textContent).toBe(w.week.title('09.11.2026 – 15.11.2026')))
    expect(urlOf(router)).toEqual({})
    expect(spanOf(entriesCalls().at(-1)!)).toEqual(['2026-11-09', '2026-11-15'])
  })

  it('shows the first week whose Monday is in the month when the week left has no day in it: October 2026, Monday 5 October', async () => {
    useApi()
    const router = await renderPage('/hours?view=month&month=2026-10')
    await screen.findByTestId('hours-table-table')

    await userEvent.click(radio(w.period.week))

    await waitFor(() => expect(heading().textContent).toBe(w.week.title('05.10.2026 – 11.10.2026')))
    expect(spanOf(entriesCalls().at(-1)!)).toEqual(['2026-10-05', '2026-10-11'])
    expect(urlOf(router)).toEqual({ week: '2026-10-05' })
  })

  it('shows the current week when the month is the one it is in, whichever week was left', async () => {
    useApi()
    await renderPage('/hours?view=month&week=2026-09-07')
    await screen.findByTestId('hours-table-table')

    await userEvent.click(radio(w.period.week))

    await waitFor(() => expect(heading().textContent).toBe(w.week.title('09.11.2026 – 15.11.2026')))
  })

  it('does not take a week after the current one for the week left: a pasted ?week= of next week is the current week', async () => {
    useApi()
    await renderPage('/hours?view=month&week=2026-11-16')
    await screen.findByTestId('hours-table-table')

    await userEvent.click(radio(w.period.week))

    await waitFor(() => expect(heading().textContent).toBe(w.week.title('09.11.2026 – 15.11.2026')))
  })

  it('goes on after a month moved with the navigator: Previous, Previous, Week shows the first week that begins in that month', async () => {
    useApi()
    await renderPage('/hours?view=month')
    await settled()

    await userEvent.click(button(nav('month').previous))
    await waitFor(() => expect(heading().textContent).toBe('October 2026'))
    await userEvent.click(button(nav('month').previous))
    await waitFor(() => expect(heading().textContent).toBe('September 2026'))
    await settled()
    await userEvent.click(radio(w.period.week))

    // 1 September 2026 is a Tuesday: its first Monday is the 7th; the current week (9 – 15 November) is not in September.
    await waitFor(() => expect(heading().textContent).toBe(w.week.title('07.09.2026 – 13.09.2026')))
  })
})

describe('the filters go through every switch of period and view (AC-5.21, AC-5.22)', () => {
  const FILTERS = '&target=project&category=tc-formazione&workType=wt-p-dev'
  const carried = {
    target: 'project',
    categoryId: 'tc-formazione',
    workTypeId: 'wt-p-dev',
  }

  it('Recorded on, Category and Work type in the address are in the month’s read, with the month’s span (AC-5.21)', async () => {
    useApi()
    await renderPage(`/hours?view=month${FILTERS}`)
    await screen.findByTestId('hours-table-table')

    expect(entriesCalls()).toHaveLength(1)
    expect(entriesCalls()[0]!.query).toEqual({
      whose: 'mine',
      from: '2026-11-01',
      to: '2026-11-30',
      limit: '500',
      ...carried,
    })
  })

  it('week → month → week → List → table keeps them all in the address, in the controls and in every read, the List’s period untouched', async () => {
    useApi()
    const router = await renderPage(`/hours?period=lastMonth${FILTERS}`)
    await screen.findByTestId('hours-table-table')
    const held = { period: 'lastMonth', target: 'project', category: 'tc-formazione', workType: 'wt-p-dev' }
    await pickDeal()
    await waitFor(() => expect(entriesCalls().at(-1)!.query['dealId']).toBe('d1'))

    const inEveryRead = () => {
      expect(entriesCalls().at(-1)!.query).toMatchObject({ ...carried, dealId: 'd1' })
      expect(select(f.recordedOn.label).value).toBe('project')
      expect(select(f.category.label).value).toBe('tc-formazione')
      expect(select(f.workType.label).value).toBe('wt-p-dev')
      expect((screen.getByRole('combobox', { name: f.deal.label }) as HTMLInputElement).value).toBe('Acme renewal')
    }

    await userEvent.click(radio(w.period.month))
    await waitFor(() => expect(heading().textContent).toBe('November 2026'))
    await screen.findByTestId('hours-table-table')
    inEveryRead()
    expect(urlOf(router)).toMatchObject({ view: 'month', ...held })

    await userEvent.click(radio(w.period.week))
    await waitFor(() => expect(heading().textContent).toBe(w.week.title('09.11.2026 – 15.11.2026')))
    await screen.findByTestId('hours-table-table')
    inEveryRead()
    expect(urlOf(router)).toEqual(held)

    await userEvent.click(viewTab(w.view.list))
    await screen.findByTestId('hours-entries')
    expect(entriesCalls().at(-1)!.query).toMatchObject({
      from: '2026-10-01',
      to: '2026-10-31',
      ...carried,
      dealId: 'd1',
    })
    expect(select(f.period.label).value).toBe('lastMonth')
    expect(urlOf(router)).toEqual({ view: 'list', ...held })

    await userEvent.click(viewTab(w.view.table))
    await screen.findByTestId('hours-table-table')
    inEveryRead()
    expect(urlOf(router)).toEqual(held)
  })

  it('the List’s period, From and To are read by the List only: a Custom range survives a trip through the month', async () => {
    useApi()
    const router = await renderPage('/hours?view=list&period=custom&from=2026-10-05&to=2026-10-09')
    await screen.findByTestId('hours-entries')

    await userEvent.click(viewTab(w.view.table))
    await screen.findByTestId('hours-table-table')
    await userEvent.click(radio(w.period.month))
    await waitFor(() => expect(heading().textContent).toBe('November 2026'))
    await screen.findByTestId('hours-table-table')
    // the month's span is the month's, whatever the period says
    expect(spanOf(entriesCalls().at(-1)!)).toEqual(['2026-11-01', '2026-11-30'])
    expect(urlOf(router)).toEqual({ view: 'month', period: 'custom', from: '2026-10-05', to: '2026-10-09' })

    await userEvent.click(viewTab(w.view.list))
    await screen.findByTestId('hours-entries')
    expect(spanOf(entriesCalls().at(-1)!)).toEqual(['2026-10-05', '2026-10-09'])
  })

  it('Clear filters in the month clears them and keeps view=month, the month and the picked deal’s absence', async () => {
    useApi()
    const router = await renderPage(`/hours?view=month&month=2026-10${FILTERS}`)
    await screen.findByTestId('hours-table-table')

    await userEvent.click(screen.getByRole('button', { name: f.clear }))

    await waitFor(() => expect(entriesCalls().at(-1)!.query['target']).toBeUndefined())
    expect(urlOf(router)).toEqual({ view: 'month', month: '2026-10' })
    expect(spanOf(entriesCalls().at(-1)!)).toEqual(['2026-10-01', '2026-10-31'])
  })
})

describe('the month and the List (AC-5.1, AC-5.2)', () => {
  it('Month → List → Table comes back to the month it left, and the way on to Week still finds the week it was reached from', async () => {
    useApi()
    const router = await renderPage('/hours?week=2026-10-12')
    await screen.findByTestId('hours-table-table')
    await userEvent.click(radio(w.period.month))
    await waitFor(() => expect(heading().textContent).toBe('October 2026'))
    await screen.findByTestId('hours-table-table')

    await userEvent.click(viewTab(w.view.list))
    await screen.findByTestId('hours-entries')
    expect(urlOf(router)).toEqual({ view: 'list', month: '2026-10', week: '2026-10-12' })

    await userEvent.click(viewTab(w.view.table))
    await screen.findByTestId('hours-table-table')
    expect(heading().textContent).toBe('October 2026')
    expect(urlOf(router)).toEqual({ view: 'month', month: '2026-10', week: '2026-10-12' })

    await userEvent.click(radio(w.period.week))
    await waitFor(() => expect(heading().textContent).toBe(w.week.title('12.10.2026 – 18.10.2026')))
  })

  it('the current month comes back as the current month, and a week as the week', async () => {
    useApi()
    const router = await renderPage('/hours?view=month')
    await screen.findByTestId('hours-table-table')
    await userEvent.click(viewTab(w.view.list))
    await screen.findByTestId('hours-entries')
    await userEvent.click(viewTab(w.view.table))
    await screen.findByTestId('hours-table-table')
    expect(heading().textContent).toBe('November 2026')
    expect(urlOf(router)).toEqual({ view: 'month' })

    await userEvent.click(radio(w.period.week))
    await waitFor(() => expect(heading().textContent).toBe(w.week.title('09.11.2026 – 15.11.2026')))
    await userEvent.click(viewTab(w.view.list))
    await screen.findByTestId('hours-entries')
    await userEvent.click(viewTab(w.view.table))
    await screen.findByTestId('hours-table-table')
    expect(heading().textContent).toBe(w.week.title('09.11.2026 – 15.11.2026'))
    expect(urlOf(router)).toEqual({})
  })

  it('choosing the view already shown writes nothing: a stray `month` in a week’s address does not turn it into the month', async () => {
    useApi()
    const router = await renderPage('/hours?month=2026-10')
    await screen.findByTestId('hours-table-table')

    await userEvent.click(viewTab(w.view.table))

    expect(heading().textContent).toBe(w.week.title('09.11.2026 – 15.11.2026'))
    expect(urlOf(router)).toEqual({ month: '2026-10' })
    expect(entriesCalls()).toHaveLength(1)
  })

  it('the List at its own address reads the month of its Period and none of the table’s span', async () => {
    useApi()
    await renderPage('/hours?view=list')
    await screen.findByTestId('hours-entries')
    expect(entriesCalls().map(spanOf)).toEqual([['2026-11-01', '2026-11-30']])
    expect(screen.queryByTestId('hours-table')).toBeNull()
  })
})

describe('a read that fails, in the month (design S7 States; AC-4.11)', () => {
  const refused = () => ({ status: 503, body: problem(503, 'host_unavailable') }) as const

  it('under a deal filter, a 503 host_unavailable replaces the month’s grid with the List’s one alert, the card keeping its heading and toolbar', async () => {
    useApi({
      'GET /time-entries': (url, init, params) =>
        url.searchParams.has('dealId') ? refused() : entriesInRange(ENTRIES)(url, init, params),
    })
    await renderPage('/hours?view=month')
    await screen.findByTestId('hours-table-table')

    await pickDeal()

    const blocker = await screen.findByTestId('hours-deal-filter-unavailable')
    expect(blocker.getAttribute('role')).toBe('alert')
    expect(screen.queryByTestId('hours-table-table')).toBeNull()
    expect(screen.queryByTestId('hours-table-empty')).toBeNull()
    expect(screen.getByTestId('hours-table').contains(blocker)).toBe(true)
    expect(heading().textContent).toBe('November 2026')
    expect(radio(w.period.month).checked).toBe(true)
    expect(
      within(screen.getByTestId('hours-table')).getByRole('button', { name: nav('month').previous }),
    ).not.toBeNull()
  })

  it('a failed read of the month is one error with Retry and no partial grid: a page that fails is the whole month failing', async () => {
    let failing = true
    useApi({
      'GET /time-entries': (url, init, params) =>
        failing ? { status: 500, body: problem(500) } : entriesInRange(ENTRIES)(url, init, params),
    })
    await renderPage('/hours?view=month')
    await screen.findByTestId('hours-table-error')
    expect(screen.queryByTestId('hours-table-table')).toBeNull()
    expect(heading().textContent).toBe('November 2026')

    failing = false
    await userEvent.click(
      within(screen.getByTestId('hours-table-error')).getByRole('button', { name: strings.common.retry }),
    )

    await screen.findByTestId('hours-table-table')
    expect(entriesCalls().map(spanOf).at(-1)).toEqual(['2026-11-01', '2026-11-30'])
  })

  it('a month switch while the one before is still being read drops the late answer: the skeleton, then only the new month’s figures', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    useApi({
      'GET /time-entries': async (url, init, params) => {
        if (url.searchParams.get('from') === '2026-11-01') await gate
        return entriesInRange(ENTRIES)(url, init, params)
      },
    })
    await renderPage('/hours?view=month')
    await screen.findByTestId('hours-table-skeleton')

    await userEvent.click(button(nav('month').previous))
    await screen.findByTestId('hours-table-table')
    expect(heading().textContent).toBe('October 2026')
    release()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(heading().textContent).toBe('October 2026')
    expect(within(rowOf('project:p-alpha')).getAllByRole('cell').at(-1)?.textContent).toBe('3 h 30')
    expect(screen.queryByTestId('hours-table-row-deal:d-brera')).toBeNull()
  })
})

describe('the live region of the month (design S7 "Announcements")', () => {
  it('says the month and its total, politely, once it has arrived', async () => {
    useApi()
    await renderPage('/hours?view=month')
    await screen.findByTestId('hours-table-table')
    expect(screen.getByTestId('hours-table-live').textContent).toBe(w.announce('November 2026', '10 hours, 30 minutes'))
  })

  it('an empty month says so, in the month’s words, with the List’s Clear filters under a filter', async () => {
    useApi({ 'GET /time-entries': entriesInRange([]) })
    await renderPage('/hours?view=month')
    await screen.findByTestId('hours-table-empty')
    expect(screen.getByRole('heading', { level: 4 }).textContent).toBe(w.month.empty.title)
    expect(screen.getByTestId('hours-table-live').textContent).toBe(w.announceEmpty('November 2026'))
  })
})

describe('the column does not change from the week to the month and back (AC-5.33, D16)', () => {
  it('stays the tool’s one wide column through the Period switch and the navigator, the page and the shell never remounting', async () => {
    useApi()
    const history = createMemoryHistory({ initialEntries: ['/hours'] })
    const router = createAppRouter('/hours', HoursShell, history)
    render(<RouterProvider router={router} />)
    await screen.findByTestId('hours-my-page')
    await screen.findByTestId('hours-table-table')
    const shell = screen.getByTestId('hours-shell')
    const myPage = screen.getByTestId('hours-my-page')
    const wide = () => screen.getByTestId('hours-shell').classList.contains('tool-width-wide')
    expect(wide()).toBe(true)

    await userEvent.click(radio(w.period.month))
    await waitFor(() => expect(heading().textContent).toBe('November 2026'))
    expect(wide()).toBe(true)
    await userEvent.click(button(nav('month').previous))
    await waitFor(() => expect(heading().textContent).toBe('October 2026'))
    expect(wide()).toBe(true)
    await userEvent.click(radio(w.period.week))
    await waitFor(() => expect(heading().textContent).toContain('05.10.2026'))
    expect(wide()).toBe(true)

    expect(screen.getByTestId('hours-shell')).toBe(shell)
    expect(screen.getByTestId('hours-my-page')).toBe(myPage)
  })
})
