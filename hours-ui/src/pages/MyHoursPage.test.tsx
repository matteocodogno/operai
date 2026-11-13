/**
 * @vitest-environment jsdom
 *
 * My hours, T24's part: the filters and the Totals card (specs/029-time-tracking; AC-4.4, AC-4.5, AC-4.9,
 * AC-3.4, AC-3.8, AC-1.4; design S1, F4 steps 1–2). Rendered through the inner router with a memory history
 * and `fakeApi` behind `apiFetch`, so every assertion about a request is about the query string the real
 * `hoursApi` builds. The entries by day (T25) and the dialogs (T27, T28) are other tasks' tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RouterProvider, createMemoryHistory } from '@tanstack/react-router'

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock('shell/session', async () => (await import('../test-support/fakeSession')).shellSessionMock(apiFetch))

import { createAppRouter } from '../router'
import { strings } from '../strings'
import {
  deferred,
  dealItem,
  fakeApi,
  listsHandler,
  page,
  problem,
  projectItem,
  requests,
  sequence,
  totalsAnswer,
} from '../test-support/fakeApi'
import type { FakeAnswer, FakeHandler } from '../test-support/fakeApi'
import { ORIGINS } from '../test-support/fakeSession'
import { LISTS, MONTH_TOTALS, TODAY_INSTANT, totalsHandler } from '../test-support/fixtures/myHours'

const f = strings.filters
const t = strings.totals

let api: ReturnType<typeof fakeApi>

const useApi = (overrides: Parameters<typeof fakeApi>[0] = {}) => {
  api = fakeApi({ 'GET /time-lists': listsHandler(LISTS), 'GET /time-entries/totals': totalsHandler, ...overrides })
  apiFetch.mockImplementation(api)
}

const renderPage = async (path = '/hours') => {
  const history = createMemoryHistory({ initialEntries: [path] })
  const router = createAppRouter('/hours', undefined, history)
  render(<RouterProvider router={router} />)
  await screen.findByTestId('hours-my-page')
  return router
}

const entriesCalls = () => requests(api, 'GET /time-entries')
const totalsCalls = (groupBy?: string) =>
  requests(api, 'GET /time-entries/totals').filter(
    (request) => groupBy === undefined || request.query['groupBy'] === groupBy,
  )
const urlOf = (router: Awaited<ReturnType<typeof renderPage>>) =>
  Object.fromEntries(new URLSearchParams(router.state.location.searchStr))

/** "Clear filters" of the Filters card: with the entries empty, the Entries card offers one too (T25). */
const clearButton = () => within(screen.getByTestId('hours-filters')).queryByRole('button', { name: f.clear })

const select = (name: string) => screen.getByRole('combobox', { name }) as HTMLSelectElement
const choose = (name: string, value: string) => userEvent.selectOptions(select(name), value)

/** The three reads a filter change makes, for the range and filters the last of each carries. */
const lastReads = () => ({
  entries: entriesCalls().at(-1)?.query,
  totals: totalsCalls('project').at(-1)?.query,
  days: totalsCalls('day').at(-1)?.query,
})

const THIS_MONTH = { whose: 'mine', from: '2026-11-01', to: '2026-11-30' }

beforeEach(() => {
  apiFetch.mockReset()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(TODAY_INSTANT))
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('the page', () => {
  it('has the page heading, one h2, and says overlapping work counts in full (AC-1.4)', async () => {
    useApi()
    await renderPage()
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe(strings.myHours.heading)
    expect(screen.getByText(strings.myHours.description)).not.toBeNull()
    expect(strings.myHours.description).toMatch(/counts in full on each/)
    expect(screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent)).toEqual([
      f.title,
      t.title,
      strings.entries.title,
    ])
  })
})

