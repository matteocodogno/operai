/**
 * @vitest-environment jsdom
 *
 * Page tests for AssetDetailPage (T32, specs/015-hardware-inventory; design.md
 * § T2 Asset detail, F6, § Accessibility "T2 detail"; refs AC-1.9, AC-3.6,
 * AC-10.1).
 *
 * The four region components are replaced by recording fakes: this file tests
 * the FRAME (what is present for which capability, the page-owned status line,
 * heading focus and refresh seams, the edit entry) and stays valid while T33-T36
 * fill the regions. `assetsApi` and `usePermissions` are the data seams.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router'
import type { Permission } from 'shell/session'
import { ApiError } from '../lib/api'
import type { AssetView } from '../lib/types'

const { usePermissions, getAsset, updateAsset } = vi.hoisted(() => ({
  usePermissions: vi.fn(),
  getAsset: vi.fn(),
  updateAsset: vi.fn(),
}))
vi.mock('shell/session', () => ({ usePermissions }))
vi.mock('../lib/assetsApi', () => ({ getAsset, updateAsset }))

type RegionProps = {
  asset: AssetView
  capabilities: { canManageAssets: boolean; canManageLedger: boolean }
  onChanged: (updated: AssetView | null) => void
  announce: (message: string) => void
  focusHeading: () => void
  revision?: number
}

/** One fake per region: marks its presence, echoes its capability props and exposes the page's seams as buttons. */
const { fake } = await vi.hoisted(async () => {
  const { createElement: h } = await import('react')
  const fakeRegion = (testId: string) =>
    function Fake(props: RegionProps) {
      const button = (label: string, onClick: () => void) => h('button', { onClick }, `${testId} ${label}`)
      return h(
        'div',
        {
          'data-testid': testId,
          'data-caps': `${props.capabilities.canManageAssets}/${props.capabilities.canManageLedger}`,
        },
        h('span', { 'data-testid': `${testId}-asset` }, props.asset.description),
        h('span', { 'data-testid': `${testId}-revision` }, props.revision),
        button('changed', () => props.onChanged({ ...props.asset, description: 'Renamed laptop' })),
        button('refresh', () => props.onChanged(null)),
        button('announce', () => {
          props.announce('Did the thing.')
          props.focusHeading()
        }),
      )
    }
  return { fake: fakeRegion }
})
vi.mock('../components/AssetActions', () => ({ default: fake('region-actions') }))
vi.mock('../components/LedgerBlock', () => ({ default: fake('region-ledger') }))
vi.mock('../components/InvoiceFilePanel', () => ({ default: fake('region-invoice') }))
vi.mock('../components/HistoryTimeline', () => ({ default: fake('region-history') }))

import AssetDetailPage from './AssetDetailPage'

const ASSETS: Permission = { resource: 'asset', action: 'manage' }
const LEDGER: Permission = { resource: 'ledger', action: 'manage' }

const asset = (over: Partial<AssetView> = {}): AssetView => ({
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
  locationNote: 'Zurich office, shelf 3',
  supplier: 'Digitec',
  invoiceRef: 'INV-77',
  invoiceFile: null,
  toVerify: false,
  disposal: null,
  ...over,
})

const asUser = (permissions: Permission[]) =>
  usePermissions.mockReturnValue({ epoch: 0, apps: ['inventory'], roles: [], departments: [], permissions })

