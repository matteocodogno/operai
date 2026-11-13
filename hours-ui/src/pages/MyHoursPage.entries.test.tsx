/**
 * @vitest-environment jsdom
 *
 * My hours, T25's part: the entries by day with the server's day totals, Load more, the source and
 * visibility banners, and the deal-filter-unavailable state (specs/029-time-tracking; AC-4.1, AC-2.6, AC-2.9,
 * AC-4.7, AC-4.8, AC-4.9, AC-4.10, AC-4.11, D48; design S1, F4). Rendered through the inner router with
 * `fakeApi` behind `apiFetch`, so a request assertion is about the query the real `hoursApi` builds. The
 * filters and the Totals card are T24's tests; the dialogs are T27's and T28's.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RouterProvider, createMemoryHistory } from '@tanstack/react-router'

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock('shell/session', async () => (await import('../test-support/fakeSession')).shellSessionMock(apiFetch))

import { createAppRouter } from '../router'
import { strings } from '../strings'
import {
  dealItem,
  deferred,
  entriesPage,
  fakeApi,
  listsHandler,
  page,
  problem,
  projectOn,
  requests,
  sequence,
  timeEntryView,
  totalsAnswer,
} from '../test-support/fakeApi'
import type { FakeAnswer, FakeHandler } from '../test-support/fakeApi'
import {
  ALPHA,
  CURSOR,
  ENTRY_DAY_TOTALS,
  KICKOFF,
  PAGE_ONE,
  PAGE_TWO,
  TRAINING,
  entriesHandler,
  totalsWithDays,
} from '../test-support/fixtures/entries'
import { LISTS, PROJECT_TOTALS, TODAY_INSTANT } from '../test-support/fixtures/myHours'

const f = strings.filters
const t = strings.totals
const e = strings.entries
const n = strings.names

let api: ReturnType<typeof fakeApi>

/** The row of an entry (`hours-entry-<id>`), not the Edit and Delete buttons inside it (`hours-entry-<id>-edit`). */
const ROW_TEST_ID = /^hours-entry-(?!.*-(?:edit|delete)$)/

const useApi = (overrides: Parameters<typeof fakeApi>[0] = {}) => {
  api = fakeApi({
    'GET /time-lists': listsHandler(LISTS),
    'GET /time-entries': entriesHandler,
    'GET /time-entries/totals': totalsWithDays,
    'GET /deals': () => ({ status: 200, body: page([dealItem({ id: 'd1', title: 'Acme renewal' })]) }),
    ...overrides,
  })
  apiFetch.mockImplementation(api)
}

const renderPage = async (path = '/hours') => {
  const history = createMemoryHistory({ initialEntries: [path] })
  render(<RouterProvider router={createAppRouter('/hours', undefined, history)} />)
  await screen.findByTestId('hours-my-page')
}

const entriesCalls = () => requests(api, 'GET /time-entries')
const totalsCalls = (groupBy?: string) =>
  requests(api, 'GET /time-entries/totals').filter(
    (request) => groupBy === undefined || request.query['groupBy'] === groupBy,
  )

const day = (key: string) => screen.getByTestId(`hours-day-${key}`)
const loadMoreButton = () => screen.getByRole('button', { name: e.loadMore })
const dealInput = () => screen.getByRole('combobox', { name: f.deal.label })

/** Picks the deal "Acme renewal" in the Deal filter, as a person would. */
const pickDeal = async () => {
  await userEvent.type(dealInput(), 'a')
  await userEvent.click(await screen.findByRole('option', { name: /Acme renewal/ }))
}

const refused = (): FakeAnswer => ({ status: 503, body: problem(503, 'host_unavailable') })

/** A handler that refuses (503 `host_unavailable`) any ask that carries a `dealId`, else answers with `otherwise`. */
const refusingUnderDeal =
  (otherwise: FakeHandler): FakeHandler =>
  (url, init, params) =>
    url.searchParams.has('dealId') ? refused() : otherwise(url, init, params)