describe('what a first visit asks (AC-4.4, AC-4.5)', () => {
  it('reads the lists once, retired ones included, and the entries, the totals by project and the day totals for This month', async () => {
    useApi()
    await renderPage()
    await screen.findByText('Project Beta')

    const lists = requests(api, 'GET /time-lists')
    expect(lists).toHaveLength(1)
    expect(lists[0]).toMatchObject({ origin: ORIGINS.hours, query: { includeRetired: 'true' } })

    expect(entriesCalls()).toHaveLength(1)
    expect(entriesCalls()[0]).toMatchObject({ origin: ORIGINS.hours, query: THIS_MONTH })
    expect(totalsCalls()).toHaveLength(2)
    expect(lastReads().totals).toEqual({ groupBy: 'project', ...THIS_MONTH })
    expect(lastReads().days).toEqual({ groupBy: 'day', ...THIS_MONTH })
  })

  it('asks for the person’s own hours only: whose=mine on every call, and no userId', async () => {
    useApi()
    await renderPage()
    await screen.findByText('Project Beta')
    for (const request of [...entriesCalls(), ...totalsCalls()]) {
      expect(request.query['whose']).toBe('mine')
      expect(request.query).not.toHaveProperty('userId')
    }
  })

  it('takes "today" from the Zurich calendar, not from UTC: 23:30 UTC on 30 November is already 1 December there', async () => {
    vi.setSystemTime(new Date('2026-11-30T23:30:00.000Z'))
    useApi()
    await renderPage()
    await screen.findByText('Project Beta')
    expect(entriesCalls()[0]!.query).toMatchObject({ from: '2026-12-01', to: '2026-12-31' })
    expect(select(f.period.label).value).toBe('thisMonth')
  })

  it('shows the total and the groups of the server’s answer, as hours and minutes (AC-4.9)', async () => {
    useApi()
    await renderPage()
    const total = await screen.findByTestId('hours-totals-total')
    expect(within(total).getByText('137 h')).not.toBeNull()
    const table = screen.getByRole('table', { name: t.caption.project })
    expect(within(table).getByText('Projects not visible to you')).not.toBeNull()
    expect(within(table).getByText('2 h 30')).not.toBeNull()
  })
})

