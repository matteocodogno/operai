/**
 * @vitest-environment jsdom
 *
 * QueuePage (AC-1.1, AC-1.6, AC-2.1): the to-start queue lists the won deals no
 * project has taken — title, company, entity, won date and the estimate link —
 * with no amount; search and entity reach the query; a truncated list says so;
 * crm-api down is its own state. Rendered through the app's real router against
 * a fake projects-api. The queue is the server's computation, read live: a deal
 * reopened in the CRM or taken elsewhere is simply absent from the next read
 * (AC-2.1, AC-1.6), so the page keeps no list of its own.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { RouterProvider } from '@tanstack/react-router'
import { createAppRouter } from '../router'
import { fakeApi, problem, scope } from '../test-support/fakeApi'
import type { FakeHandler } from '../test-support/fakeApi'
import { scopeRoot } from '../test-support/scopeRoot'
import type { QueueItem, Scope } from '../lib/types'

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock('shell/session', () => ({
  apiFetch,
  getProjectsApiBaseUrl: () => 'http://projects-api.test',
  getAuthBaseUrl: () => 'http://auth.test',
  useSession: () => ({ data: { user: { id: 'u-ada', name: 'Ada Lovelace' } } }),
}))

const queueItem = (overrides: Partial<QueueItem> = {}): QueueItem => ({
  dealId: 'd1',
  title: 'Website relaunch',
  entity: 'welld_ch',
  company: { id: 'c1', name: 'Acme SA' },
  wonAt: '2026-10-20T12:00:00.000Z',
  estimate: { id: 'est-1', name: 'Relaunch estimate' },
  ...overrides,
})

const queue = (items: QueueItem[], truncated = false) => ({ status: 200, body: { items, truncated } })

const TAKER = scope({ take: ['welld_ch', 'welld_it'] })

const renderQueue = async (routes: Record<string, FakeHandler>, callerScope: Scope = TAKER) => {
  apiFetch.mockImplementation(fakeApi(routes))
  window.history.pushState(null, '', '/queue')
  render(<RouterProvider router={createAppRouter(undefined, scopeRoot(callerScope))} />)
  await screen.findByTestId('queue-page')
}

beforeEach(() => {
  window.scrollTo = () => undefined
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const queueUrls = () =>
  apiFetch.mock.calls.map(([input]) => new URL(String(input))).filter((url) => url.pathname === '/queue')
const lastQuery = () => Object.fromEntries(queueUrls().at(-1)!.searchParams)

describe('who may open the queue (AC-1.9, D37)', () => {
  const open = async (callerScope: Scope) => {
    apiFetch.mockImplementation(fakeApi({ 'GET /queue': () => queue([queueItem()]) }))
    window.history.pushState(null, '', '/queue')
    render(<RouterProvider router={createAppRouter(undefined, scopeRoot(callerScope))} />)
  }

  it.each<[string, Scope]>([
    ['a project manager (manages, takes nothing)', scope({ manage: ['welld_ch'] })],
    ['an ops-manager (manages, oversees, takes nothing)', scope({ manage: ['welld_ch'], oversees: true })],
    ['accounting (Bexio only)', scope({ bexio: true })],
    ['a reader', scope()],
  ])('%s gets the permission-denied state, never the queue, and the API is not asked', async (_name, callerScope) => {
    await open(callerScope)
    expect(await screen.findByTestId('projects-permission-denied')).not.toBeNull()
    expect(screen.queryByTestId('queue-page')).toBeNull()
    expect(screen.queryByTestId('queue-table')).toBeNull()
    expect(apiFetch).not.toHaveBeenCalled()
  })

  it('a caller whose scope.take is non-empty gets the queue', async () => {
    await open(scope({ take: ['welld_it'] }))
    expect(await screen.findByTestId('queue-table')).not.toBeNull()
    expect(screen.queryByTestId('projects-permission-denied')).toBeNull()
    expect(queueUrls()).toHaveLength(1)
  })
})

describe('QueuePage list (AC-1.1)', () => {
  it('shows title, company, entity, won date and the estimate link of each deal', async () => {
    await renderQueue({ 'GET /queue': () => queue([queueItem()]) })
    const table = await screen.findByTestId('queue-table')
    const row = within(table)
      .getByRole('rowheader', { name: /Website relaunch/ })
      .closest('tr')!
    expect(row.textContent).toContain('Acme SA')
    expect(row.textContent).toContain('wellD CH')
    expect(row.textContent).toContain('20.10.2026')
    const estimate = within(row).getByRole('link', { name: /Relaunch estimate/ })
    expect(estimate.getAttribute('href')).toBe('/estimai/estimates/est-1')
    expect(within(row).getByRole('link', { name: 'Website relaunch' }).getAttribute('href')).toBe('/crm/deals/d1')
  })

  it('shows no estimate link for a deal without an estimate', async () => {
    await renderQueue({ 'GET /queue': () => queue([queueItem({ estimate: null })]) })
    const table = await screen.findByTestId('queue-table')
    expect(within(table).queryByRole('link', { name: /estimate/i })).toBeNull()
  })

  it('renders no amount: not a column, not a figure (D14)', async () => {
    // The API sends none; a stray field must still never reach the screen.
    const withAmount = { ...queueItem(), amount: 48250, currency: 'CHF' }
    await renderQueue({ 'GET /queue': () => queue([withAmount]) })
    const table = await screen.findByTestId('queue-table')
    expect(table.textContent).not.toMatch(/48.?250|CHF/)
    expect(within(table).queryByRole('columnheader', { name: /amount|value|price/i })).toBeNull()
  })

  it('names the company as unavailable when the CRM could not', async () => {
    await renderQueue({ 'GET /queue': () => queue([queueItem({ company: { id: 'c1', name: null } })]) })
    const table = await screen.findByTestId('queue-table')
    expect(table.textContent).toContain('Company unavailable')
  })

  it('shows the empty state when no won deal is waiting', async () => {
    await renderQueue({ 'GET /queue': () => queue([]) })
    expect(await screen.findByText('Nothing waiting to start')).not.toBeNull()
    expect(screen.queryByTestId('queue-table')).toBeNull()
  })

  it('shows the loading state while the queue loads', async () => {
    await renderQueue({ 'GET /queue': () => new Promise(() => undefined) })
    expect(screen.getByRole('status').textContent).toBe('Loading the deals to start…')
  })
})

describe('QueuePage filters', () => {
  it('asks for the whole queue first, then search and entity reach the query', async () => {
    await renderQueue({ 'GET /queue': () => queue([queueItem()]) })
    await screen.findByTestId('queue-table')
    expect(lastQuery()).toEqual({})

    fireEvent.change(screen.getByRole('searchbox', { name: /search/i }), { target: { value: 'relaunch' } })
    await waitFor(() => expect(lastQuery()).toEqual({ q: 'relaunch' }))

    fireEvent.change(screen.getByRole('combobox', { name: 'Entity' }), { target: { value: 'welld_it' } })
    await waitFor(() => expect(lastQuery()).toEqual({ q: 'relaunch', entity: 'welld_it' }))
  })

  it('says nothing matched, not that nothing is waiting, when a filter empties the list', async () => {
    await renderQueue({
      'GET /queue': (url) => queue(url.searchParams.get('q') ? [] : [queueItem()]),
    })
    await screen.findByTestId('queue-table')
    fireEvent.change(screen.getByRole('searchbox', { name: /search/i }), { target: { value: 'zzz' } })
    expect(await screen.findByText('No deal matches these filters')).not.toBeNull()
    expect(screen.queryByText('Nothing waiting to start')).toBeNull()
  })
})

describe('QueuePage limits and failures', () => {
  it('says "showing the newest 500" when the list is truncated (A26)', async () => {
    await renderQueue({ 'GET /queue': () => queue([queueItem()], true) })
    expect((await screen.findByTestId('queue-truncated')).textContent).toContain('showing the newest 500')
  })

  it('does not say it when the list is complete', async () => {
    await renderQueue({ 'GET /queue': () => queue([queueItem()]) })
    await screen.findByTestId('queue-table')
    expect(screen.queryByTestId('queue-truncated')).toBeNull()
  })

  it('crm-api down is the crm-unavailable state with a retry, never an empty queue', async () => {
    let calls = 0
    await renderQueue({
      'GET /queue': () => {
        calls += 1
        return calls === 1 ? problem(503, 'crm_unavailable') : queue([queueItem()])
      },
    })
    const banner = await screen.findByTestId('queue-crm-unavailable')
    expect(banner.textContent).toContain('The CRM cannot be reached')
    expect(screen.queryByText('Nothing waiting to start')).toBeNull()
    expect(screen.queryByTestId('projects-load-error')).toBeNull()
    fireEvent.click(within(banner).getByRole('button', { name: 'Retry' }))
    expect(await screen.findByTestId('queue-table')).not.toBeNull()
  })

  it('another failure keeps the generic retry banner', async () => {
    await renderQueue({ 'GET /queue': () => problem(500, undefined, {}, 'boom') })
    expect((await screen.findByTestId('projects-load-error')).textContent).toContain('boom')
    expect(screen.queryByTestId('queue-crm-unavailable')).toBeNull()
  })

  it('a 403 shows PermissionDenied', async () => {
    await renderQueue({ 'GET /queue': () => problem(403, 'forbidden') })
    expect(await screen.findByTestId('projects-permission-denied')).not.toBeNull()
  })
})