beforeEach(() => {
  asUser([ASSETS, LEDGER])
  getAsset.mockResolvedValue(asset())
  window.scrollTo = () => undefined
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const renderPage = async (state?: Record<string, unknown>, { settle = true } = {}) => {
  const url = '/assets/a1'
  const history = createMemoryHistory({ initialEntries: [url] })
  if (state) history.replace(url, state)
  const rootRoute = createRootRoute()
  const route = (path: string, component: () => React.ReactNode) =>
    createRoute({ getParentRoute: () => rootRoute, path, component })
  const routeTree = rootRoute.addChildren([
    route('/assets', () => <p>list page</p>),
    route('/assets/$id', AssetDetailPage),
  ])
  const router = createRouter({ routeTree, history })
  render(<RouterProvider router={router} />)
  if (settle) await screen.findByRole('heading', { level: 2, name: 'MacBook Pro 14' })
  return router
}

describe('loading, not found and failures', () => {
  it('shows a skeleton and a polite loading line while the asset loads', async () => {
    getAsset.mockReturnValue(new Promise(() => undefined))
    await renderPage(undefined, { settle: false })

    expect(await screen.findByTestId('skeleton-list-rows')).not.toBeNull()
    expect(screen.getByTestId('asset-loading').getAttribute('aria-live')).toBe('polite')
    expect(screen.getByTestId('asset-loading').textContent).toBe('Loading asset')
    expect(screen.queryByTestId('region-history')).toBeNull()
  })

  it('requests the asset named by the route', async () => {
    await renderPage()
    expect(getAsset.mock.calls[0][0]).toBe('a1')
  })

  it('a 404 shows "Asset not found" with a way back to the list and no regions', async () => {
    getAsset.mockRejectedValue(new ApiError({ status: 404, title: 'Not Found' }))
    await renderPage(undefined, { settle: false })

    expect(await screen.findByRole('heading', { name: 'Asset not found' })).not.toBeNull()
    expect(screen.getByRole('link', { name: 'Back to assets' }).getAttribute('href')).toBe('/assets')
    expect(screen.queryByTestId('region-history')).toBeNull()
    expect(screen.queryByTestId('region-invoice')).toBeNull()
  })

  it('a 403 shows PermissionDenied', async () => {
    getAsset.mockRejectedValue(new ApiError({ status: 403, title: 'Forbidden' }))
    await renderPage(undefined, { settle: false })

    expect(await screen.findByTestId('permission-denied')).not.toBeNull()
  })

  it('a 503 shows the authorization-unavailable banner, and Retry loads the asset', async () => {
    getAsset.mockRejectedValueOnce(new ApiError({ status: 503, title: 'Unavailable' }))
    await renderPage(undefined, { settle: false })

    expect((await screen.findByTestId('error-banner-heading')).textContent).toBe('Authorization service unavailable')
    fireEvent.click(screen.getByTestId('error-banner-retry'))
    await screen.findByRole('heading', { level: 2, name: 'MacBook Pro 14' })
    expect(screen.queryByTestId('error-banner')).toBeNull()
  })

  it('a network failure shows the connection message with Retry', async () => {
    getAsset.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await renderPage(undefined, { settle: false })

    expect((await screen.findByTestId('error-banner')).textContent).toContain('Could not reach the server')
    expect(screen.getByTestId('error-banner-retry')).not.toBeNull()
  })

  it('any other API failure shows its detail', async () => {
    getAsset.mockRejectedValueOnce(new ApiError({ status: 500, title: 'Boom', detail: 'The server is down.' }))
    await renderPage(undefined, { settle: false })

    expect((await screen.findByTestId('error-banner')).textContent).toContain('The server is down.')
  })
})

describe('the summary (AC-3.6)', () => {
  it('shows the description as the page heading, the status, entity and currency', async () => {
    await renderPage()

    const header = screen.getByTestId('asset-header')
    expect(within(header).getByRole('heading', { level: 2 }).textContent).toBe('MacBook Pro 14')
    expect(within(header).getByTestId('asset-status-badge').textContent).toContain('Assigned')
    expect(within(header).getByTestId('entity-badge').textContent).toContain('WellD CH')
    expect(within(header).getByTestId('currency-badge').textContent).toContain('CHF')
  })

  it('shows the facts, with the price as money and the free-text location note', async () => {
    await renderPage()

    const facts = screen.getByTestId('asset-facts')
    const value = (label: string) => within(facts).getByText(label).closest('div')!.querySelector('dd')!.textContent
    expect(value('Category')).toBe('Laptop')
    expect(value('Serial number')).toBe('SN123')
    expect(value('Purchase date')).toBe('25.09.2026')
    expect(value('Purchase price')).toBe('998,15 CHF')
    expect(value('Held by')).toBe('Anna Rossi')
    expect(value('Location / note')).toBe('Zurich office, shelf 3')
    expect(value('Supplier')).toBe('Digitec')
  })

  it('shows a dash for an absent serial, location and supplier, and "Deleted account" for a deleted holder', async () => {
    getAsset.mockResolvedValue(
      asset({
        serialNumber: null,
        locationNote: null,
        supplier: null,
        holder: { id: 'u1', name: null, status: 'deleted' },
      }),
    )
    await renderPage()

    const facts = screen.getByTestId('asset-facts')
    const value = (label: string) => within(facts).getByText(label).closest('div')!.querySelector('dd')!.textContent
    expect(value('Serial number')).toBe('—')
    expect(value('Location / note')).toBe('—')
    expect(value('Supplier')).toBe('—')
    expect(value('Held by')).toBe('Deleted account')
  })

  it('has one polite status line, empty until something is announced', async () => {
    await renderPage()
    const status = screen.getByTestId('asset-status')
    expect(status.getAttribute('role')).toBe('status')
    expect(status.getAttribute('aria-live')).toBe('polite')
    expect(status.textContent).toBe('')
  })
})

describe('regions by capability (design § T2)', () => {
  it('manager only: actions, invoice and history; no ledger block', async () => {
    asUser([ASSETS])
    await renderPage()

    expect(screen.getByTestId('region-actions').getAttribute('data-caps')).toBe('true/false')
    expect(screen.getByTestId('region-invoice')).not.toBeNull()
    expect(screen.getByTestId('region-history')).not.toBeNull()
    expect(screen.queryByTestId('region-ledger')).toBeNull()
  })

  it('accountant only: ledger, invoice and history; the actions region is told the viewer cannot manage assets', async () => {
    asUser([LEDGER])
    await renderPage()

    expect(screen.getByTestId('region-ledger').getAttribute('data-caps')).toBe('false/true')
    expect(screen.getByTestId('region-invoice')).not.toBeNull()
    expect(screen.getByTestId('region-history')).not.toBeNull()
    expect(screen.getByTestId('region-actions').getAttribute('data-caps')).toBe('false/true')
  })

  it('both capabilities: all four regions', async () => {
    await renderPage()
    for (const id of ['region-actions', 'region-ledger', 'region-invoice', 'region-history']) {
      expect(screen.getByTestId(id)).not.toBeNull()
    }
  })

  it('hands every region the loaded asset', async () => {
    await renderPage()
    for (const id of ['region-actions', 'region-ledger', 'region-invoice', 'region-history']) {
      expect(screen.getByTestId(`${id}-asset`).textContent).toBe('MacBook Pro 14')
    }
  })
})

describe('the edit entry (AC-10.1)', () => {
  it('a manager gets "Edit details"', async () => {
    asUser([ASSETS])
    await renderPage()
    expect(screen.getByRole('button', { name: 'Edit details' })).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'Edit invoice details' })).toBeNull()
  })

  it('both capabilities get "Edit details"', async () => {
    await renderPage()
    expect(screen.getByRole('button', { name: 'Edit details' })).not.toBeNull()
  })

  it('an accountant only gets "Edit invoice details" and the dialog offers the two accountant fields only', async () => {
    asUser([LEDGER])
    await renderPage()

    expect(screen.queryByRole('button', { name: 'Edit details' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Edit invoice details' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByLabelText('Supplier')).not.toBeNull()
    expect(within(dialog).getByLabelText('Invoice reference')).not.toBeNull()
    expect(within(dialog).queryByLabelText('Description')).toBeNull()
  })

  it('saving shows the saved asset, announces it and closes the dialog', async () => {
    await renderPage()
    updateAsset.mockResolvedValue(asset({ locationNote: 'Basel office' }))

    fireEvent.click(screen.getByRole('button', { name: 'Edit details' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('Location / note'), { target: { value: 'Basel office' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(updateAsset).toHaveBeenCalledWith('a1', { locationNote: 'Basel office' })
    const facts = screen.getByTestId('asset-facts')
    expect(within(facts).getByText('Basel office')).not.toBeNull()
    expect(screen.getByTestId('asset-status').textContent).toBe('Details saved.')
  })

  it('asset_disposed from the dialog shows the guardrail and, on OK, refreshes the asset', async () => {
    await renderPage()
    updateAsset.mockRejectedValue(new ApiError({ status: 409, title: 'Conflict', code: 'asset_disposed' }))
    getAsset.mockResolvedValue(
      asset({ status: 'disposed', disposal: { disposedOn: '2026-10-01', reason: 'scrapped', salePriceCents: null } }),
    )

    fireEvent.click(screen.getByRole('button', { name: 'Edit details' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('Supplier'), { target: { value: 'Other' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }))

    const guardrail = await screen.findByTestId('guardrail-dialog')
    expect(guardrail.textContent).toContain('This asset has been disposed of and can no longer be changed.')
    fireEvent.click(screen.getByTestId('guardrail-dialog-ok'))

    await screen.findByText('Disposed on 01.10.2026. This asset can no longer be changed.')
    expect(getAsset).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('button', { name: 'Edit details' })).toBeNull()
  })
})

describe('a disposed asset is read-only (AC-7.1)', () => {
  const disposed = () =>
    asset({
      status: 'disposed',
      holder: null,
      disposal: { disposedOn: '2026-10-01', reason: 'lost', salePriceCents: null },
    })

  it('shows the banner with the date and reason, no edit entry, no actions region, no verify button', async () => {
    getAsset.mockResolvedValue({ ...disposed(), toVerify: true })
    await renderPage()

    expect(screen.getByText('Disposed on 01.10.2026. This asset can no longer be changed.')).not.toBeNull()
    expect(screen.getByText('Reason: Written off as lost')).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'Edit details' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Edit invoice details' })).toBeNull()
    expect(screen.queryByTestId('region-actions')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Mark as verified' })).toBeNull()
  })

  it('still shows the ledger, the invoice panel and the history', async () => {
    getAsset.mockResolvedValue(disposed())
    await renderPage()

    expect(screen.getByTestId('region-ledger')).not.toBeNull()
    expect(screen.getByTestId('region-invoice')).not.toBeNull()
    expect(screen.getByTestId('region-history')).not.toBeNull()
  })
})

describe('"To verify" (AC-12.6)', () => {
  it('shows the chip with "Mark as verified" for a manager, which clears the mark', async () => {
    getAsset.mockResolvedValue(asset({ toVerify: true }))
    await renderPage()
    expect(screen.getByTestId('to-verify-chip').textContent).toContain('To verify')

    updateAsset.mockResolvedValue(asset({ toVerify: false }))
    fireEvent.click(screen.getByRole('button', { name: 'Mark as verified' }))

    await waitFor(() => expect(screen.queryByTestId('to-verify-chip')).toBeNull())
    expect(updateAsset).toHaveBeenCalledWith('a1', { toVerify: false })
    expect(screen.getByTestId('asset-status').textContent).toBe('Marked as verified.')
  })

  it('an accountant only sees the chip but no button', async () => {
    asUser([LEDGER])
    getAsset.mockResolvedValue(asset({ toVerify: true }))
    await renderPage()

    expect(screen.getByTestId('to-verify-chip')).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'Mark as verified' })).toBeNull()
  })

  it('a failed attempt shows an alert and keeps the chip', async () => {
    getAsset.mockResolvedValue(asset({ toVerify: true }))
    await renderPage()
    updateAsset.mockRejectedValue(new TypeError('Failed to fetch'))

    fireEvent.click(screen.getByRole('button', { name: 'Mark as verified' }))

    expect((await screen.findByTestId('to-verify-error')).getAttribute('role')).toBe('alert')
    expect(screen.getByTestId('to-verify-chip')).not.toBeNull()
  })

  it('asset_disposed on verify shows the guardrail', async () => {
    getAsset.mockResolvedValue(asset({ toVerify: true }))
    await renderPage()
    updateAsset.mockRejectedValue(new ApiError({ status: 409, title: 'Conflict', code: 'asset_disposed' }))

    fireEvent.click(screen.getByRole('button', { name: 'Mark as verified' }))

    expect((await screen.findByTestId('guardrail-dialog')).textContent).toContain('has been disposed of')
  })
})

describe('arriving from the register page', () => {
  it('announces "Asset registered." and focuses the heading', async () => {
    await renderPage({ registeredCount: 1 })

    await waitFor(() => expect(screen.getByTestId('asset-status').textContent).toBe('Asset registered.'))
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 2, name: 'MacBook Pro 14' }))
  })

  it('does neither without the history state', async () => {
    await renderPage()
    expect(screen.getByTestId('asset-status').textContent).toBe('')
    expect(document.activeElement).not.toBe(screen.getByRole('heading', { level: 2, name: 'MacBook Pro 14' }))
  })
})

describe('the seams the regions use', () => {
  it('onChanged(asset) replaces the asset without another request', async () => {
    await renderPage()

    fireEvent.click(screen.getByText('region-actions changed'))

    await screen.findByRole('heading', { level: 2, name: 'Renamed laptop' })
    expect(getAsset).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('region-ledger-asset').textContent).toBe('Renamed laptop')
  })

  it('onChanged(null) reloads the asset in place, without a skeleton', async () => {
    await renderPage()
    getAsset.mockResolvedValue(asset({ description: 'Reloaded laptop' }))

    fireEvent.click(screen.getByText('region-ledger refresh'))

    await screen.findByRole('heading', { level: 2, name: 'Reloaded laptop' })
    expect(getAsset).toHaveBeenCalledTimes(2)
    expect(screen.queryByTestId('skeleton-list-rows')).toBeNull()
  })

  it('a reload still in flight when a newer asset arrives is discarded', async () => {
    await renderPage()
    let resolveReload: (value: AssetView) => void = () => undefined
    getAsset.mockReturnValue(new Promise<AssetView>((resolve) => (resolveReload = resolve)))

    fireEvent.click(screen.getByText('region-ledger refresh'))
    fireEvent.click(screen.getByText('region-actions changed'))
    await screen.findByRole('heading', { level: 2, name: 'Renamed laptop' })
    resolveReload(asset({ description: 'Stale laptop' }))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(screen.getByRole('heading', { level: 2, name: 'Renamed laptop' })).not.toBeNull()
  })

  it('a failed in-place reload keeps the asset on screen', async () => {
    await renderPage()
    getAsset.mockRejectedValue(new TypeError('Failed to fetch'))

    fireEvent.click(screen.getByText('region-ledger refresh'))

    await waitFor(() => expect(getAsset).toHaveBeenCalledTimes(2))
    expect((await screen.findByTestId('asset-notice')).getAttribute('role')).toBe('alert')
    expect(screen.getByRole('heading', { level: 2, name: 'MacBook Pro 14' })).not.toBeNull()
  })

  it('a reload that finds the asset gone shows "Asset not found"', async () => {
    await renderPage()
    getAsset.mockRejectedValue(new ApiError({ status: 404, title: 'Not Found' }))

    fireEvent.click(screen.getByText('region-ledger refresh'))

    expect(await screen.findByRole('heading', { name: 'Asset not found' })).not.toBeNull()
  })

  it('announce(message) fills the polite status line and focusHeading() focuses the heading', async () => {
    await renderPage()

    fireEvent.click(screen.getByText('region-actions announce'))

    expect(screen.getByTestId('asset-status').textContent).toBe('Did the thing.')
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 2, name: 'MacBook Pro 14' }))
  })

  it('bumps the history revision on every change so the timeline reloads', async () => {
    await renderPage()
    const before = screen.getByTestId('region-history-revision').textContent

    fireEvent.click(screen.getByText('region-actions changed'))
    await screen.findByRole('heading', { level: 2, name: 'Renamed laptop' })

    expect(screen.getByTestId('region-history-revision').textContent).not.toBe(before)
  })
})