describe('Period (AC-4.4)', () => {
  it('a preset re-asks the three reads for its range and goes in the URL; This month, the default, leaves it', async () => {
    useApi()
    const router = await renderPage()
    await screen.findByText('Project Beta')

    await choose(f.period.label, 'lastWeek')

    await waitFor(() => expect(lastReads().entries).toMatchObject({ from: '2026-11-02', to: '2026-11-08' }))
    expect(lastReads().totals).toMatchObject({ from: '2026-11-02', to: '2026-11-08' })
    expect(lastReads().days).toMatchObject({ from: '2026-11-02', to: '2026-11-08' })
    expect(urlOf(router)).toEqual({ period: 'lastWeek' })

    await choose(f.period.label, 'thisMonth')

    await waitFor(() => expect(lastReads().entries).toMatchObject({ from: '2026-11-01', to: '2026-11-30' }))
    expect(urlOf(router)).toEqual({})
  })

  it('This year is 1 January to 31 December', async () => {
    useApi()
    await renderPage()
    await choose(f.period.label, 'thisYear')
    await waitFor(() => expect(lastReads().entries).toMatchObject({ from: '2026-01-01', to: '2026-12-31' }))
  })

  it('Custom opens on the range the person was looking at, and a valid one is asked for as typed', async () => {
    useApi()
    const router = await renderPage()
    await screen.findByText('Project Beta')

    await choose(f.period.label, 'custom')

    expect((screen.getByLabelText(f.from) as HTMLInputElement).value).toBe('2026-11-01')
    expect((screen.getByLabelText(f.to) as HTMLInputElement).value).toBe('2026-11-30')
    expect(urlOf(router)).toEqual({ period: 'custom', from: '2026-11-01', to: '2026-11-30' })

    fireEvent.change(screen.getByLabelText(f.from), { target: { value: '2026-10-05' } })
    fireEvent.change(screen.getByLabelText(f.to), { target: { value: '2026-10-09' } })

    await waitFor(() => expect(lastReads().entries).toMatchObject({ from: '2026-10-05', to: '2026-10-09' }))
    expect(lastReads().totals).toMatchObject({ from: '2026-10-05', to: '2026-10-09' })
    expect(lastReads().days).toMatchObject({ from: '2026-10-05', to: '2026-10-09' })
    expect(urlOf(router)).toEqual({ period: 'custom', from: '2026-10-05', to: '2026-10-09' })
  })

  it('To before From shows a field error and sends nothing until it is fixed', async () => {
    useApi()
    await renderPage()
    await screen.findByText('Project Beta')
    await choose(f.period.label, 'custom')
    const asked = () => [entriesCalls().length, totalsCalls().length]
    const before = asked()

    fireEvent.change(screen.getByLabelText(f.to), { target: { value: '2026-10-31' } })

    expect(await screen.findByText(f.rangeErrors.toBeforeFrom)).not.toBeNull()
    expect(screen.getByText(t.invalidPeriod)).not.toBeNull()
    expect(screen.queryByRole('table')).toBeNull()
    expect(asked()).toEqual(before)

    fireEvent.change(screen.getByLabelText(f.to), { target: { value: '2026-11-20' } })

    await waitFor(() => expect(lastReads().entries).toMatchObject({ from: '2026-11-01', to: '2026-11-20' }))
    expect(screen.queryByText(f.rangeErrors.toBeforeFrom)).toBeNull()
    await screen.findByText('Project Beta')
  })

  it('a range over 366 days shows a field error and sends nothing', async () => {
    useApi()
    await renderPage()
    await choose(f.period.label, 'custom')
    const before = [entriesCalls().length, totalsCalls().length]

    fireEvent.change(screen.getByLabelText(f.from), { target: { value: '2025-01-01' } })

    expect(await screen.findByText(f.rangeErrors.tooLong)).not.toBeNull()
    expect([entriesCalls().length, totalsCalls().length]).toEqual(before)
  })

  it('exactly 366 days is allowed', async () => {
    useApi()
    await renderPage()
    await choose(f.period.label, 'custom')
    fireEvent.change(screen.getByLabelText(f.from), { target: { value: '2025-11-30' } })
    await waitFor(() => expect(lastReads().entries).toMatchObject({ from: '2025-11-30', to: '2026-11-30' }))
    expect(screen.queryByText(f.rangeErrors.tooLong)).toBeNull()
  })

  it('a Custom link with no dates asks nothing and says why', async () => {
    useApi()
    await renderPage('/hours?period=custom')
    expect(screen.getByText(t.invalidPeriod)).not.toBeNull()
    expect(entriesCalls()).toHaveLength(0)
    expect(totalsCalls()).toHaveLength(0)
  })
})

