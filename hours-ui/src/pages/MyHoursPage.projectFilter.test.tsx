/**
 * @vitest-environment jsdom
 *
 * My hours, the project filter now that the meetings linked to a project count (specs/20261112-project-hours T12;
 * AC-4.5, AC-4.8, AC-4.10; design F4, F5, S4; plan R4): the same refusal as the deal filter when Meetings cannot
 * say which meetings are linked (ONE alert in place of Totals and Entries, nothing partial, Clear returns to the
 * Project picker), a 409 `project_meetings_changed` between pages that starts the list over, and the by-project
 * grouping that says its meeting hours are one separate row. Rendered through the inner router with `fakeApi`
 * behind `apiFetch`, as the deal's own tests are (`MyHoursPage.entries.test.tsx`).
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
  projectItem,
  requests,
  totalsAnswer,
} from '../test-support/fakeApi'
import type { FakeAnswer, FakeHandler } from '../test-support/fakeApi'
import { ALPHA, entriesHandler, totalsWithDays } from '../test-support/fixtures/entries'
import { LISTS, TODAY_INSTANT } from '../test-support/fixtures/myHours'

const f = strings.filters
const t = strings.totals
const e = strings.entries

let api: ReturnType<typeof fakeApi>

const useApi = (overrides: Parameters<typeof fakeApi>[0] = {}) => {
  api = fakeApi({
    'GET /time-lists': listsHandler(LISTS),
    'GET /time-entries': entriesHandler,
    'GET /time-entries/totals': totalsWithDays,
    'GET /projects': () => ({ status: 200, body: page([projectItem({ id: 'p1', name: 'Project Alpha' })]) }),
    'GET /deals': () => ({ status: 200, body: page([dealItem({ id: 'd1', title: 'Acme renewal' })]) }),
    ...overrides,
  })
  apiFetch.mockImplementation(api)
}

const renderPage = async (path = '/hours?view=list') => {
  const history = createMemoryHistory({ initialEntries: [path] })
  render(<RouterProvider router={createAppRouter('/hours', undefined, history)} />)
  await screen.findByTestId('hours-my-page')
}

const entriesCalls = () => requests(api, 'GET /time-entries')
const totalsCalls = (groupBy?: string) =>
  requests(api, 'GET /time-entries/totals').filter(
    (request) => groupBy === undefined || request.query['groupBy'] === groupBy,
  )

const projectInput = () => screen.getByRole('combobox', { name: f.project.label })
const dealInput = () => screen.getByRole('combobox', { name: f.deal.label })

/** Picks the project "Project Alpha" in the Project filter, as a person would. */
const pickProject = async () => {
  await userEvent.type(projectInput(), 'a')
  await userEvent.click(await screen.findByRole('option', { name: /Project Alpha/ }))
}
const pickDeal = async () => {
  await userEvent.type(dealInput(), 'a')
  await userEvent.click(await screen.findByRole('option', { name: /Acme renewal/ }))
}

const refused = (): FakeAnswer => ({ status: 503, body: problem(503, 'host_unavailable') })

/** A handler that refuses (503 `host_unavailable`) any ask that carries a `projectId`, else answers with `otherwise`. */
const refusingUnderProject =
  (otherwise: FakeHandler): FakeHandler =>
  (url, init, params) =>
    url.searchParams.has('projectId') ? refused() : otherwise(url, init, params)

