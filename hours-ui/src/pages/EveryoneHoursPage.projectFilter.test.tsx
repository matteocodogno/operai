/**
 * @vitest-environment jsdom
 *
 * Everyone's hours, the project filter now that the meetings linked to a project count (specs/20261112-project-hours
 * T12; AC-4.5, AC-4.8, AC-4.10; design S4): the deal filter's refusal for a project filter — ONE alert in project
 * words in place of Totals and Entries, nothing partial, Clear returns to the Project picker — and the by-project
 * grouping that says its meeting hours are one separate row. `EveryoneHoursPage.view.test.tsx` has the deal's twin.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RouterProvider, createMemoryHistory } from '@tanstack/react-router'

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock('shell/session', async () =>
  (await import('../test-support/fakeSession')).shellSessionMock(apiFetch, {
    permissions: (await import('../test-support/fakeSession')).READ_ALL_HOLDER,
  }),
)

import { createAppRouter } from '../router'
import { strings } from '../strings'
import { fakeApi, listsHandler, page, problem, projectItem, requests, totalsAnswer } from '../test-support/fakeApi'
import type { FakeAnswer, FakeHandler } from '../test-support/fakeApi'
import { PERSON_TOTALS, entriesHandler, totalsWithPeople } from '../test-support/fixtures/everyone'
import { LISTS, TODAY_INSTANT } from '../test-support/fixtures/myHours'

const t = strings.everyone
const e = strings.entries
const f = strings.filters
const tt = strings.totals

let api: ReturnType<typeof fakeApi>

const useApi = (overrides: Parameters<typeof fakeApi>[0] = {}) => {
  api = fakeApi({
    'GET /time-lists': listsHandler(LISTS),
    'GET /time-entries': entriesHandler,
    'GET /time-entries/totals': totalsWithPeople,
    'GET /projects': () => ({ status: 200, body: page([projectItem({ id: 'p1', name: 'Project Alpha' })]) }),
    ...overrides,
  })
  apiFetch.mockImplementation(api)
}

const renderPage = async (path = '/hours/all') => {
  const history = createMemoryHistory({ initialEntries: [path] })
  render(<RouterProvider router={createAppRouter('/hours', undefined, history)} />)
  await screen.findByTestId('hours-everyone-page')
  await screen.findByTestId('hours-filters')
}

const entriesCalls = () => requests(api, 'GET /time-entries')
const totalsCalls = (groupBy?: string) =>
  requests(api, 'GET /time-entries/totals').filter(
    (request) => groupBy === undefined || request.query['groupBy'] === groupBy,
  )

const projectInput = () => screen.getByRole('combobox', { name: f.project.label })

/** Picks the project "Project Alpha" in the Project filter, as a person would. */
const pickProject = async () => {
  await userEvent.type(projectInput(), 'a')
  await userEvent.click(await screen.findByRole('option', { name: /Project Alpha/ }))
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
    expect(screen.queryByTestId('hours-entries-table')).toBeNull()
    expect(screen.queryByTestId('hours-totals-table')).toBeNull()
    expect(screen.queryByText('0 min')).toBeNull()
    expect(screen.queryByText(t.entries.empty.title)).toBeNull()
    expect(screen.queryByText(e.emptyFiltered.title)).toBeNull()
    expect(screen.queryByTestId('hours-banners')).toBeNull()
  }

  it.each<[string, Parameters<typeof fakeApi>[0]]>([
    ['the first page of entries', { 'GET /time-entries': refusingUnderProject(entriesHandler) }],
    ['the totals', { 'GET /time-entries/totals': refusingUnderProject(totalsWithPeople) }],
  ])(
    'a 503 host_unavailable on %s replaces Totals and Entries with ONE alert in project words, never the empty state or "0 min"',
    async (_name, overrides) => {
      useApi(overrides)
      await renderPage()
      await screen.findByRole('table', { name: t.entries.caption })

      await pickProject()

      await waitFor(() => expect(screen.queryByTestId('hours-project-filter-unavailable')).not.toBeNull())
      expect(blocker().getAttribute('role')).toBe('alert')
      expect(within(blocker()).getByText(e.projectFilterUnavailable.title)).not.toBeNull()
      expect(screen.queryByTestId('hours-deal-filter-unavailable')).toBeNull()
      expect(screen.getAllByRole('alert')).toHaveLength(1)
      expectNothingElseShown()
      expect(screen.getByTestId('hours-filters')).not.toBeNull()
      expect((projectInput() as HTMLInputElement).value).toBe('Project Alpha')
      expect(screen.getByRole('heading', { level: 2 }).textContent).toBe(t.heading)
    },
  )

  it('the Person call carries the project filter too, so it alone refusing is the same state', async () => {
    useApi({
      'GET /time-entries/totals': (url, init, params) =>
        url.searchParams.get('groupBy') === 'person' && url.searchParams.has('projectId')
          ? refused()
          : totalsWithPeople(url, init, params),
    })
    await renderPage('/hours/all?group=project')
    await screen.findByRole('table', { name: t.entries.caption })

    await pickProject()

    await screen.findByTestId('hours-project-filter-unavailable')
    expectNothingElseShown()
    const people = totalsCalls('person').filter((request) => request.query['projectId'] === 'p1')
    expect(people.length).toBeGreaterThan(0)
    expect(people[0]!.query).not.toHaveProperty('userId')
  })

  it('does not move focus when it appears: the person is in the Filters card', async () => {
    useApi({ 'GET /time-entries': refusingUnderProject(entriesHandler) })
    await renderPage()
    await screen.findByRole('table', { name: t.entries.caption })
    await pickProject()
    await screen.findByTestId('hours-project-filter-unavailable')

    expect(blocker().contains(document.activeElement)).toBe(false)
    expect(document.activeElement).not.toBe(blocker())
  })

  it('Retry asks all three reads again; once they work focus goes to the Totals heading and the banner is gone', async () => {
    let healthy = false
    const gate =
      (otherwise: FakeHandler): FakeHandler =>
      (url, init, params) =>
        url.searchParams.has('projectId') && !healthy ? refused() : otherwise(url, init, params)
    useApi({ 'GET /time-entries': gate(entriesHandler), 'GET /time-entries/totals': gate(totalsWithPeople) })
    await renderPage()
    await screen.findByRole('table', { name: t.entries.caption })
    await pickProject()
    await screen.findByTestId('hours-project-filter-unavailable')
    const entriesBefore = entriesCalls().length
    const totalsBefore = totalsCalls().length
    healthy = true

    await userEvent.click(within(blocker()).getByRole('button', { name: strings.common.retry }))

    const heading = await screen.findByRole('heading', { level: 3, name: tt.title })
    await waitFor(() => expect(document.activeElement).toBe(heading))
    expect(screen.queryByTestId('hours-project-filter-unavailable')).toBeNull()
    expect(entriesCalls().length).toBe(entriesBefore + 1)
    // The chosen totals AND the people, each once.
    expect(totalsCalls().length).toBe(totalsBefore + 2)
    expect(await screen.findByRole('table', { name: t.entries.caption })).not.toBeNull()
  })

  it('a Retry that fails again brings the banner back and puts focus on it, since the Retry button that had it is gone', async () => {
    useApi({ 'GET /time-entries': refusingUnderProject(entriesHandler) })
    await renderPage()
    await screen.findByRole('table', { name: t.entries.caption })
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
      'GET /time-entries/totals': refusingUnderProject(totalsWithPeople),
    })
    await renderPage()
    await screen.findByRole('table', { name: t.entries.caption })
    await pickProject()
    await screen.findByTestId('hours-project-filter-unavailable')

    // By keyboard: a mouse press on a library button leaves focus in the text field the person was in.
    within(blocker()).getByRole('button', { name: e.projectFilterUnavailable.clear }).focus()
    await userEvent.keyboard('{Enter}')

    expect(await screen.findByRole('table', { name: t.entries.caption })).not.toBeNull()
    expect(screen.queryByTestId('hours-project-filter-unavailable')).toBeNull()
    expect(entriesCalls().at(-1)!.query).not.toHaveProperty('projectId')
    expect(totalsCalls('person').at(-1)!.query).not.toHaveProperty('projectId')
    expect((projectInput() as HTMLInputElement).value).toBe('')
    expect(document.activeElement).toBe(projectInput())
  })

  it('a failed Load more after a first page that DID arrive keeps those pages, with the error below them (D48)', async () => {
    useApi({
      'GET /time-entries': (url, init, params) =>
        url.searchParams.has('projectId') && url.searchParams.has('cursor')
          ? refused()
          : entriesHandler(url, init, params),
    })
    await renderPage()
    await screen.findByRole('table', { name: t.entries.caption })
    await pickProject()
    await waitFor(() => expect(entriesCalls().at(-1)!.query).toHaveProperty('projectId'))
    await screen.findByRole('table', { name: t.entries.caption })
    await userEvent.click(screen.getByRole('button', { name: e.loadMore }))

    expect(await screen.findByText(e.loadMoreError)).not.toBeNull()
    expect(screen.queryByTestId('hours-project-filter-unavailable')).toBeNull()
    expect(screen.getByTestId('hours-entry-e-ada-alpha')).not.toBeNull()
    expect(screen.getByTestId('hours-entry-e-grace-hidden')).not.toBeNull()
  })

  it('without a project filter the same refusal is an ordinary failure of the region, not this state', async () => {
    useApi({ 'GET /time-entries': () => refused() })
    await renderPage()

    const card = await screen.findByTestId('hours-entries')
    expect(await within(card).findByRole('alert')).not.toBeNull()
    expect(screen.queryByTestId('hours-project-filter-unavailable')).toBeNull()
    expect(screen.queryByTestId('hours-deal-filter-unavailable')).toBeNull()
  })
})