describe('the URL carries the filters (design § Frame of hours-ui)', () => {
  it('reads period, dates and Group by from the link and asks for exactly that', async () => {
    useApi()
    await renderPage('/hours?period=custom&from=2026-10-05&to=2026-10-09&group=month')

    await screen.findByRole('table', { name: t.caption.month })
    const range = { whose: 'mine', from: '2026-10-05', to: '2026-10-09' }
    expect(entriesCalls()[0]!.query).toEqual(range)
    expect(totalsCalls('month')[0]!.query).toEqual({ groupBy: 'month', ...range })
    expect(totalsCalls('day')[0]!.query).toEqual({ groupBy: 'day', ...range })
    expect(select(t.groupBy.label).value).toBe('month')
    expect(select(f.period.label).value).toBe('custom')
    expect((screen.getByLabelText(f.from) as HTMLInputElement).value).toBe('2026-10-05')
  })

  it('a link with a category and a work type asks for them from the first request, once the lists have arrived', async () => {
    useApi()
    await renderPage('/hours?category=tc-formazione&workType=wt-d-demo')

    await waitFor(() => expect(entriesCalls().length).toBeGreaterThan(0))
    await screen.findByText('Project Beta')
    // Never a first, unfiltered request that the filtered one then replaces.
    for (const request of [...entriesCalls(), ...totalsCalls()]) {
      expect(request.query).toMatchObject({ categoryId: 'tc-formazione', workTypeId: 'wt-d-demo' })
    }
    expect(select(f.category.label).value).toBe('tc-formazione')
    expect(select(f.workType.label).value).toBe('wt-d-demo')
  })

  it('a category the lists do not hold is not applied and not shown as applied (garbage in a link)', async () => {
    useApi()
    await renderPage('/hours?category=nope&workType=gone')
    await screen.findByText('Project Beta')
    for (const request of [...entriesCalls(), ...totalsCalls()]) {
      expect(request.query).not.toHaveProperty('categoryId')
      expect(request.query).not.toHaveProperty('workTypeId')
    }
    expect(select(f.category.label).value).toBe('')
    expect(screen.queryByRole('button', { name: f.clear })).toBeNull()
  })

  it('an unknown period or Group by in the link is the default', async () => {
    useApi()
    await renderPage('/hours?period=forever&group=person')
    await screen.findByText('Project Beta')
    expect(entriesCalls()[0]!.query).toMatchObject({ from: '2026-11-01', to: '2026-11-30' })
    expect(totalsCalls('project')).toHaveLength(1)
  })
})

describe('every change re-asks the list, the chosen totals and the day totals with the same filters (AC-4.4)', () => {
  it('Category', async () => {
    useApi()
    const router = await renderPage()
    await screen.findByText('Project Beta')
    await waitFor(() => expect(select(f.category.label).options.length).toBeGreaterThan(1))

    await choose(f.category.label, 'tc-formazione')

    await waitFor(() => expect(lastReads().entries).toMatchObject({ ...THIS_MONTH, categoryId: 'tc-formazione' }))
    expect(lastReads().totals).toMatchObject({ ...THIS_MONTH, categoryId: 'tc-formazione' })
    expect(lastReads().days).toMatchObject({ ...THIS_MONTH, categoryId: 'tc-formazione' })
    expect(urlOf(router)).toEqual({ category: 'tc-formazione' })
  })

  it('Work type (either list, by id)', async () => {
    useApi()
    const router = await renderPage()
    await waitFor(() => expect(select(f.workType.label).options.length).toBeGreaterThan(1))

    await choose(f.workType.label, 'wt-p-analysis')

    await waitFor(() => expect(lastReads().entries).toMatchObject({ workTypeId: 'wt-p-analysis' }))
    expect(lastReads().totals).toMatchObject({ workTypeId: 'wt-p-analysis' })
    expect(lastReads().days).toMatchObject({ workTypeId: 'wt-p-analysis' })
    expect(urlOf(router)).toEqual({ workType: 'wt-p-analysis' })
  })

  it('Project: the pick is asked by id and is NOT in the URL (a pick needs its label)', async () => {
    useApi({ 'GET /projects': () => ({ status: 200, body: page([projectItem({ id: 'p1', name: 'Project Alpha' })]) }) })
    const router = await renderPage()
    await screen.findByText('Project Beta')

    await userEvent.type(screen.getByRole('combobox', { name: f.project.label }), 'alp')
    await userEvent.click(await screen.findByRole('option', { name: /Project Alpha/ }))

    await waitFor(() => expect(lastReads().entries).toMatchObject({ ...THIS_MONTH, projectId: 'p1' }))
    expect(lastReads().totals).toMatchObject({ projectId: 'p1' })
    expect(lastReads().days).toMatchObject({ projectId: 'p1' })
    expect(urlOf(router)).toEqual({})
    expect((screen.getByRole('combobox', { name: f.project.label }) as HTMLInputElement).value).toBe('Project Alpha')
  })

  it('Deal, together with a project: both narrow the same reads', async () => {
    useApi({
      'GET /projects': () => ({ status: 200, body: page([projectItem({ id: 'p1', name: 'Project Alpha' })]) }),
      'GET /deals': () => ({ status: 200, body: page([dealItem({ id: 'd1', title: 'Acme renewal' })]) }),
    })
    await renderPage()
    await screen.findByText('Project Beta')

    await userEvent.type(screen.getByRole('combobox', { name: f.project.label }), 'a')
    await userEvent.click(await screen.findByRole('option', { name: /Project Alpha/ }))
    await userEvent.type(screen.getByRole('combobox', { name: f.deal.label }), 'a')
    await userEvent.click(await screen.findByRole('option', { name: /Acme renewal/ }))

    await waitFor(() => expect(lastReads().entries).toMatchObject({ projectId: 'p1', dealId: 'd1' }))
    expect(lastReads().totals).toMatchObject({ projectId: 'p1', dealId: 'd1' })
    expect(lastReads().days).toMatchObject({ projectId: 'p1', dealId: 'd1' })
  })

  it('Group by re-asks only the chosen totals: the entries and the day totals do not depend on it', async () => {
    useApi()
    const router = await renderPage()
    await screen.findByText('Project Beta')
    const entries = entriesCalls().length
    const days = totalsCalls('day').length

    await choose(t.groupBy.label, 'month')

    await screen.findByRole('table', { name: t.caption.month })
    expect(totalsCalls('month')).toHaveLength(1)
    expect(totalsCalls('month')[0]!.query).toEqual({ groupBy: 'month', ...THIS_MONTH })
    expect(entriesCalls()).toHaveLength(entries)
    expect(totalsCalls('day')).toHaveLength(days)
    expect(urlOf(router)).toEqual({ group: 'month' })
  })

  it('the lists are not read again by a filter change', async () => {
    useApi()
    await renderPage()
    await waitFor(() => expect(select(f.category.label).options.length).toBeGreaterThan(1))
    await choose(f.category.label, 'tc-admin')
    await choose(f.period.label, 'lastMonth')
    expect(requests(api, 'GET /time-lists')).toHaveLength(1)
  })
})