beforeEach(() => {
  apiFetch.mockReset()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(TODAY_INSTANT))
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('the project filter while Meetings cannot say which meetings are linked to the project (AC-4.8)', () => {
  const blocker = () => screen.getByTestId('hours-project-filter-unavailable')

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
    ['the first page of entries', { 'GET /time-entries': refusingUnderProject(entriesHandler) }],
    ['the totals', { 'GET /time-entries/totals': refusingUnderProject(totalsWithDays) }],
    [
      'the day totals',
      {
        'GET /time-entries/totals': (url, init, params) =>
          url.searchParams.has('projectId') && url.searchParams.get('groupBy') === 'day'
            ? refused()
            : totalsWithDays(url, init, params),
      },
    ],
  ])(
    'a 503 host_unavailable on %s replaces Totals and Entries with ONE alert in project words, never the empty state or "0 min"',
    async (_name, overrides) => {
      useApi(overrides)
      await renderPage()
      await screen.findByTestId('hours-day-list')

      await pickProject()

      await waitFor(() => expect(screen.queryByTestId('hours-project-filter-unavailable')).not.toBeNull())
      expect(blocker().getAttribute('role')).toBe('alert')
      expect(within(blocker()).getByText(e.projectFilterUnavailable.title)).not.toBeNull()
      expect(screen.queryByTestId('hours-deal-filter-unavailable')).toBeNull()
      expect(screen.getAllByRole('alert')).toHaveLength(1)
      expectNothingElseShown()
      // The Filters card stays, with the project still picked.
      expect(screen.getByTestId('hours-filters')).not.toBeNull()
      expect((projectInput() as HTMLInputElement).value).toBe('Project Alpha')
      expect(screen.getByRole('heading', { level: 2 }).textContent).toBe(strings.myHours.heading)
    },
  )

  it('does not move focus when it appears: the person is in the Filters card', async () => {
    useApi({ 'GET /time-entries': refusingUnderProject(entriesHandler) })
    await renderPage()
    await screen.findByTestId('hours-day-list')
    await pickProject()
    await screen.findByTestId('hours-project-filter-unavailable')

    expect(blocker().contains(document.activeElement)).toBe(false)
    expect(document.activeElement).not.toBe(blocker())
  })

  it('leaves nothing from before the filter was set while the new answers are on their way', async () => {
    const slow = deferred<FakeAnswer>()
    useApi({
      'GET /time-entries': (url, init, params) =>
        url.searchParams.has('projectId') ? slow.promise : entriesHandler(url, init, params),
    })
    await renderPage()
    await screen.findByTestId('hours-day-list')

    await pickProject()

    await waitFor(() => expect(entriesCalls()).toHaveLength(2))
    expect(screen.queryByTestId('hours-day-list')).toBeNull()
    slow.resolve(refused())
    await screen.findByTestId('hours-project-filter-unavailable')
    expectNothingElseShown()
  })

  it('Retry asks every read again; once they work focus goes to the Totals heading and the banner is gone', async () => {
    let healthy = false
    const gate =
      (otherwise: FakeHandler): FakeHandler =>
      (url, init, params) =>
        url.searchParams.has('projectId') && !healthy ? refused() : otherwise(url, init, params)
    useApi({ 'GET /time-entries': gate(entriesHandler), 'GET /time-entries/totals': gate(totalsWithDays) })
    await renderPage()
    await screen.findByTestId('hours-day-list')
    await pickProject()
    await screen.findByTestId('hours-project-filter-unavailable')
    const entriesBefore = entriesCalls().length
    const totalsBefore = totalsCalls().length
    healthy = true

    await userEvent.click(within(blocker()).getByRole('button', { name: strings.common.retry }))

    const heading = await screen.findByRole('heading', { level: 3, name: t.title })
    await waitFor(() => expect(document.activeElement).toBe(heading))
    expect(screen.queryByTestId('hours-project-filter-unavailable')).toBeNull()
    expect(entriesCalls().length).toBe(entriesBefore + 1)
    expect(totalsCalls().length).toBe(totalsBefore + 2)
    expect(await screen.findByTestId('hours-day-list')).not.toBeNull()
  })

  it('a Retry that fails again brings the banner back and puts focus on it, since the Retry button that had it is gone', async () => {
    useApi({ 'GET /time-entries': refusingUnderProject(entriesHandler) })
    await renderPage()
    await screen.findByTestId('hours-day-list')
    await pickProject()
    await screen.findByTestId('hours-project-filter-unavailable')

    await userEvent.click(within(blocker()).getByRole('button', { name: strings.common.retry }))

    await waitFor(() => expect(document.activeElement).toBe(blocker()))
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expectNothingElseShown()
  })

  it('"Clear the project filter" drops the filter, reloads normally and puts focus in the Project field', async () => {
    useApi({
      'GET /time-entries': refusingUnderProject(entriesHandler),
      'GET /time-entries/totals': refusingUnderProject(totalsWithDays),
    })
    await renderPage()
    await screen.findByTestId('hours-day-list')
    await pickProject()
    await screen.findByTestId('hours-project-filter-unavailable')

    // By keyboard: a mouse press on a library button leaves focus in the text field the person was in.
    within(blocker()).getByRole('button', { name: e.projectFilterUnavailable.clear }).focus()
    await userEvent.keyboard('{Enter}')

    expect(await screen.findByTestId('hours-day-list')).not.toBeNull()
    expect(screen.queryByTestId('hours-project-filter-unavailable')).toBeNull()
    expect(entriesCalls().at(-1)!.query).not.toHaveProperty('projectId')
    expect(totalsCalls('project').at(-1)!.query).not.toHaveProperty('projectId')
    expect(totalsCalls('day').at(-1)!.query).not.toHaveProperty('projectId')
    expect((projectInput() as HTMLInputElement).value).toBe('')
    expect(document.activeElement).toBe(projectInput())
  })

  it('without a project filter the same refusal is an ordinary failure of the region, not this state', async () => {
    useApi({
      'GET /time-entries': () => refused(),
      'GET /time-entries/totals': (url, init, params) =>
        url.searchParams.get('groupBy') === 'project' ? refused() : totalsWithDays(url, init, params),
    })
    await renderPage()

    const card = await screen.findByTestId('hours-entries')
    expect(await within(card).findByRole('alert')).not.toBeNull()
    expect(screen.queryByTestId('hours-project-filter-unavailable')).toBeNull()
    expect(screen.queryByTestId('hours-deal-filter-unavailable')).toBeNull()
  })

  it('another failure under the project filter (a 500) is also an ordinary failure of its region', async () => {
    useApi({
      'GET /time-entries': (url, init, params) =>
        url.searchParams.has('projectId') ? { status: 500, body: problem(500) } : entriesHandler(url, init, params),
    })
    await renderPage()
    await screen.findByTestId('hours-day-list')
    await pickProject()

    expect(await within(screen.getByTestId('hours-entries')).findByText(e.error.title)).not.toBeNull()
    expect(screen.queryByTestId('hours-project-filter-unavailable')).toBeNull()
  })

  it('a failed Load more after a first page that DID arrive keeps those pages, with the error and Retry below them (D48)', async () => {
    useApi({
      'GET /time-entries': (url, init, params) =>
        url.searchParams.has('projectId') && url.searchParams.has('cursor')
          ? refused()
          : entriesHandler(url, init, params),
    })
    await renderPage()
    await screen.findByTestId('hours-day-list')
    await pickProject()
    await waitFor(() => expect(entriesCalls().at(-1)!.query).toHaveProperty('projectId'))
    await screen.findByTestId('hours-day-list')

    await userEvent.click(screen.getByRole('button', { name: e.loadMore }))

    const loadMore = screen.getByTestId('hours-entries-load-more')
    expect(await within(loadMore).findByRole('alert')).not.toBeNull()
    expect(screen.queryByTestId('hours-project-filter-unavailable')).toBeNull()
    expect(within(screen.getByTestId('hours-day-2026-11-12')).getAllByRole('listitem')).toHaveLength(2)
    expect(screen.getByTestId('hours-totals-table')).not.toBeNull()
    expect(within(loadMore).getByRole('button', { name: e.loadMore })).not.toBeNull()
  })

  it('a project filter that works shows the view normally', async () => {
    useApi()
    await renderPage()
    await screen.findByTestId('hours-day-list')

    await pickProject()

    await waitFor(() => expect(entriesCalls().at(-1)!.query['projectId']).toBe('p1'))
    expect(await screen.findByTestId('hours-day-list')).not.toBeNull()
    expect(screen.queryByTestId('hours-project-filter-unavailable')).toBeNull()
  })

  it('the table view is refused the same way: the banner takes the grid’s place and the toolbar stays', async () => {
    useApi({
      'GET /time-entries': (url) =>
        url.searchParams.has('projectId') ? refused() : { status: 200, body: entriesPage([]) },
    })
    await renderPage('/hours')
    await screen.findByTestId('hours-table-empty')

    await pickProject()

    await screen.findByTestId('hours-project-filter-unavailable')
    expect(screen.queryByTestId('hours-table-empty')).toBeNull()
    expect(screen.queryByTestId('hours-table-table')).toBeNull()
    expect(screen.getByTestId('hours-table-toolbar')).not.toBeNull()
    expect(screen.getAllByRole('alert')).toHaveLength(1)
  })

  describe('with a deal filter set as well', () => {
    it('shows the project words, and clearing the project leaves the deal’s refusal when the deal still triggers it', async () => {
      const refusing =
        (otherwise: FakeHandler): FakeHandler =>
        (url, init, params) =>
          url.searchParams.has('projectId') || url.searchParams.has('dealId') ? refused() : otherwise(url, init, params)
      useApi({ 'GET /time-entries': refusing(entriesHandler), 'GET /time-entries/totals': refusing(totalsWithDays) })
      await renderPage()
      await screen.findByTestId('hours-day-list')
      await pickDeal()
      await screen.findByTestId('hours-deal-filter-unavailable')
      await pickProject()

      await screen.findByTestId('hours-project-filter-unavailable')
      expect(screen.queryByTestId('hours-deal-filter-unavailable')).toBeNull()

      within(blocker()).getByRole('button', { name: e.projectFilterUnavailable.clear }).focus()
      await userEvent.keyboard('{Enter}')

      // The project is gone; the deal is still set and still refused, so it is the deal's banner that shows.
      await screen.findByTestId('hours-deal-filter-unavailable')
      expect(screen.queryByTestId('hours-project-filter-unavailable')).toBeNull()
      expect((projectInput() as HTMLInputElement).value).toBe('')
      expect((dealInput() as HTMLInputElement).value).toBe('Acme renewal')
    })
  })
})

