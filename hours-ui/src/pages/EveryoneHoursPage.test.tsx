/**
 * @vitest-environment jsdom
 *
 * Everyone's hours — `/hours/all` (specs/029-time-tracking T29; AC-4.2, AC-4.3, AC-4.4, AC-4.5, AC-4.7, AC-4.8,
 * AC-4.10, AC-4.11, AC-5.4, AC-1.6; design F6, S4, F8; ADR-0075, ADR-0090). Rendered through the inner
 * router with `fakeApi` behind `apiFetch`, so a request assertion is about the query the real `hoursApi`
 * builds. The permissions are a store a test can change while the page is mounted, because the page must
 * wait for them, give up waiting, and follow a grant that arrives or goes.
 *
 * This file: the gate (who may ask), the denial and the outage states, and the reads. The filters, the
 * Person options, the table, the banners and the deal filter are in `EveryoneHoursPage.view.test.tsx`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RouterProvider, createMemoryHistory } from '@tanstack/react-router'
import type { FakePermissions } from '../test-support/fakeSession'

const { apiFetch, permissionsStore } = vi.hoisted(() => {
  let value = { epoch: 0, apps: [], roles: [], departments: [], permissions: [] } as FakePermissions
  const listeners = new Set<() => void>()
  return {
    apiFetch: vi.fn(),
    permissionsStore: {
      get: () => value,
      set: (next: FakePermissions) => {
        value = next
        listeners.forEach((listener) => listener())
      },
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
  }
})
vi.mock('shell/session', async () => {
  const { shellSessionMock } = await import('../test-support/fakeSession')
  const { useSyncExternalStore } = await import('react')
  return {
    ...shellSessionMock(apiFetch),
    usePermissions: () => useSyncExternalStore(permissionsStore.subscribe, permissionsStore.get),
  }
})

import { createAppRouter } from '../router'
import { strings } from '../strings'
import { fakeApi, listsHandler, problem, requests, sequence } from '../test-support/fakeApi'
import type { FakeAnswer, FakeHandler } from '../test-support/fakeApi'
import { EMPLOYEE, NOT_RESOLVED, READ_ALL_HOLDER } from '../test-support/fakeSession'
import { entriesHandler, totalsWithPeople } from '../test-support/fixtures/everyone'
import { LISTS, TODAY_INSTANT } from '../test-support/fixtures/myHours'

const t = strings.everyone
const f = strings.filters

let api: ReturnType<typeof fakeApi>

const useApi = (overrides: Parameters<typeof fakeApi>[0] = {}) => {
  api = fakeApi({
    'GET /time-lists': listsHandler(LISTS),
    'GET /time-entries': entriesHandler,
    'GET /time-entries/totals': totalsWithPeople,
    ...overrides,
  })
  apiFetch.mockImplementation(api)
}

const renderPage = async (path = '/hours/all') => {
  const history = createMemoryHistory({ initialEntries: [path] })
  render(<RouterProvider router={createAppRouter('/hours', undefined, history)} />)
  await screen.findByTestId('hours-everyone-page')
  return history
}

/**
 * For a test that moves time. Under faked `setTimeout` RTL's `findBy…` cannot settle (it drains the queue with a
 * `setTimeout(0)`), so such a test mounts by hand and lets the router and the reads run by advancing the clock.
 */
const settle = (ms = 0) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })

const renderPageAdvancing = async (path = '/hours/all') => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  vi.setSystemTime(new Date(TODAY_INSTANT))
  render(
    <RouterProvider router={createAppRouter('/hours', undefined, createMemoryHistory({ initialEntries: [path] }))} />,
  )
  await settle(10)
  expect(screen.getByTestId('hours-everyone-page')).not.toBeNull()
}

const hoursCalls = () => api.mock.calls.filter(([input]) => String(input).startsWith('http://hours-api.test'))
const entriesCalls = () => requests(api, 'GET /time-entries')
const totalsCalls = (groupBy?: string) =>
  requests(api, 'GET /time-entries/totals').filter(
    (request) => groupBy === undefined || request.query['groupBy'] === groupBy,
  )

const refused = (status: number, code: string): FakeAnswer => ({ status, body: problem(status, code) })
const forbidden = (): FakeAnswer => refused(403, 'read_all_required')
const authzDown = (): FakeAnswer => refused(503, 'authz_unavailable')

/** `GET /time-entries/totals` answered per `groupBy`, the person grouping included (others as `totalsWithPeople`). */
const totalsBy =
  (byGroup: Record<string, FakeHandler>): FakeHandler =>
  (url, init, params) =>
    (byGroup[url.searchParams.get('groupBy') ?? ''] ?? totalsWithPeople)(url, init, params)

const denied = () => screen.queryByTestId('hours-permission-denied')