describe('Clear filters', () => {
  it('is offered only once something differs from the defaults, and puts everything back (Group by stays)', async () => {
    useApi({ 'GET /projects': () => ({ status: 200, body: page([projectItem({ id: 'p1', name: 'Project Alpha' })]) }) })
    const router = await renderPage('/hours?group=month')
    await screen.findByRole('table', { name: t.caption.month })
    expect(clearButton()).toBeNull()

    await choose(f.period.label, 'lastMonth')
    await userEvent.type(screen.getByRole('combobox', { name: f.project.label }), 'alp')
    await userEvent.click(await screen.findByRole('option', { name: /Project Alpha/ }))
    await userEvent.type(screen.getByRole('combobox', { name: f.deal.label }), 'half-typed')
    await waitFor(() => expect(lastReads().entries).toMatchObject({ from: '2026-10-01', projectId: 'p1' }))

    await userEvent.click(clearButton()!)

    await waitFor(() => expect(entriesCalls().at(-1)!.query).toEqual(THIS_MONTH))
    expect(urlOf(router)).toEqual({ group: 'month' })
    expect((screen.getByRole('combobox', { name: f.project.label }) as HTMLInputElement).value).toBe('')
    expect((screen.getByRole('combobox', { name: f.deal.label }) as HTMLInputElement).value).toBe('')
    expect(select(f.period.label).value).toBe('thisMonth')
    expect(select(t.groupBy.label).value).toBe('month')
    expect(clearButton()).toBeNull()
  })
})