beforeEach(() => {
  apiFetch.mockReset()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(TODAY_INSTANT))
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('the entries by day (AC-4.1, AC-4.9)', () => {
  it('has an Entries card at the card level, after Filters and Totals', async () => {
    useApi()
    await renderPage()
    await screen.findByTestId('hours-day-list')
    expect(screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent)).toEqual([
      f.title,
      t.title,
      e.title,
    ])
  })

  it('lists one section per day, newest first as the server sent them, with the server’s day total beside each', async () => {
    useApi()
    await renderPage()
    const first = await screen.findByTestId('hours-day-2026-11-12')

    expect(within(first).getByRole('heading', { level: 4 }).textContent).toBe('12 November 2026')
    expect(within(first).getAllByRole('listitem')).toHaveLength(2)
    expect(within(screen.getByTestId('hours-day-total-2026-11-12')).getByText('8 h 30')).not.toBeNull()
  })

  it('asks the entries with the page’s filters and no page size of its own, and the day totals with the same filters', async () => {
    useApi()
    await renderPage()
    await screen.findByTestId('hours-day-list')

    expect(entriesCalls()).toHaveLength(1)
    expect(entriesCalls()[0]!.query).toEqual({ whose: 'mine', from: '2026-11-01', to: '2026-11-30' })
    expect(totalsCalls('day')[0]!.query).toEqual({
      groupBy: 'day',
      whose: 'mine',
      from: '2026-11-01',
      to: '2026-11-30',
    })
  })

  it('a day split across two list pages shows its FULL total before Load more, though only two of its three rows are here (AC-4.1)', async () => {
    useApi()
    await renderPage()
    const first = await screen.findByTestId('hours-day-2026-11-12')

    expect(within(first).getAllByRole('listitem')).toHaveLength(2)
    // 4 h + 2 h are on screen; the server's figure for the day is 8 h 30 — and nothing else is offered as the total.
    expect(within(screen.getByTestId('hours-day-total-2026-11-12')).getByText('8 h 30')).not.toBeNull()
    expect(within(first).queryByText('6 h')).toBeNull()
    expect(loadMoreButton()).not.toBeNull()
  })

  it('a day whose total has not arrived shows no figure, and shows it when the answer comes', async () => {
    const slow = deferred<FakeAnswer>()
    useApi({
      'GET /time-entries/totals': (url, init, params) =>
        url.searchParams.get('groupBy') === 'day' ? slow.promise : totalsWithDays(url, init, params),
    })
    await renderPage()
    await screen.findByTestId('hours-day-2026-11-12')

    expect(screen.queryByText(e.dayTotal)).toBeNull()
    expect(screen.queryByTestId('hours-day-total-2026-11-12')).toBeNull()
    expect(screen.queryByText('0 min')).toBeNull()

    slow.resolve({ status: 200, body: ENTRY_DAY_TOTALS })

    expect(await screen.findByTestId('hours-day-total-2026-11-12')).not.toBeNull()
  })

  it('a day the answer does not hold shows no figure for that day only', async () => {
    useApi({
      'GET /time-entries': () => ({ status: 200, body: entriesPage([ALPHA, TRAINING]) }),
      'GET /time-entries/totals': (url, init, params) =>
        url.searchParams.get('groupBy') === 'day'
          ? { status: 200, body: totalsAnswer([{ kind: 'keyed', key: '2026-11-10', label: null, minutes: 240 }]) }
          : totalsWithDays(url, init, params),
    })
    await renderPage()
    await screen.findByTestId('hours-day-2026-11-10')
    expect(screen.queryByTestId('hours-day-total-2026-11-12')).toBeNull()
    expect(screen.getByTestId('hours-day-total-2026-11-10')).not.toBeNull()
  })

  it('marks no day as incomplete, and makes no call to anything that notifies (AC-4.1, D23)', async () => {
    useApi({
      // A 24 h day: far over a working day, and still just a day.
      'GET /time-entries/totals': (url, init, params) =>
        url.searchParams.get('groupBy') === 'day'
          ? { status: 200, body: totalsAnswer([{ kind: 'keyed', key: '2026-11-12', label: null, minutes: 1440 }]) }
          : totalsWithDays(url, init, params),
    })
    await renderPage()
    await screen.findByTestId('hours-day-total-2026-11-12')

    expect(within(screen.getByTestId('hours-entries')).queryByText(/incomplete|remind|missing hours/i)).toBeNull()
    // Reading the page asks hours-api for the lists, the entries and the totals — and nothing else: a day
    // over a working day is no event, so nothing is written and nothing is raised.
    expect(requests(api).every((request) => request.method === 'GET')).toBe(true)
    expect([...new Set(requests(api).map((request) => request.path))].sort()).toEqual([
      '/time-entries',
      '/time-entries/totals',
      '/time-lists',
    ])
  })

  it('shows the entry rows: type, name as a link, duration, details, the deal a meeting counts for, the note (AC-2.6)', async () => {
    useApi()
    await renderPage()
    await screen.findByTestId('hours-day-list')
    await userEvent.click(loadMoreButton())
    await screen.findByTestId('hours-entry-e-kickoff')

    const kickoff = screen.getByTestId('hours-entry-e-kickoff')
    expect(within(kickoff).getByText(e.type.meeting)).not.toBeNull()
    expect(within(kickoff).getByRole('link', { name: 'Kick-off call' }).getAttribute('href')).toBe('/my-meetings/m/m1')
    expect(within(kickoff).getByText('2 h 30')).not.toBeNull()
    expect(within(kickoff).getByText('Counts for deal Acme renewal')).not.toBeNull()
    expect(within(kickoff).getByText('Walked through the scope')).not.toBeNull()
  })

  it('offers Edit and Delete on every row, now that their dialogs exist (T28): each button names its entry', async () => {
    useApi()
    await renderPage()
    await screen.findByTestId('hours-day-list')
    const rows = PAGE_ONE.items.length
    expect(screen.getAllByRole('button', { name: /^Edit / })).toHaveLength(rows)
    expect(screen.getAllByRole('button', { name: /^Delete / })).toHaveLength(rows)
  })
})