beforeEach(() => {
  apiFetch.mockReset()
  permissionsStore.set(NOT_RESOLVED)
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(TODAY_INSTANT))
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('the gate: nothing is asked of a person who may not see everyone’s hours (AC-4.2, ADR-0075)', () => {
  it('while the permissions have not arrived it asks nothing and says it is loading, under its own header', async () => {
    useApi()
    await renderPage()
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe(t.heading)
    expect(screen.getByText(t.loading)).not.toBeNull()
    expect(screen.getByTestId('hours-everyone-gate-skeleton')).not.toBeNull()
    expect(screen.queryByTestId('hours-filters')).toBeNull()
    expect(denied()).toBeNull()
    expect(apiFetch).not.toHaveBeenCalled()
  })

  it('has a description saying it is read only, and no way to write: no Record hours', async () => {
    useApi()
    permissionsStore.set(READ_ALL_HOLDER)
    await renderPage()
    expect(screen.getByText(t.description)).not.toBeNull()
    expect(t.description).toBe('Read only. Hours can be changed only by the person who recorded them.')
    expect(screen.queryByRole('button', { name: /record hours/i })).toBeNull()
  })

  it('a person who is not a holder gets the denial, never asked anything', async () => {
    useApi()
    permissionsStore.set(EMPLOYEE)
    await renderPage()
    expect(await screen.findByTestId('hours-permission-denied')).not.toBeNull()
    expect(apiFetch).not.toHaveBeenCalled()
    expect(screen.queryByTestId('hours-filters')).toBeNull()
    expect(screen.queryByTestId('hours-entries')).toBeNull()
  })

  it('the denial is an alert with its own words, takes focus on its heading and leads back to My hours', async () => {
    useApi()
    permissionsStore.set(EMPLOYEE)
    await renderPage()
    const panel = await screen.findByTestId('hours-permission-denied')
    expect(panel.getAttribute('role')).toBe('alert')
    const heading = screen.getByRole('heading', { name: t.denied.title })
    expect(heading.tagName).toBe('H3')
    expect(document.activeElement).toBe(heading)
    expect(screen.getByText(t.denied.body)).not.toBeNull()
    expect(screen.getByRole('link', { name: t.denied.back }).getAttribute('href')).toBe('/hours/')
    // The page's own header stays: it is the page the person asked for.
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe(t.heading)
  })

  it('does not wait for ever: permissions that never arrive end in the denial, still asking nothing', async () => {
    useApi()
    await renderPageAdvancing()
    expect(denied()).toBeNull()
    await settle(2000)
    expect(denied()).toBeNull()
    await settle(2000)
    expect(denied()).not.toBeNull()
    expect(screen.queryByText(t.loading)).toBeNull()
    expect(apiFetch).not.toHaveBeenCalled()
  })

  it('a holder is asked, and the permissions that arrive late are followed: the loading gives way to the view', async () => {
    useApi()
    await renderPage()
    expect(apiFetch).not.toHaveBeenCalled()
    act(() => permissionsStore.set(READ_ALL_HOLDER))
    expect(await screen.findByTestId('hours-entries-table')).not.toBeNull()
    expect(screen.queryByText(t.loading)).toBeNull()
    expect(denied()).toBeNull()
  })

  it('permissions that arrive after the wait still win: a holder is shown the view, not the denial', async () => {
    useApi()
    await renderPageAdvancing()
    await settle(4000)
    expect(denied()).not.toBeNull()
    act(() => permissionsStore.set(READ_ALL_HOLDER))
    await settle(50)
    expect(screen.getByTestId('hours-entries-table')).not.toBeNull()
    expect(denied()).toBeNull()
  })

  it('a grant withdrawn while the page is open ends in the denial (the next permissions say so)', async () => {
    useApi()
    permissionsStore.set(READ_ALL_HOLDER)
    await renderPage()
    await screen.findByTestId('hours-entries-table')
    act(() => permissionsStore.set(EMPLOYEE))
    expect(await screen.findByTestId('hours-permission-denied')).not.toBeNull()
    expect(screen.queryByTestId('hours-entries-table')).toBeNull()
  })
})

describe('the server is the gate: a 403 read_all_required (AC-4.2)', () => {
  const cases: [string, string, Parameters<typeof fakeApi>[0]][] = [
    ['the entries', '/hours/all', { 'GET /time-entries': forbidden }],
    ['the totals', '/hours/all?group=project', { 'GET /time-entries/totals': totalsBy({ project: forbidden }) }],
    ['the people', '/hours/all?group=project', { 'GET /time-entries/totals': totalsBy({ person: forbidden }) }],
  ]

  it.each(cases)(
    'on %s replaces the view with the denial and a way back to My hours',
    async (_what, path, overrides) => {
      useApi(overrides)
      permissionsStore.set(READ_ALL_HOLDER)
      await renderPage(path)
      expect(await screen.findByTestId('hours-permission-denied')).not.toBeNull()
      expect(screen.getByRole('heading', { name: t.denied.title })).not.toBeNull()
      expect(screen.getByRole('link', { name: t.denied.back }).getAttribute('href')).toBe('/hours/')
      expect(screen.queryByTestId('hours-entries-table')).toBeNull()
      expect(screen.queryByTestId('hours-totals')).toBeNull()
      expect(screen.queryByTestId('hours-filters')).toBeNull()
    },
  )
})

describe('an authorization outage: 503 authz_unavailable (AC-5.4)', () => {
  const outage = {
    'GET /time-entries': authzDown,
    'GET /time-entries/totals': () => authzDown(),
  }

  it('is one warning, titled, saying one’s own hours are not affected, with Retry and a way to My hours', async () => {
    useApi(outage)
    permissionsStore.set(READ_ALL_HOLDER)
    await renderPage()
    const banner = await screen.findByTestId('hours-authz-unavailable')
    expect(banner.getAttribute('role')).toBe('alert')
    expect(banner.textContent).toContain(t.authUnavailable.title)
    expect(banner.textContent).toContain(t.authUnavailable.body)
    expect(t.authUnavailable.title).toBe('Authorization service unavailable')
    expect(t.authUnavailable.body).toContain('Your own hours are not affected.')
    expect(screen.getByRole('button', { name: strings.common.retry })).not.toBeNull()
    expect(screen.getByRole('link', { name: t.authUnavailable.back }).getAttribute('href')).toBe('/hours/')
  })

  it('replaces Totals and Entries, keeps the Filters card, and is never the denial, the empty state or "0 min"', async () => {
    useApi(outage)
    permissionsStore.set(READ_ALL_HOLDER)
    await renderPage()
    await screen.findByTestId('hours-authz-unavailable')
    expect(screen.getByTestId('hours-filters')).not.toBeNull()
    expect(screen.queryByTestId('hours-totals')).toBeNull()
    expect(screen.queryByTestId('hours-entries')).toBeNull()
    expect(screen.queryByTestId('hours-entries-empty')).toBeNull()
    expect(denied()).toBeNull()
    expect(screen.queryByText(/0 min/)).toBeNull()
  })

  it('does not take focus when it appears (the person is where they were)', async () => {
    useApi(outage)
    permissionsStore.set(READ_ALL_HOLDER)
    await renderPage()
    const banner = await screen.findByTestId('hours-authz-unavailable')
    expect(document.activeElement).not.toBe(banner)
  })

  it('Retry asks again; when it works the view appears and focus goes to the Totals heading', async () => {
    useApi({
      'GET /time-entries': sequence(authzDown, entriesHandler),
      'GET /time-entries/totals': sequence(authzDown, totalsWithPeople),
    })
    permissionsStore.set(READ_ALL_HOLDER)
    await renderPage()
    await screen.findByTestId('hours-authz-unavailable')
    await userEvent.click(screen.getByRole('button', { name: strings.common.retry }))
    expect(await screen.findByTestId('hours-entries-table')).not.toBeNull()
    expect(screen.queryByTestId('hours-authz-unavailable')).toBeNull()
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('heading', { name: strings.totals.title })),
    )
  })

  it('Retry that fails again brings the banner back and gives it focus (the button that had it is gone)', async () => {
    useApi(outage)
    permissionsStore.set(READ_ALL_HOLDER)
    await renderPage()
    await screen.findByTestId('hours-authz-unavailable')
    await userEvent.click(screen.getByRole('button', { name: strings.common.retry }))
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('hours-authz-unavailable')))
    expect(entriesCalls().length).toBeGreaterThanOrEqual(2)
  })

  it('Retry asks the entries, the totals and the people again, with the same filters', async () => {
    useApi(outage)
    permissionsStore.set(READ_ALL_HOLDER)
    await renderPage()
    await screen.findByTestId('hours-authz-unavailable')
    const before = { entries: entriesCalls().length, totals: totalsCalls().length }
    await userEvent.click(screen.getByRole('button', { name: strings.common.retry }))
    await waitFor(() => expect(entriesCalls().length).toBe(before.entries + 1))
    expect(totalsCalls().length).toBe(before.totals + 2)
  })

  it('only the people failing this way is soft: the rest works and the Person select says so', async () => {
    useApi({ 'GET /time-entries/totals': totalsBy({ person: authzDown }) })
    permissionsStore.set(READ_ALL_HOLDER)
    // Grouped by project, so the totals do not ask for the people's grouping: only the Person select does.
    await renderPage('/hours/all?group=project')
    await screen.findByTestId('hours-entries-table')
    expect(screen.queryByTestId('hours-authz-unavailable')).toBeNull()
    expect(denied()).toBeNull()
    expect(screen.getByText(f.person.error)).not.toBeNull()
  })
})

describe('every call carries whose=all (ADR-0075)', () => {
  it('the entries, the totals and the people are all asked as everyone’s, and never as the person’s own', async () => {
    useApi()
    permissionsStore.set(READ_ALL_HOLDER)
    await renderPage()
    await screen.findByTestId('hours-entries-table')
    await waitFor(() => expect(totalsCalls('person').length).toBeGreaterThan(0))
    const hours = hoursCalls().filter(([input]) => !String(input).includes('/time-lists'))
    expect(hours.length).toBeGreaterThanOrEqual(3)
    for (const request of [...entriesCalls(), ...totalsCalls()]) expect(request.query['whose']).toBe('all')
    expect(entriesCalls()[0]!.query).toEqual({ whose: 'all', from: '2026-11-01', to: '2026-11-30' })
  })
})
