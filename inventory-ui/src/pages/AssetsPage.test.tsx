/**
 * @vitest-environment jsdom
 *
 * Page tests for AssetsPage (T29, specs/015-hardware-inventory; design.md § T1
 * Assets list, F7; refs AC-3.7, AC-3.8, AC-10.3, AC-12.10).
 *
 * A real TanStack Router on a memory history, so "each control updates the URL"
 * is asserted on the router's own location, and `assetsApi` / `scopeApi` /
 * `directoryApi` / `usePermissions` mocked at their seams, so "and the request"
 * is asserted on what `listAssets` was called with.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router'
import type { Permission } from 'shell/session'
import { ApiError } from '../lib/api'
import type { AssetListItem, AssetListPage, Entity } from '../lib/types'

const { usePermissions, listAssets, getScope, listDirectory } = vi.hoisted(() => ({
  usePermissions: vi.fn(),
  listAssets: vi.fn(),
  getScope: vi.fn(),
  listDirectory: vi.fn(),
}))
vi.mock('shell/session', () => ({ usePermissions }))
vi.mock('../lib/assetsApi', () => ({ listAssets }))
vi.mock('../lib/scopeApi', () => ({ getScope }))
vi.mock('../lib/directoryApi', () => ({ listDirectory }))

import AssetsPage from './AssetsPage'

const ASSETS: Permission = { resource: 'asset', action: 'manage' }
const LEDGER: Permission = { resource: 'ledger', action: 'manage' }

const asset = (over: Partial<AssetListItem> = {}): AssetListItem => ({
  id: 'a1',
  entity: 'welld_ch',
  currency: 'CHF',
  category: 'laptop',
  description: 'MacBook Pro 14',
  serialNumber: 'SN123',
  purchaseDate: '2026-09-25',
  purchasePriceCents: 99815,
  status: 'assigned',
  holder: { id: 'u1', name: 'Anna Rossi', status: 'active' },
  pendingAssignment: null,
  locationNote: null,
  supplier: null,
  invoiceRef: 'INV-77',
  invoiceFile: null,
  toVerify: false,
  disposal: null,
  ...over,
})

const page = (items: AssetListItem[], nextCursor: string | null = null): AssetListPage => ({ items, nextCursor })

const asUser = (permissions: Permission[], scope: { asset: Entity[]; ledger: Entity[] }) => {
  usePermissions.mockReturnValue({ epoch: 0, apps: ['inventory'], roles: [], departments: [], permissions })
  getScope.mockResolvedValue(scope)
}

beforeEach(() => {
  asUser([ASSETS, LEDGER], { asset: ['welld_ch'], ledger: ['welld_ch'] })
  listAssets.mockResolvedValue(page([asset()]))
  listDirectory.mockResolvedValue({
    users: [{ id: 'u1', name: 'Anna Rossi', email: 'anna@welld.ch', entity: 'welld_ch' }],
  })
  window.scrollTo = () => undefined
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const renderPage = async (url = '/assets', state?: Record<string, unknown>) => {
  const history = createMemoryHistory({ initialEntries: [url] })
  if (state) history.replace(url, state)
  const rootRoute = createRootRoute()
  const route = (path: string, component: () => React.ReactNode) =>
    createRoute({ getParentRoute: () => rootRoute, path, component })
  const routeTree = rootRoute.addChildren([
    route('/assets', AssetsPage),
    route('/assets/new', () => <p>register page</p>),
    route('/assets/$id', () => <p>detail page</p>),
  ])
  const router = createRouter({ routeTree, history })
  render(<RouterProvider router={router} />)
  await screen.findByRole('heading', { level: 2, name: 'Assets' })
  return router
}

const lastFilters = () => listAssets.mock.calls.at(-1)![0] as Record<string, unknown>

describe('loading and the rows', () => {
  it('shows a skeleton and a polite "Loading assets" line until the first page arrives', async () => {
    listAssets.mockReturnValue(new Promise(() => undefined))
    await renderPage()

    expect(screen.getByTestId('skeleton-list-rows')).not.toBeNull()
    expect(screen.getByTestId('assets-loading').getAttribute('aria-live')).toBe('polite')
    expect(screen.getByTestId('assets-loading').textContent).toBe('Loading assets')
  })

  it('renders each asset as a row with its description linking to the detail page', async () => {
    listAssets.mockResolvedValue(
      page([
        asset({ toVerify: true }),
        asset({
          id: 'a2',
          description: 'Dell U2723QE',
          status: 'in_stock',
          holder: null,
          serialNumber: null,
          invoiceRef: null,
        }),
      ]),
    )
    await renderPage()

    const link = await screen.findByRole('link', { name: 'MacBook Pro 14' })
    expect(link.getAttribute('href')).toBe('/assets/a1')
    const row = link.closest('tr')!
    expect(within(row).getByText(/Laptop/)).not.toBeNull()
    expect(within(row).getByText(/SN123/)).not.toBeNull()
    expect(within(row).getByText(/INV-77/)).not.toBeNull()
    expect(within(row).getByText('To verify')).not.toBeNull()
    expect(within(row).getByTestId('asset-status-badge').getAttribute('data-status')).toBe('assigned')
    expect(within(row).getByText('Anna Rossi')).not.toBeNull()
    expect(within(row).getByText('25.09.2026')).not.toBeNull()
    expect(within(row).getByText('998,15 CHF')).not.toBeNull()
    const second = screen.getByRole('link', { name: 'Dell U2723QE' }).closest('tr')!
    expect(within(second).queryByText('To verify')).toBeNull()
  })

  it('marks an in_stock asset with a pending assignment "Awaiting confirmation"', async () => {
    listAssets.mockResolvedValue(
      page([
        asset({
          status: 'in_stock',
          holder: null,
          pendingAssignment: {
            id: 'p1',
            assignee: { id: 'u2', name: 'Bob', status: 'active' },
            createdAt: '2026-10-01T10:00:00Z',
          },
        }),
      ]),
    )
    await renderPage()

    expect(await screen.findByText('Awaiting confirmation')).not.toBeNull()
  })

  it('announces how many assets are shown, and that more are available', async () => {
    listAssets.mockResolvedValue(page([asset(), asset({ id: 'a2' })], 'cur2'))
    await renderPage()

    await waitFor(() =>
      expect(screen.getByTestId('assets-count').textContent).toBe('Showing 2 assets - more available'),
    )
    expect(screen.getByTestId('assets-count').getAttribute('role')).toBe('status')
  })

  it('names the table, with the active filters, in its caption', async () => {
    await renderPage('/assets?status=assigned&toVerify=true')

    const table = await screen.findByRole('table')
    expect(within(table).getByText(/^Assets, filtered by/).textContent).toContain('Status Assigned')
    expect(within(table).getByText(/^Assets, filtered by/).textContent).toContain('to verify')
  })
})

describe('capability and scope gating', () => {
  it('manager only: Register asset and the holder filter present, no book value column', async () => {
    asUser([ASSETS], { asset: ['welld_ch'], ledger: [] })
    await renderPage()
    await screen.findByRole('table')

    expect(screen.getByRole('link', { name: 'Register asset' }).getAttribute('href')).toBe('/assets/new')
    expect(screen.getByLabelText('Holder')).not.toBeNull()
    expect(screen.queryByRole('columnheader', { name: 'Book value' })).toBeNull()
    expect(listDirectory).toHaveBeenCalledTimes(1)
  })

  it('accountant only: book value column from ledger.bookValueCents, no Register, no holder filter, no directory call', async () => {
    asUser([LEDGER], { asset: [], ledger: ['welld_ch'] })
    listAssets.mockResolvedValue(page([asset({ ledger: { bookValueCents: 55000 } })]))
    await renderPage()
    await screen.findByRole('table')

    expect(screen.queryByRole('link', { name: 'Register asset' })).toBeNull()
    expect(screen.queryByLabelText('Holder')).toBeNull()
    expect(screen.getByRole('columnheader', { name: 'Book value' })).not.toBeNull()
    expect(screen.getByText('550,00 CHF')).not.toBeNull()
    expect(listDirectory).not.toHaveBeenCalled()
  })

  it('never sends a holder filter the caller may not use', async () => {
    asUser([LEDGER], { asset: [], ledger: ['welld_ch'] })
    await renderPage('/assets?holderUserId=u1')
    await screen.findByRole('table')

    expect(lastFilters()).not.toHaveProperty('holderUserId')
  })

  it('shows the Entity column and filter only with two entities in scope', async () => {
    await renderPage()
    await screen.findByRole('table')
    expect(screen.queryByRole('columnheader', { name: 'Entity' })).toBeNull()
    expect(screen.queryByLabelText('Entity')).toBeNull()
    cleanup()

    asUser([ASSETS, LEDGER], { asset: ['welld_ch', 'welld_it'], ledger: ['welld_ch'] })
    await renderPage()
    await screen.findByRole('table')
    expect(screen.getByRole('columnheader', { name: 'Entity' })).not.toBeNull()
    expect(screen.getByLabelText('Entity')).not.toBeNull()
  })
})

describe('filters live in the URL and drive the request (AC-3.7, AC-3.8, AC-10.3, AC-12.10)', () => {
  it('reads the initial filters from the URL into the first request', async () => {
    await renderPage('/assets?status=assigned&category=laptop&toVerify=true&invoiceRef=INV-77&q=mac')
    await screen.findByRole('table')

    expect(lastFilters()).toMatchObject({
      status: 'assigned',
      category: 'laptop',
      toVerify: true,
      invoiceRef: 'INV-77',
      q: 'mac',
    })
    expect((screen.getByLabelText('Status') as HTMLSelectElement).value).toBe('assigned')
    expect((screen.getByLabelText('Search') as HTMLInputElement).value).toBe('mac')
  })

  it('ignores a status or category that is not one of the known values', async () => {
    await renderPage('/assets?status=bogus&category=toaster&entity=mars')
    await screen.findByRole('table')

    const filters = lastFilters()
    expect(filters).not.toHaveProperty('status')
    expect(filters).not.toHaveProperty('category')
    expect(filters).not.toHaveProperty('entity')
  })

  it('status, category, holder and "to verify" each update the URL and the request', async () => {
    const router = await renderPage()
    await screen.findByRole('table')

    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'in_repair' } })
    await waitFor(() => expect(lastFilters()).toMatchObject({ status: 'in_repair' }))
    expect(router.state.location.search).toMatchObject({ status: 'in_repair' })

    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'monitor' } })
    await waitFor(() => expect(lastFilters()).toMatchObject({ status: 'in_repair', category: 'monitor' }))
    expect(router.state.location.search).toMatchObject({ category: 'monitor' })

    await screen.findByRole('option', { name: 'Anna Rossi (anna@welld.ch)' })
    fireEvent.change(screen.getByLabelText('Holder'), { target: { value: 'u1' } })
    await waitFor(() => expect(lastFilters()).toMatchObject({ holderUserId: 'u1' }))
    expect(router.state.location.search).toMatchObject({ holderUserId: 'u1' })

    fireEvent.click(screen.getByLabelText('To verify'))
    await waitFor(() => expect(lastFilters()).toMatchObject({ toVerify: true }))
    expect(router.state.location.search).toMatchObject({ toVerify: true })
  })

  it('the entity filter updates the URL and the request', async () => {
    asUser([ASSETS, LEDGER], { asset: ['welld_ch', 'welld_it'], ledger: [] })
    const router = await renderPage()
    await screen.findByRole('table')

    fireEvent.change(screen.getByLabelText('Entity'), { target: { value: 'welld_it' } })
    await waitFor(() => expect(lastFilters()).toMatchObject({ entity: 'welld_it' }))
    expect(router.state.location.search).toMatchObject({ entity: 'welld_it' })
  })

  it('the search input is debounced: one request, after the pause, with the text in the URL', async () => {
    const router = await renderPage()
    await screen.findByRole('table')
    const callsBefore = listAssets.mock.calls.length

    const search = screen.getByLabelText('Search')
    fireEvent.change(search, { target: { value: 'm' } })
    fireEvent.change(search, { target: { value: 'mac' } })
    expect(listAssets.mock.calls.length).toBe(callsBefore)

    await waitFor(() => expect(lastFilters()).toMatchObject({ q: 'mac' }))
    expect(listAssets.mock.calls.length).toBe(callsBefore + 1)
    expect(router.state.location.search).toMatchObject({ q: 'mac' })
  })

  it('the invoice reference applies on Enter', async () => {
    const router = await renderPage()
    await screen.findByRole('table')

    const input = screen.getByLabelText('Invoice reference')
    fireEvent.change(input, { target: { value: 'INV-9' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(lastFilters()).toMatchObject({ invoiceRef: 'INV-9' }))
    expect(router.state.location.search).toMatchObject({ invoiceRef: 'INV-9' })
  })

  it('clearing a filter removes it from the URL and the request', async () => {
    const router = await renderPage('/assets?status=lost')
    await screen.findByRole('table')

    fireEvent.change(screen.getByLabelText('Status'), { target: { value: '' } })
    await waitFor(() => expect(lastFilters()).not.toHaveProperty('status'))
    expect(router.state.location.search).not.toHaveProperty('status')
  })

  it('shows only the latest answer when an older request resolves late', async () => {
    let resolveFirst: (value: AssetListPage) => void = () => undefined
    listAssets.mockReturnValueOnce(new Promise<AssetListPage>((resolve) => (resolveFirst = resolve)))
    listAssets.mockResolvedValue(page([asset({ id: 'new', description: 'Newest answer' })]))
    await renderPage()

    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'lost' } })
    await screen.findByRole('link', { name: 'Newest answer' })
    resolveFirst(page([asset({ id: 'old', description: 'Stale answer' })]))
    await Promise.resolve()

    expect(screen.queryByRole('link', { name: 'Stale answer' })).toBeNull()
    expect(screen.getByRole('link', { name: 'Newest answer' })).not.toBeNull()
  })
})

describe('empty states', () => {
  it('nothing registered, manager: "No assets yet." with a Register asset action and the scope note', async () => {
    asUser([ASSETS], { asset: ['welld_ch'], ledger: [] })
    listAssets.mockResolvedValue(page([]))
    await renderPage()

    expect(await screen.findByText('No assets yet.')).not.toBeNull()
    expect(screen.getByText('Assets of an entity you are not scoped to are not shown.')).not.toBeNull()
    expect(screen.getAllByRole('link', { name: 'Register asset' }).length).toBeGreaterThanOrEqual(1)
  })

  it('nothing registered, accountant only: "No assets in your scope yet." and no Register action anywhere', async () => {
    asUser([LEDGER], { asset: [], ledger: ['welld_ch'] })
    listAssets.mockResolvedValue(page([]))
    await renderPage()

    expect(await screen.findByText('No assets in your scope yet.')).not.toBeNull()
    expect(screen.queryByRole('link', { name: 'Register asset' })).toBeNull()
    expect(screen.getByText('Assets of an entity you are not scoped to are not shown.')).not.toBeNull()
  })

  it('empty after filters: "No assets match these filters." and Clear filters resets URL and request', async () => {
    listAssets.mockResolvedValue(page([]))
    const router2 = await renderPage('/assets?status=lost&q=zzz')

    expect(await screen.findByText('No assets match these filters.')).not.toBeNull()
    listAssets.mockResolvedValue(page([asset()]))
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }))

    await waitFor(() => expect(lastFilters()).not.toHaveProperty('status'))
    expect(lastFilters()).not.toHaveProperty('q')
    expect(router2.state.location.search).toEqual({})
    await screen.findByRole('link', { name: 'MacBook Pro 14' })
    expect((screen.getByLabelText('Search') as HTMLInputElement).value).toBe('')
  })

  it('"To verify" filter with nothing left: the positive copy "Nothing left to verify."', async () => {
    listAssets.mockResolvedValue(page([]))
    await renderPage('/assets?toVerify=true')

    expect(await screen.findByText('Nothing left to verify.')).not.toBeNull()
    expect(screen.queryByText('No assets match these filters.')).toBeNull()
  })

  it('"To verify" combined with another filter is an ordinary filtered-empty, not a claim that nothing is left', async () => {
    listAssets.mockResolvedValue(page([]))
    await renderPage('/assets?toVerify=true&status=lost')

    expect(await screen.findByText('No assets match these filters.')).not.toBeNull()
    expect(screen.queryByText('Nothing left to verify.')).toBeNull()
  })
})

describe('failures', () => {
  it('a failed fetch shows an alert with the problem detail and Retry reloads', async () => {
    listAssets.mockRejectedValueOnce(new ApiError({ status: 500, title: 'Boom', detail: 'The database is down.' }))
    await renderPage()

    const banner = await screen.findByTestId('error-banner')
    expect(banner.getAttribute('role')).toBe('alert')
    expect(banner.textContent).toContain('The database is down.')

    fireEvent.click(screen.getByTestId('error-banner-retry'))
    await screen.findByRole('link', { name: 'MacBook Pro 14' })
    expect(screen.queryByTestId('error-banner')).toBeNull()
  })

  it('a network failure shows the generic connection message', async () => {
    listAssets.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await renderPage()

    expect((await screen.findByTestId('error-banner')).textContent).toContain('Could not reach the server')
  })

  it('503 renders the "Authorization service unavailable" variant with Retry', async () => {
    listAssets.mockRejectedValueOnce(new ApiError({ status: 503, title: 'Unavailable' }))
    await renderPage()

    expect((await screen.findByTestId('error-banner-heading')).textContent).toBe('Authorization service unavailable')
    expect(screen.getByTestId('error-banner-retry')).not.toBeNull()
  })

  it('403 renders PermissionDenied with no Retry', async () => {
    listAssets.mockRejectedValueOnce(new ApiError({ status: 403, title: 'Forbidden' }))
    await renderPage()

    expect(await screen.findByTestId('permission-denied')).not.toBeNull()
    expect(screen.queryByTestId('error-banner-retry')).toBeNull()
  })

  it('a rate-limited directory (429) says how long to wait, in the list area, and the list still works', async () => {
    listDirectory.mockRejectedValueOnce(new ApiError({ status: 429, title: 'Slow down', retryAfterSeconds: 12 }))
    await renderPage()

    expect((await screen.findByTestId('directory-error')).textContent).toContain('Try again in 12 seconds.')
    expect(screen.getByRole('link', { name: 'MacBook Pro 14' })).not.toBeNull()
  })
})

describe('Load more', () => {
  it('appends the next page with the cursor, keeps focus on the button and announces the count', async () => {
    listAssets.mockResolvedValueOnce(page([asset()], 'cur2'))
    listAssets.mockResolvedValueOnce(
      page([asset({ id: 'a2', description: 'Second' }), asset({ id: 'a3', description: 'Third' })], 'cur3'),
    )
    await renderPage()

    const button = await screen.findByRole('button', { name: 'Load more' })
    button.focus()
    fireEvent.click(button)

    await screen.findByRole('link', { name: 'Third' })
    expect(listAssets.mock.calls.at(-1)![0]).toMatchObject({ cursor: 'cur2' })
    expect(screen.getByRole('link', { name: 'MacBook Pro 14' })).not.toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Load more' }))
    expect(screen.getByTestId('load-more').textContent).toContain('2 more assets loaded')
    expect(screen.getByTestId('assets-count').textContent).toBe('Showing 3 assets - more available')
  })

  it('on the last page the button is removed and focus moves to the last loaded row link', async () => {
    listAssets.mockResolvedValueOnce(page([asset()], 'cur2'))
    listAssets.mockResolvedValueOnce(page([asset({ id: 'a2', description: 'Last one' })], null))
    await renderPage()

    const button = await screen.findByRole('button', { name: 'Load more' })
    button.focus()
    fireEvent.click(button)

    const last = await screen.findByRole('link', { name: 'Last one' })
    await waitFor(() => expect(document.activeElement).toBe(last))
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull()
    expect(screen.getByTestId('load-more').textContent).toContain('1 more asset loaded')
    expect(screen.getByTestId('assets-count').textContent).toBe('Showing 2 assets')
  })

  it('does not duplicate a row the next page repeats', async () => {
    listAssets.mockResolvedValueOnce(page([asset()], 'cur2'))
    listAssets.mockResolvedValueOnce(page([asset(), asset({ id: 'a2', description: 'Second' })], null))
    await renderPage()

    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }))
    await screen.findByRole('link', { name: 'Second' })

    expect(screen.getAllByRole('link', { name: 'MacBook Pro 14' })).toHaveLength(1)
  })

  it('a failed load shows an inline alert, keeps the rows and leaves the button as the retry', async () => {
    listAssets.mockResolvedValueOnce(page([asset()], 'cur2'))
    listAssets.mockRejectedValueOnce(new ApiError({ status: 500, title: 'Boom', detail: 'Next page failed.' }))
    await renderPage()

    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }))

    expect((await screen.findByText('Next page failed.')).getAttribute('role')).toBe('alert')
    expect(screen.getByRole('link', { name: 'MacBook Pro 14' })).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Load more' })).not.toBeNull()
  })

  it('drops the appended rows when a filter changes', async () => {
    listAssets.mockResolvedValueOnce(page([asset()], 'cur2'))
    listAssets.mockResolvedValueOnce(page([asset({ id: 'a2', description: 'Second' })], null))
    await renderPage()
    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }))
    await screen.findByRole('link', { name: 'Second' })

    listAssets.mockResolvedValue(page([asset({ id: 'z', description: 'Filtered' })]))
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'lost' } })

    await screen.findByRole('link', { name: 'Filtered' })
    expect(screen.queryByRole('link', { name: 'Second' })).toBeNull()
    expect(screen.queryByRole('link', { name: 'MacBook Pro 14' })).toBeNull()
  })
})

describe('keyboard path', () => {
  it('Register asset comes before the search input, which comes before the filters and the table links', async () => {
    await renderPage()
    await screen.findByRole('table')

    const focusable = Array.from(document.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea'))
    const index = (el: HTMLElement) => focusable.indexOf(el)
    const register = screen.getByRole('link', { name: 'Register asset' })
    const search = screen.getByLabelText('Search')
    expect(index(register)).toBeLessThan(index(search))
    expect(index(search)).toBeLessThan(index(screen.getByLabelText('Status')))
    expect(index(search)).toBeLessThan(index(screen.getByLabelText('Invoice reference')))
    expect(index(screen.getByLabelText('Invoice reference'))).toBeLessThan(
      index(screen.getByRole('link', { name: 'MacBook Pro 14' })),
    )
  })
})

describe('arriving from the register page', () => {
  it('announces how many assets were just registered', async () => {
    await renderPage('/assets?invoiceRef=INV-77', { registeredCount: 13 })

    expect((await screen.findByTestId('assets-flash')).textContent).toBe('13 assets registered.')
    expect(screen.getByTestId('assets-flash').getAttribute('role')).toBe('status')
  })

  it('puts focus on the Register asset button when the register form was cancelled', async () => {
    await renderPage('/assets', { focusRegister: true })

    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('link', { name: 'Register asset' })))
  })
})