describe('Load more (D48)', () => {
  it('asks the next page with the cursor and the same filters, appends it, and merges a day that continues', async () => {
    useApi()
    await renderPage()
    await screen.findByTestId('hours-day-list')

    await userEvent.click(loadMoreButton())

    await waitFor(() => expect(within(day('2026-11-12')).getAllByRole('listitem')).toHaveLength(3))
    expect(entriesCalls()).toHaveLength(2)
    expect(entriesCalls()[1]!.query).toEqual({
      whose: 'mine',
      from: '2026-11-01',
      to: '2026-11-30',
      cursor: CURSOR,
    })
    expect(within(day('2026-11-10')).getAllByRole('listitem')).toHaveLength(2)
    // The day total did not move, and the totals were not asked again.
    expect(within(screen.getByTestId('hours-day-total-2026-11-12')).getByText('8 h 30')).not.toBeNull()
    expect(totalsCalls('day')).toHaveLength(1)
    // The first page's rows are still there, before the new ones.
    const ids = within(screen.getByTestId('hours-day-list'))
      .getAllByTestId(ROW_TEST_ID)
      .map((row) => row.getAttribute('data-testid'))
    expect(ids).toEqual(
      [...PAGE_ONE.items, ...PAGE_TWO.items.filter((item) => item.day === '2026-11-12')]
        .concat(PAGE_TWO.items.filter((item) => item.day !== '2026-11-12'))
        .map((item) => `hours-entry-${item.id}`),
    )
  })

  it('has no button once the last page is in, and says politely how many arrived', async () => {
    useApi()
    await renderPage()
    await screen.findByTestId('hours-day-list')

    await userEvent.click(loadMoreButton())

    await screen.findByTestId('hours-entry-e-kickoff')
    expect(screen.queryByRole('button', { name: e.loadMore })).toBeNull()
    const status = within(screen.getByTestId('hours-entries-load-more')).getByRole('status')
    expect(status.textContent).toBe(e.loadedMore(3, 5))
  })

  it('has no Load more at all when the first page is the last', async () => {
    useApi({ 'GET /time-entries': () => ({ status: 200, body: entriesPage([ALPHA]) }) })
    await renderPage()
    await screen.findByTestId('hours-day-list')
    expect(screen.queryByRole('button', { name: e.loadMore })).toBeNull()
  })

  it('a failed Load more keeps the pages already shown, with the error and Retry below them (D48)', async () => {
    useApi({
      'GET /time-entries': sequence(entriesHandler, () => ({ status: 500, body: problem(500) }), entriesHandler),
    })
    await renderPage()
    await screen.findByTestId('hours-day-list')

    await userEvent.click(loadMoreButton())

    const loadMore = screen.getByTestId('hours-entries-load-more')
    expect(await within(loadMore).findByRole('alert')).not.toBeNull()
    expect(within(loadMore).getByRole('alert').textContent).toBe(e.loadMoreError)
    expect(within(day('2026-11-12')).getAllByRole('listitem')).toHaveLength(2)
    // Totals and the rest of the page are as they were.
    expect(screen.getByTestId('hours-totals-table')).not.toBeNull()
    expect(screen.queryByTestId('hours-deal-filter-unavailable')).toBeNull()

    await userEvent.click(loadMoreButton())

    await waitFor(() => expect(within(day('2026-11-12')).getAllByRole('listitem')).toHaveLength(3))
    // Retrying asked the SAME cursor again.
    expect(entriesCalls().map((request) => request.query['cursor'])).toEqual([undefined, CURSOR, CURSOR])
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('while a page is on its way the button is busy and a second click asks nothing', async () => {
    const slow = deferred<FakeAnswer>()
    useApi({
      'GET /time-entries': (url, init, params) =>
        url.searchParams.has('cursor') ? slow.promise : entriesHandler(url, init, params),
    })
    await renderPage()
    await screen.findByTestId('hours-day-list')

    await userEvent.click(loadMoreButton())
    const busy = await screen.findByRole('button', { name: e.loadingMore })
    expect(busy.getAttribute('aria-busy')).toBe('true')
    await userEvent.click(busy)

    expect(entriesCalls()).toHaveLength(2)
    slow.resolve({ status: 200, body: PAGE_TWO })
    await screen.findByTestId('hours-entry-e-kickoff')
  })

  it('a filter change drops the later pages at once and a page that arrives late is never shown under the new filters', async () => {
    const slow = deferred<FakeAnswer>()
    const afterChange = {
      status: 200,
      body: entriesPage([timeEntryView({ id: 'e-new', on: projectOn('p2', 'New project') })]),
    }
    useApi({
      'GET /time-entries': (url, init, params) => {
        if (url.searchParams.has('cursor')) return slow.promise
        return url.searchParams.has('categoryId') ? afterChange : entriesHandler(url, init, params)
      },
    })
    await renderPage()
    await screen.findByTestId('hours-day-list')
    await userEvent.click(loadMoreButton())
    await waitFor(() => expect(entriesCalls()).toHaveLength(2))
    await waitFor(() =>
      expect((screen.getByLabelText(f.category.label) as HTMLSelectElement).options.length).toBeGreaterThan(1),
    )

    await userEvent.selectOptions(screen.getByLabelText(f.category.label), 'tc-formazione')
    await screen.findByTestId('hours-entry-e-new')
    slow.resolve({ status: 200, body: PAGE_TWO })
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(screen.queryByTestId('hours-entry-e-alpha')).toBeNull()
    expect(screen.queryByTestId('hours-entry-e-kickoff')).toBeNull()
    expect(screen.getAllByTestId(ROW_TEST_ID)).toHaveLength(1)
  })
})

describe('the Entries card in its states', () => {
  it('loading: skeleton rows (hidden from assistive technology) and a polite "Loading your hours…"', async () => {
    const slow = deferred<FakeAnswer>()
    useApi({ 'GET /time-entries': () => slow.promise })
    await renderPage()

    const card = screen.getByTestId('hours-entries')
    expect(within(card).getByText(e.loading).closest('[aria-live="polite"]')).not.toBeNull()
    expect(card.querySelector('[aria-hidden="true"].skeleton-rows')).not.toBeNull()
    expect(screen.queryByTestId('hours-day-list')).toBeNull()
    expect(screen.queryByText(e.empty.title)).toBeNull()
    slow.resolve({ status: 200, body: entriesPage([]) })
    await screen.findByText(e.empty.title)
  })

  it('no entries and no filter: "No hours recorded in this period" with no action (the header has it)', async () => {
    useApi({ 'GET /time-entries': () => ({ status: 200, body: entriesPage([]) }) })
    await renderPage()

    const card = screen.getByTestId('hours-entries')
    expect(await within(card).findByText(e.empty.title)).not.toBeNull()
    expect(within(card).getByText(e.empty.body)).not.toBeNull()
    expect(within(card).queryByRole('button')).toBeNull()
  })

  it('no entries under a filter: "No entries match these filters" with Clear filters, which puts the filters back', async () => {
    useApi({
      'GET /time-entries': (url, init, params) =>
        url.searchParams.has('categoryId') ? { status: 200, body: entriesPage([]) } : entriesHandler(url, init, params),
    })
    await renderPage()
    await screen.findByTestId('hours-day-list')
    await waitFor(() =>
      expect((screen.getByLabelText(f.category.label) as HTMLSelectElement).options.length).toBeGreaterThan(1),
    )
    await userEvent.selectOptions(screen.getByLabelText(f.category.label), 'tc-formazione')

    const card = screen.getByTestId('hours-entries')
    expect(await within(card).findByText(e.emptyFiltered.title)).not.toBeNull()
    expect(within(card).queryByText(e.empty.title)).toBeNull()

    await userEvent.click(within(card).getByRole('button', { name: f.clear }))

    expect(await screen.findByTestId('hours-day-list')).not.toBeNull()
    expect(entriesCalls().at(-1)!.query).not.toHaveProperty('categoryId')
  })

  it('a failed read is a warning with Retry; Retry asks again and shows the entries', async () => {
    useApi({ 'GET /time-entries': sequence(() => ({ status: 500, body: problem(500) }), entriesHandler) })
    await renderPage()

    const alert = await within(screen.getByTestId('hours-entries')).findByRole('alert')
    expect(alert.textContent).toContain(e.error.title)
    expect(alert.textContent).toContain(e.error.body)
    expect(screen.queryByText(e.empty.title)).toBeNull()
    // Totals are another read: they still show.
    expect(await screen.findByTestId('hours-totals-table')).not.toBeNull()

    await userEvent.click(within(alert).getByRole('button', { name: strings.common.retry }))

    expect(await screen.findByTestId('hours-day-list')).not.toBeNull()
    expect(screen.queryByText(e.error.title)).toBeNull()
  })

  it('a network failure says the server could not be reached', async () => {
    useApi()
    const reachable = apiFetch.getMockImplementation()!
    apiFetch.mockImplementation((input: RequestInfo | URL, init?: RequestInit) =>
      new URL(String(input)).pathname === '/time-entries'
        ? Promise.reject(new TypeError('Failed to fetch'))
        : reachable(input, init),
    )
    await renderPage()
    const alert = await within(screen.getByTestId('hours-entries')).findByRole('alert')
    expect(alert.textContent).toContain(strings.common.networkError)
  })

  it('a Custom range that cannot be sent asks nothing and says why in the card', async () => {
    useApi()
    await renderPage('/hours?period=custom')
    expect(within(screen.getByTestId('hours-entries')).getByText(e.invalidPeriod)).not.toBeNull()
    expect(entriesCalls()).toHaveLength(0)
  })

  it('failed day totals: a compact warning with Retry at the top of the card; the list stays and the headings show no total', async () => {
    // Every ask for the day totals fails once, then works; the others always work.
    let dayAsks = 0
    useApi({
      'GET /time-entries/totals': (url, init, params) =>
        url.searchParams.get('groupBy') === 'day' && ++dayAsks === 1
          ? { status: 500, body: problem(500) }
          : totalsWithDays(url, init, params),
    })
    await renderPage()

    const warning = await screen.findByTestId('hours-day-totals-error')
    expect(warning.textContent).toContain(e.dayTotalsError)
    expect(within(screen.getByTestId('hours-entries')).getByTestId('hours-day-list')).not.toBeNull()
    expect(within(day('2026-11-12')).getAllByRole('listitem')).toHaveLength(2)
    expect(screen.queryByText(e.dayTotal)).toBeNull()
    // Above the list, not below it.
    const card = screen.getByTestId('hours-entries')
    expect(warning.compareDocumentPosition(within(card).getByTestId('hours-day-list'))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    )

    await userEvent.click(within(warning).getByRole('button', { name: strings.common.retry }))

    expect(await screen.findByTestId('hours-day-total-2026-11-12')).not.toBeNull()
    expect(screen.queryByTestId('hours-day-totals-error')).toBeNull()
    // Only the day totals were asked again.
    expect(entriesCalls()).toHaveLength(1)
  })
})

describe('what the view says about names it could not load or may not show', () => {
  it('a source that did not answer (entries): one polite info banner naming it, and the entry is still listed (AC-4.7)', async () => {
    useApi({
      'GET /time-entries': () => ({
        status: 200,
        body: entriesPage([timeEntryView({ id: 'e-u', on: projectOn('p1', 'x', 'unavailable') })], {
          unavailable: ['projects', 'activities'],
        }),
      }),
    })
    await renderPage()

    const banner = await screen.findByTestId('hours-banner-unavailable')
    expect(banner.getAttribute('role')).toBe('status')
    expect(banner.textContent).toContain(n.sources.projects)
    expect(banner.textContent).toContain(n.sources.activities)
    expect(within(screen.getByTestId('hours-entry-e-u')).getByText(n.unavailable)).not.toBeNull()
  })

  it('a source down for the totals only still names it, merged with the entries’ (each source once)', async () => {
    useApi({
      'GET /time-entries': () => ({ status: 200, body: entriesPage([ALPHA], { unavailable: ['projects'] }) }),
      'GET /time-entries/totals': (url, init, params) =>
        url.searchParams.get('groupBy') === 'project'
          ? { status: 200, body: { ...PROJECT_TOTALS, unavailable: ['projects', 'identities'] } }
          : totalsWithDays(url, init, params),
    })
    await renderPage()

    const banner = await screen.findByTestId('hours-banner-unavailable')
    expect(banner.textContent).toContain(`${n.sources.identities}, ${n.sources.projects}`)
    expect(screen.getAllByTestId('hours-banner-unavailable')).toHaveLength(1)
  })

  it('grouped by deal with the meeting → deal link down: the warning that meeting hours are in one separate row (AC-4.7)', async () => {
    useApi({
      'GET /time-entries/totals': (url, init, params) =>
        url.searchParams.get('groupBy') === 'deal'
          ? {
              status: 200,
              body: { ...totalsAnswer([{ kind: 'deal-unknown', minutes: 150 }]), unavailable: ['meeting-deals'] },
            }
          : totalsWithDays(url, init, params),
    })
    await renderPage('/hours?group=deal')

    const warning = await screen.findByTestId('hours-banner-deal-grouping')
    expect(warning.textContent).toContain(e.banners.dealGrouping)
    expect(warning.getAttribute('role')).toBe('status')
    expect(
      within(screen.getByTestId('hours-banner-unavailable')).getByText(new RegExp(n.sources['meeting-deals'])),
    ).not.toBeNull()
  })

  it('the same source down while grouped by project names the source but has no deal-grouping warning', async () => {
    useApi({
      'GET /time-entries': () => ({
        status: 200,
        body: entriesPage([KICKOFF], { unavailable: ['meeting-deals'] }),
      }),
    })
    await renderPage()
    await screen.findByTestId('hours-banner-unavailable')
    expect(screen.queryByTestId('hours-banner-deal-grouping')).toBeNull()
  })

  it('anything hidden: the standing note, static and named (AC-4.10)', async () => {
    useApi()
    await renderPage()

    const note = await screen.findByRole('note', { name: e.banners.hidden.label })
    expect(note.textContent).toContain(e.banners.hidden.body)
    // HIDDEN_PROJECT is on page one, and the totals have a hidden group.
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('a hidden group in the totals alone is enough', async () => {
    useApi({ 'GET /time-entries': () => ({ status: 200, body: entriesPage([ALPHA]) }) })
    await renderPage()
    expect(await screen.findByRole('note', { name: e.banners.hidden.label })).not.toBeNull()
  })

  it('nothing hidden and every source up: no banner at all', async () => {
    useApi({
      'GET /time-entries': () => ({ status: 200, body: entriesPage([ALPHA]) }),
      'GET /time-entries/totals': (url, init, params) =>
        url.searchParams.get('groupBy') === 'project'
          ? { status: 200, body: totalsAnswer([{ kind: 'keyed', key: 'p1', label: 'Project Alpha', minutes: 240 }]) }
          : totalsWithDays(url, init, params),
    })
    await renderPage()
    await screen.findByTestId('hours-day-list')
    expect(screen.queryByTestId('hours-banners')).toBeNull()
  })

  it('a hidden entry shows its type and "Not visible to you", no name, no link, no id (AC-4.10)', async () => {
    useApi()
    await renderPage()
    const hidden = await screen.findByTestId('hours-entry-e-hidden')
    expect(within(hidden).getByText(n.hidden)).not.toBeNull()
    expect(within(hidden).queryByRole('link')).toBeNull()
    expect(document.body.innerHTML).not.toContain('p-secret')
    expect(document.body.textContent).not.toContain('Secret project')
  })

  it('the banners stay while the new filters load, so the Filters card does not jump under the pointer', async () => {
    const slow = deferred<FakeAnswer>()
    let listAsks = 0
    useApi({
      'GET /time-entries': () =>
        ++listAsks === 1 ? { status: 200, body: entriesPage([ALPHA], { unavailable: ['projects'] }) } : slow.promise,
    })
    await renderPage()
    await screen.findByTestId('hours-banner-unavailable')
    await waitFor(() =>
      expect((screen.getByLabelText(f.category.label) as HTMLSelectElement).options.length).toBeGreaterThan(1),
    )

    await userEvent.selectOptions(screen.getByLabelText(f.category.label), 'tc-formazione')
    await waitFor(() => expect(entriesCalls()).toHaveLength(2))

    expect(screen.queryByTestId('hours-day-list')).toBeNull()
    expect(screen.getByTestId('hours-banner-unavailable')).not.toBeNull()

    // The new answer says every source is up: then, and only then, the banner goes.
    slow.resolve({ status: 200, body: entriesPage([ALPHA]) })
    await waitFor(() => expect(screen.queryByTestId('hours-banner-unavailable')).toBeNull())
  })
})

describe('the deal filter while Meetings cannot say which meetings belong to the deal (AC-4.11, D45)', () => {
  const blocker = () => screen.getByTestId('hours-deal-filter-unavailable')

  /** What must be gone while the banner is up: Totals, Entries, every figure and every row. */
  const expectNothingElseShown = () => {
    expect(screen.queryByTestId('hours-totals')).toBeNull()
    expect(screen.queryByTestId('hours-entries')).toBeNull()
    expect(screen.queryByTestId('hours-day-list')).toBeNull()
    expect(screen.queryByTestId('hours-totals-table')).toBeNull()
    expect(screen.queryByText('0 min')).toBeNull()
    expect(screen.queryByText(e.empty.title)).toBeNull()
    expect(screen.queryByText(e.emptyFiltered.title)).toBeNull()
    expect(screen.queryByText(t.empty)).toBeNull()
    expect(screen.queryByTestId('hours-banners')).toBeNull()
  }

  it.each<[string, Parameters<typeof fakeApi>[0]]>([
    ['the first page of entries', { 'GET /time-entries': refusingUnderDeal(entriesHandler) }],
    ['the totals', { 'GET /time-entries/totals': refusingUnderDeal(totalsWithDays) }],
    [
      'the day totals',
      {
        'GET /time-entries/totals': (url, init, params) =>
          url.searchParams.has('dealId') && url.searchParams.get('groupBy') === 'day'
            ? refused()
            : totalsWithDays(url, init, params),
      },
    ],
  ])(
    'a 503 host_unavailable on %s replaces Totals and Entries with ONE alert, never the empty state or "0 min"',
    async (_name, overrides) => {
      useApi(overrides)
      await renderPage()
      await screen.findByTestId('hours-day-list')

      await pickDeal()

      await waitFor(() => expect(screen.queryByTestId('hours-deal-filter-unavailable')).not.toBeNull())
      expect(blocker().getAttribute('role')).toBe('alert')
      expect(within(blocker()).getByText(e.dealFilterUnavailable.title)).not.toBeNull()
      expect(screen.getAllByRole('alert')).toHaveLength(1)
      expectNothingElseShown()
      // The Filters card stays, with the deal still picked, and Record hours-style page chrome is untouched.
      expect(screen.getByTestId('hours-filters')).not.toBeNull()
      expect((dealInput() as HTMLInputElement).value).toBe('Acme renewal')
      expect(screen.getByRole('heading', { level: 2 }).textContent).toBe(strings.myHours.heading)
    },
  )

  it('does not move focus when it appears: the person is in the Filters card', async () => {
    useApi({ 'GET /time-entries': refusingUnderDeal(entriesHandler) })
    await renderPage()
    await screen.findByTestId('hours-day-list')
    await pickDeal()
    await screen.findByTestId('hours-deal-filter-unavailable')

    expect(blocker().contains(document.activeElement)).toBe(false)
    expect(document.activeElement).not.toBe(blocker())
  })

  it('leaves nothing from before the filter was set: no rows, no totals, even while the new answers are on their way', async () => {
    const slow = deferred<FakeAnswer>()
    useApi({
      'GET /time-entries': (url, init, params) =>
        url.searchParams.has('dealId') ? slow.promise : entriesHandler(url, init, params),
    })
    await renderPage()
    await screen.findByTestId('hours-day-list')

    await pickDeal()

    await waitFor(() => expect(entriesCalls()).toHaveLength(2))
    expect(screen.queryByTestId('hours-day-list')).toBeNull()
    expect(screen.queryByTestId('hours-entry-e-alpha')).toBeNull()
    slow.resolve(refused())
    await screen.findByTestId('hours-deal-filter-unavailable')
    expectNothingElseShown()
  })

  it('Retry asks every read again; once they work focus goes to the Totals heading and the total is read politely', async () => {
    let healthy = false
    const gate =
      (otherwise: FakeHandler): FakeHandler =>
      (url, init, params) =>
        url.searchParams.has('dealId') && !healthy ? refused() : otherwise(url, init, params)
    useApi({ 'GET /time-entries': gate(entriesHandler), 'GET /time-entries/totals': gate(totalsWithDays) })
    await renderPage()
    await screen.findByTestId('hours-day-list')
    await pickDeal()
    await screen.findByTestId('hours-deal-filter-unavailable')
    const entriesBefore = entriesCalls().length
    const totalsBefore = totalsCalls().length
    healthy = true

    await userEvent.click(within(blocker()).getByRole('button', { name: strings.common.retry }))

    const heading = await screen.findByRole('heading', { level: 3, name: t.title })
    await waitFor(() => expect(document.activeElement).toBe(heading))
    expect(screen.queryByTestId('hours-deal-filter-unavailable')).toBeNull()
    expect(entriesCalls().length).toBe(entriesBefore + 1)
    // The chosen totals AND the day totals, each once.
    expect(totalsCalls().length).toBe(totalsBefore + 2)
    expect(screen.getByTestId('hours-totals-live').textContent).toBe(t.announce('137 hours'))
    expect(await screen.findByTestId('hours-day-list')).not.toBeNull()
  })

  it('while the retry is on its way both regions show their loading state, not the banner', async () => {
    let healthy = false
    const slow = deferred<FakeAnswer>()
    const gate =
      (otherwise: FakeHandler): FakeHandler =>
      (url, init, params) =>
        url.searchParams.has('dealId') && !healthy ? refused() : otherwise(url, init, params)
    useApi({
      'GET /time-entries': (url, init, params) =>
        healthy && url.searchParams.has('dealId') ? slow.promise : gate(entriesHandler)(url, init, params),
      'GET /time-entries/totals': gate(totalsWithDays),
    })
    await renderPage()
    await screen.findByTestId('hours-day-list')
    await pickDeal()
    await screen.findByTestId('hours-deal-filter-unavailable')
    healthy = true

    await userEvent.click(within(blocker()).getByRole('button', { name: strings.common.retry }))

    await waitFor(() => expect(screen.queryByTestId('hours-deal-filter-unavailable')).toBeNull())
    expect(screen.getByText(e.loading)).not.toBeNull()
    expect(screen.getByTestId('hours-totals')).not.toBeNull()
    slow.resolve({ status: 200, body: entriesPage([ALPHA]) })
    await screen.findByTestId('hours-day-list')
  })

  it('a Retry that fails again brings the banner back and puts focus on it, since the Retry button that had it is gone', async () => {
    useApi({ 'GET /time-entries': refusingUnderDeal(entriesHandler) })
    await renderPage()
    await screen.findByTestId('hours-day-list')
    await pickDeal()
    await screen.findByTestId('hours-deal-filter-unavailable')

    await userEvent.click(within(blocker()).getByRole('button', { name: strings.common.retry }))

    await waitFor(() => expect(document.activeElement).toBe(blocker()))
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expectNothingElseShown()
  })

  it('a Retry that works is not followed by the banner stealing focus later, and focus is not taken again on the next change', async () => {
    let healthy = false
    const gate =
      (otherwise: FakeHandler): FakeHandler =>
      (url, init, params) =>
        url.searchParams.has('dealId') && !healthy ? refused() : otherwise(url, init, params)
    useApi({ 'GET /time-entries': gate(entriesHandler), 'GET /time-entries/totals': gate(totalsWithDays) })
    await renderPage()
    await screen.findByTestId('hours-day-list')
    await pickDeal()
    await screen.findByTestId('hours-deal-filter-unavailable')
    healthy = true
    await userEvent.click(within(blocker()).getByRole('button', { name: strings.common.retry }))
    const heading = await screen.findByRole('heading', { level: 3, name: t.title })
    await waitFor(() => expect(document.activeElement).toBe(heading))

    // The person goes on to use the filters: the heading does not pull focus back.
    await userEvent.click(screen.getByLabelText(f.period.label))
    expect(document.activeElement).not.toBe(heading)
  })

  it('"Clear the deal filter" drops the filter, reloads normally and puts focus in the Deal field', async () => {
    useApi({
      'GET /time-entries': refusingUnderDeal(entriesHandler),
      'GET /time-entries/totals': refusingUnderDeal(totalsWithDays),
    })
    await renderPage()
    await screen.findByTestId('hours-day-list')
    await pickDeal()
    await screen.findByTestId('hours-deal-filter-unavailable')

    // By keyboard: a mouse press on a library button leaves focus in the text field the person was in.
    within(blocker()).getByRole('button', { name: e.dealFilterUnavailable.clear }).focus()
    await userEvent.keyboard('{Enter}')

    expect(await screen.findByTestId('hours-day-list')).not.toBeNull()
    expect(screen.queryByTestId('hours-deal-filter-unavailable')).toBeNull()
    expect(entriesCalls().at(-1)!.query).not.toHaveProperty('dealId')
    expect(totalsCalls('project').at(-1)!.query).not.toHaveProperty('dealId')
    expect(totalsCalls('day').at(-1)!.query).not.toHaveProperty('dealId')
    expect((dealInput() as HTMLInputElement).value).toBe('')
    expect(document.activeElement).toBe(dealInput())
  })

  it('without a deal filter the same refusal is an ordinary failure of the region, not this state', async () => {
    useApi({
      'GET /time-entries': () => refused(),
      'GET /time-entries/totals': (url, init, params) =>
        url.searchParams.get('groupBy') === 'project' ? refused() : totalsWithDays(url, init, params),
    })
    await renderPage()

    const card = await screen.findByTestId('hours-entries')
    expect(await within(card).findByRole('alert')).not.toBeNull()
    expect(screen.queryByTestId('hours-deal-filter-unavailable')).toBeNull()
    expect(screen.getByTestId('hours-totals')).not.toBeNull()
    expect(await within(screen.getByTestId('hours-totals')).findByRole('alert')).not.toBeNull()
  })

  it('another failure under the deal filter (a 500) is also an ordinary failure of its region', async () => {
    useApi({
      'GET /time-entries': (url, init, params) =>
        url.searchParams.has('dealId') ? { status: 500, body: problem(500) } : entriesHandler(url, init, params),
    })
    await renderPage()
    await screen.findByTestId('hours-day-list')
    await pickDeal()

    expect(await within(screen.getByTestId('hours-entries')).findByText(e.error.title)).not.toBeNull()
    expect(screen.queryByTestId('hours-deal-filter-unavailable')).toBeNull()
  })

  it('a failed Load more after a first page that DID arrive keeps those pages, with the error and Retry below them (D48)', async () => {
    useApi({
      'GET /time-entries': (url, init, params) =>
        url.searchParams.has('dealId') && url.searchParams.has('cursor')
          ? refused()
          : entriesHandler(url, init, params),
    })
    await renderPage()
    await screen.findByTestId('hours-day-list')
    await pickDeal()
    await waitFor(() => expect(entriesCalls().at(-1)!.query).toHaveProperty('dealId'))
    await screen.findByTestId('hours-day-list')

    await userEvent.click(loadMoreButton())

    const loadMore = screen.getByTestId('hours-entries-load-more')
    expect(await within(loadMore).findByRole('alert')).not.toBeNull()
    expect(screen.queryByTestId('hours-deal-filter-unavailable')).toBeNull()
    expect(within(day('2026-11-12')).getAllByRole('listitem')).toHaveLength(2)
    expect(screen.getByTestId('hours-totals-table')).not.toBeNull()
    expect(within(loadMore).getByRole('button', { name: e.loadMore })).not.toBeNull()
  })

  it('a deal filter that works shows the view normally (the meeting entries included)', async () => {
    useApi()
    await renderPage()
    await screen.findByTestId('hours-day-list')

    await pickDeal()

    await waitFor(() => expect(entriesCalls().at(-1)!.query['dealId']).toBe('d1'))
    expect(await screen.findByTestId('hours-day-list')).not.toBeNull()
    expect(screen.queryByTestId('hours-deal-filter-unavailable')).toBeNull()
  })
})