describe('grouped by project while the meeting → project link did not answer (AC-4.5, AC-4.10)', () => {
  it('shows the meeting hours as one row in the server’s order, with the polite warning that the total is unchanged', async () => {
    useApi({
      'GET /time-entries/totals': (url, init, params) =>
        url.searchParams.get('groupBy') === 'project'
          ? {
              status: 200,
              body: totalsAnswer(
                [
                  { kind: 'keyed', key: 'p1', label: 'Project Alpha', minutes: 240 },
                  { kind: 'project-unknown', minutes: 150 },
                ],
                ['meeting-projects'],
              ),
            }
          : totalsWithPeople(url, init, params),
    })
    await renderPage('/hours/all?group=project')

    const table = await screen.findByTestId('hours-totals-table')
    expect(
      within(table)
        .getAllByRole('row')
        .slice(1)
        .map((row) => Array.from(row.querySelectorAll('th, td')).map((cell) => cell.textContent)),
    ).toEqual([
      ['Project Alpha', '4 h'],
      [tt.rows.project.projectUnknown, '2 h 30'],
    ])
    const warning = await screen.findByTestId('hours-banner-project-grouping')
    expect(warning.textContent).toContain(e.banners.projectGrouping)
    expect(warning.getAttribute('role')).toBe('status')
    expect(screen.queryByTestId('hours-banner-deal-grouping')).toBeNull()
  })

  it('is not said while grouped by person, even though the same source is named', async () => {
    useApi({
      'GET /time-entries/totals': (url) =>
        url.searchParams.get('groupBy') === 'person'
          ? { status: 200, body: { ...PERSON_TOTALS, unavailable: ['meeting-projects'] } }
          : { status: 200, body: totalsAnswer([]) },
    })
    await renderPage('/hours/all?group=person')

    await screen.findByTestId('hours-banner-unavailable')
    expect(screen.queryByTestId('hours-banner-project-grouping')).toBeNull()
  })
})