describe('stale answers are discarded', () => {
  it('a totals answer that arrives after the filters changed never replaces the newer one', async () => {
    const slow = deferred<FakeAnswer>()
    let projectAsks = 0
    useApi({
      'GET /time-entries/totals': (url, init, params) => {
        if (url.searchParams.get('groupBy') !== 'project') return totalsHandler(url, init, params)
        projectAsks += 1
        return projectAsks === 1
          ? slow.promise
          : {
              status: 200,
              body: totalsAnswer([{ kind: 'keyed', key: 'p-alpha', label: 'Project Alpha', minutes: 600 }]),
            }
      },
    })
    await renderPage()
    await waitFor(() => expect(select(f.category.label).options.length).toBeGreaterThan(1))

    await choose(f.category.label, 'tc-formazione')
    expect(await screen.findByText('Project Alpha')).not.toBeNull()
    expect(within(screen.getByTestId('hours-totals-total')).getByText('10 h')).not.toBeNull()

    // The answer for the first filters lands now, late: it is for a view that is no longer asked.
    slow.resolve(totalsHandler(new URL('http://x/?groupBy=project'), undefined, {}) as FakeAnswer)
    await slow.promise
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(screen.queryByText('Project Beta')).toBeNull()
    expect(within(screen.getByTestId('hours-totals-total')).getByText('10 h')).not.toBeNull()
  })

  it('while the new filters load, the previous answer is not shown under them', async () => {
    const slow = deferred<FakeAnswer>()
    let projectAsks = 0
    useApi({
      'GET /time-entries/totals': (url, init, params) => {
        if (url.searchParams.get('groupBy') !== 'project') return totalsHandler(url, init, params)
        projectAsks += 1
        return projectAsks === 1 ? totalsHandler(url, init, params) : slow.promise
      },
    })
    await renderPage()
    await screen.findByText('Project Beta')
    await waitFor(() => expect(select(f.category.label).options.length).toBeGreaterThan(1))

    await choose(f.category.label, 'tc-formazione')

    expect(screen.getByText(t.loading)).not.toBeNull()
    expect(screen.queryByText('Project Beta')).toBeNull()
    expect(screen.queryByTestId('hours-totals-total')).toBeNull()
  })
})