describe('the linked meetings changed between two pages (409 `project_meetings_changed`, AC-4.4)', () => {
  it('starts the list over from its first page, as the deal’s 409 does, instead of a failed Load more', async () => {
    let first = true
    useApi({
      'GET /time-entries': (url, init, params) => {
        if (!url.searchParams.has('projectId')) return entriesHandler(url, init, params)
        if (url.searchParams.has('cursor')) return { status: 409, body: problem(409, 'project_meetings_changed') }
        const answer = entriesHandler(url, init, params)
        if (first) {
          first = false
          return answer
        }
        return { status: 200, body: entriesPage([ALPHA]) }
      },
    })
    await renderPage()
    await screen.findByTestId('hours-day-list')
    await pickProject()
    await waitFor(() => expect(entriesCalls().at(-1)!.query).toHaveProperty('projectId'))
    await screen.findByTestId('hours-day-list')
    const asked = entriesCalls().length

    await userEvent.click(screen.getByRole('button', { name: e.loadMore }))

    // The read starts over: the first page is asked again (no cursor), and its new answer is on screen with no error.
    await waitFor(() => expect(entriesCalls().length).toBe(asked + 2))
    expect(entriesCalls().at(-1)!.query).not.toHaveProperty('cursor')
    expect(entriesCalls().at(-1)!.query).toHaveProperty('projectId', 'p1')
    expect(await screen.findByTestId('hours-entry-e-alpha')).not.toBeNull()
    expect(screen.queryByTestId('hours-entries-load-more')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('grouped by project while the meeting → project link did not answer (AC-4.5, AC-4.10)', () => {
  const projectUnknownTotals: FakeHandler = (url, init, params) =>
    url.searchParams.get('groupBy') === 'project'
      ? {
          status: 200,
          body: totalsAnswer(
            [
              { kind: 'keyed', key: 'p1', label: 'Project Alpha', minutes: 240 },
              { kind: 'project-unknown', minutes: 150 },
              { kind: 'none', minutes: 60 },
            ],
            ['meeting-projects'],
          ),
        }
      : totalsWithDays(url, init, params)

  it('shows the meeting hours as one row in the server’s order, and the polite warning that the total is unchanged', async () => {
    useApi({ 'GET /time-entries/totals': projectUnknownTotals })
    await renderPage('/hours?view=list&group=project')

    const table = await screen.findByTestId('hours-totals-table')
    expect(
      within(table)
        .getAllByRole('row')
        .slice(1)
        .map((row) => Array.from(row.querySelectorAll('th, td')).map((cell) => cell.textContent)),
    ).toEqual([
      ['Project Alpha', '4 h'],
      [t.rows.project.projectUnknown, '2 h 30'],
      [t.rows.project.none, '1 h'],
    ])
    const warning = await screen.findByTestId('hours-banner-project-grouping')
    expect(warning.textContent).toContain(e.banners.projectGrouping)
    expect(warning.getAttribute('role')).toBe('status')
    expect(screen.queryByTestId('hours-banner-deal-grouping')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('names the source in the standing note, in words', async () => {
    useApi({ 'GET /time-entries/totals': projectUnknownTotals })
    await renderPage('/hours?view=list&group=project')

    const banner = await screen.findByTestId('hours-banner-unavailable')
    expect(banner.textContent).toContain(strings.names.sources['meeting-projects'])
  })

  it('is only said while grouping by project: grouped by deal the same source names itself but has no project warning', async () => {
    useApi({
      'GET /time-entries/totals': (url, init, params) =>
        url.searchParams.get('groupBy') === 'deal'
          ? { status: 200, body: totalsAnswer([{ kind: 'none', minutes: 60 }], ['meeting-projects']) }
          : totalsWithDays(url, init, params),
    })
    await renderPage('/hours?view=list&group=deal')

    await screen.findByTestId('hours-banner-unavailable')
    expect(screen.queryByTestId('hours-banner-project-grouping')).toBeNull()
  })

  it('is not said when every source answered', async () => {
    useApi()
    await renderPage('/hours?view=list&group=project')
    await screen.findByTestId('hours-totals-table')
    expect(screen.queryByTestId('hours-banner-project-grouping')).toBeNull()
  })
})