describe('the Totals card in its states', () => {
  it('a failed totals call is a warning with Retry inside the card, asks again, and the rest of the page is unaffected', async () => {
    // The first ask for the totals BY PROJECT fails, the next works; the day totals are a different ask.
    const byProject = sequence(() => ({ status: 500, body: problem(500) }), totalsHandler)
    useApi({
      'GET /time-entries/totals': (url, init, params) =>
        url.searchParams.get('groupBy') === 'project' ? byProject(url, init, params) : totalsHandler(url, init, params),
    })
    await renderPage()

    const card = await screen.findByTestId('hours-totals')
    const alert = await within(card).findByRole('alert')
    expect(alert.textContent).toContain(t.error.title)
    expect(alert.textContent).toContain(t.error.body)
    expect(screen.queryByText('0 min')).toBeNull()
    expect(entriesCalls()).toHaveLength(1)

    await userEvent.click(within(alert).getByRole('button', { name: strings.common.retry }))

    expect(await screen.findByText('Project Beta')).not.toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('a network failure says the server could not be reached', async () => {
    useApi()
    const reachable = apiFetch.getMockImplementation()!
    apiFetch.mockImplementation((input: RequestInfo | URL, init?: RequestInit) =>
      String(input).includes('/time-entries/totals')
        ? Promise.reject(new TypeError('Failed to fetch'))
        : reachable(input, init),
    )
    await renderPage()
    const alert = await within(await screen.findByTestId('hours-totals')).findByRole('alert')
    expect(alert.textContent).toContain(strings.common.networkError)
  })

  it('under a deal filter a refused totals read is the one AC-4.11 alert, never "0 min" or "Nothing to total." (the state itself: MyHoursPage.entries.test.tsx)', async () => {
    useApi({
      'GET /deals': () => ({ status: 200, body: page([dealItem({ id: 'd1', title: 'Acme renewal' })]) }),
    })
    await renderPage()
    await screen.findByText('Project Beta')
    useApi({
      'GET /deals': () => ({ status: 200, body: page([dealItem({ id: 'd1', title: 'Acme renewal' })]) }),
      'GET /time-entries/totals': (url, init, params) =>
        url.searchParams.get('dealId') !== null
          ? { status: 503, body: problem(503, 'host_unavailable') }
          : totalsHandler(url, init, params),
    })

    await userEvent.type(screen.getByRole('combobox', { name: f.deal.label }), 'a')
    await userEvent.click(await screen.findByRole('option', { name: /Acme renewal/ }))

    const alert = await screen.findByTestId('hours-deal-filter-unavailable')
    expect(alert.textContent).toContain(strings.entries.dealFilterUnavailable.title)
    expect(screen.queryByTestId('hours-totals')).toBeNull()
    expect(screen.queryByText('0 min')).toBeNull()
    expect(screen.queryByText(t.empty)).toBeNull()
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('nothing matched is "0 min" and "Nothing to total."', async () => {
    useApi({ 'GET /time-entries/totals': () => ({ status: 200, body: totalsAnswer([]) }) })
    await renderPage()
    expect(await screen.findByText(t.empty)).not.toBeNull()
    expect(within(screen.getByTestId('hours-totals-total')).getByText('0 min')).not.toBeNull()
  })

  it('announces the total politely when it arrives, and never moves focus', async () => {
    useApi()
    await renderPage()
    await screen.findByText('Project Beta')
    expect(screen.getByTestId('hours-totals-live').textContent).toContain('in total')
    expect(document.activeElement).toBe(document.body)
  })

  it('months are written in the language of the page and keep the server’s order', async () => {
    useApi({ 'GET /time-entries/totals': (url, init, params) => totalsHandler(url, init, params) })
    await renderPage('/hours?group=month')
    const table = await screen.findByRole('table', { name: t.caption.month })
    expect(
      within(table)
        .getAllByRole('row')
        .slice(1)
        .map((row) => row.textContent),
    ).toEqual(['November 202660 h', 'September 202677 h'])
    expect(MONTH_TOTALS.groups).toHaveLength(2)
  })
})

describe('the lists the filters need', () => {
  it('while they load the Category and Work type selects say so and do nothing; the page does not wait for them', async () => {
    const lists = deferred<FakeAnswer>()
    useApi({ 'GET /time-lists': () => lists.promise })
    await renderPage()

    expect(select(f.category.label).getAttribute('aria-disabled')).toBe('true')
    expect(
      within(select(f.category.label))
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual([f.listsLoading])
    // The period, project, deal and the totals are not held up.
    expect(await screen.findByText('Project Beta')).not.toBeNull()

    lists.resolve({ status: 200, body: LISTS })
    await waitFor(() => expect(select(f.category.label).getAttribute('aria-disabled')).toBeNull())
    expect(within(select(f.category.label)).getByRole('option', { name: 'Formazione' })).not.toBeNull()
  })

  it('when they fail the card says so with Retry; a link’s category is not applied meanwhile; a retry that works applies it', async () => {
    useApi({
      'GET /time-lists': sequence(() => ({ status: 500, body: problem(500) }), listsHandler(LISTS)) as FakeHandler,
    })
    await renderPage('/hours?category=tc-formazione')

    const banner = await screen.findByTestId('hours-filters-lists-error')
    // The page still shows the hours, unfiltered by what it could not check.
    await screen.findByText('Project Beta')
    expect(entriesCalls()[0]!.query).not.toHaveProperty('categoryId')

    await userEvent.click(within(banner).getByRole('button', { name: strings.common.retry }))

    await waitFor(() => expect(entriesCalls().at(-1)!.query).toMatchObject({ categoryId: 'tc-formazione' }))
    expect(screen.queryByTestId('hours-filters-lists-error')).toBeNull()
    expect(requests(api, 'GET /time-lists')).toHaveLength(2)
  })

  it('names are shown exactly as typed, a retired category is marked (AC-3.8, AC-3.4)', async () => {
    useApi()
    await renderPage()
    await waitFor(() => expect(select(f.category.label).options.length).toBeGreaterThan(1))
    expect(
      within(select(f.category.label))
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['All categories', 'Formazione', 'Administration', 'Seminars (retired)'])
  })
})
