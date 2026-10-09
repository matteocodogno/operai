/**
 * @vitest-environment jsdom
 *
 * Page tests for FiscalYearDetailPage (T38, specs/015-hardware-inventory; design.md
 * T6, F12, § Accessibility "T6 year detail"; refs AC-8.1, AC-8.4, AC-8.5, AC-8.7).
 * `fiscalYearsApi` and `usePermissions` are the seams; the statement, the Close
 * dialog and the (stub) export button are the real components.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router'
import type { Permission } from 'shell/session'
import { ApiError } from '../lib/api'
import type { FiscalYearView } from '../lib/types'

const { usePermissions, getFiscalYear, listFiscalYears, closeFiscalYear } = vi.hoisted(() => ({
  usePermissions: vi.fn(),
  getFiscalYear: vi.fn(),
  listFiscalYears: vi.fn(),
  closeFiscalYear: vi.fn(),
}))
vi.mock('shell/session', () => ({ usePermissions }))
vi.mock('../lib/fiscalYearsApi', () => ({ getFiscalYear, listFiscalYears, closeFiscalYear }))

import FiscalYearDetailPage from './FiscalYearDetailPage'

const ASSETS: Permission = { resource: 'asset', action: 'manage' }
const LEDGER: Permission = { resource: 'ledger', action: 'manage' }

const ROLL = {
  openingCents: 2168900,
  disposalsCents: 53000,
  purchasesCents: 1829589,
  depreciationCents: 2245831,
  closingCents: 1699658,
}

const ANNA = { id: 'u1', name: 'Anna Rossi', status: 'active' as const }

const view = (over: Partial<FiscalYearView> = {}): FiscalYearView => ({
  entity: 'welld_ch',
  year: 2026,
  currency: 'CHF',
  status: 'open',
  closedAt: null,
  rollForward: ROLL,
  assets: [
    {
      assetId: 'a1',
      purchaseDate: '2026-03-02',
      description: 'MacBook Pro 14',
      serialNumber: 'SN123',
      holder: ANNA,
      purchasePriceCents: 332390,
      openingCents: 0,
      purchaseCents: 332390,
      depreciationCents: 110796,
      disposalCents: 0,
      closingCents: 221594,
    },
    {
      assetId: 'a2',
      purchaseDate: '2024-05-10',
      description: 'Dell monitor',
      serialNumber: null,
      holder: null,
      purchasePriceCents: 45000,
      openingCents: 20000,
      purchaseCents: 0,
      depreciationCents: 15000,
      disposalCents: 5000,
      closingCents: 0,
    },
  ],
  ...over,
})

const asUser = (permissions: Permission[]) =>
  usePermissions.mockReturnValue({ epoch: 0, apps: ['inventory'], roles: [], departments: [], permissions })

const summary = (closable: boolean, status: 'open' | 'closed' = 'open') => ({
  years: [
    { year: 2025, status: 'closed', closedAt: '2026-01-20T09:00:00Z', closable: false },
    { year: 2026, status, closedAt: status === 'closed' ? '2026-12-31T10:00:00Z' : null, closable },
  ],
})

beforeEach(() => {
  asUser([LEDGER])
  getFiscalYear.mockResolvedValue(view())
  listFiscalYears.mockResolvedValue(summary(true))
  window.scrollTo = () => undefined
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const renderPage = async (url = '/years/welld_ch/2026', { settle = true } = {}) => {
  const history = createMemoryHistory({ initialEntries: [url] })
  const rootRoute = createRootRoute()
  const route = (path: string, component: () => React.ReactNode) =>
    createRoute({ getParentRoute: () => rootRoute, path, component })
  const routeTree = rootRoute.addChildren([
    route('/years', () => <p>years list</p>),
    route('/years/$entity/$year', FiscalYearDetailPage),
  ])
  const router = createRouter({ routeTree, history })
  render(<RouterProvider router={router} />)
  if (settle) await screen.findByRole('heading', { level: 2, name: /Fiscal year/ })
  return router
}

const problem = (status: number, code?: string) =>
  new ApiError({ status, title: code ?? 'x', code, detail: code ?? 'boom' })

describe('FiscalYearDetailPage — access, loading, failures', () => {
  it('shows PermissionDenied and calls nothing without ledger:manage', async () => {
    asUser([ASSETS])
    await renderPage('/years/welld_ch/2026', { settle: false })
    expect(await screen.findByText('You do not have access to this section.')).not.toBeNull()
    expect(getFiscalYear).not.toHaveBeenCalled()
    expect(listFiscalYears).not.toHaveBeenCalled()
  })

  it('requests the entity and year named by the route', async () => {
    await renderPage()
    expect(getFiscalYear.mock.calls[0].slice(0, 2)).toEqual(['welld_ch', 2026])
    expect(listFiscalYears.mock.calls[0][0]).toBe('welld_ch')
  })

  it('announces loading with a skeleton while the year loads', async () => {
    getFiscalYear.mockReturnValue(new Promise(() => undefined))
    await renderPage('/years/welld_ch/2026', { settle: false })
    expect(await screen.findByText('Loading fiscal year')).not.toBeNull()
    expect(screen.getByTestId('skeleton-list-rows')).not.toBeNull()
  })

  it('shows a not-found state with a way back on a 404 (outside scope or before the first year)', async () => {
    getFiscalYear.mockRejectedValue(problem(404))
    await renderPage('/years/welld_ch/1999', { settle: false })
    expect(await screen.findByRole('heading', { level: 2, name: 'Fiscal year not found' })).not.toBeNull()
    expect(screen.getByRole('link', { name: 'Back to fiscal years' }).getAttribute('href')).toBe('/years')
  })

  it.each(['/years/mars/2026', '/years/welld_ch/abc', '/years/welld_ch/20260'])(
    'treats the malformed route %s as not found without calling the API',
    async (url) => {
      await renderPage(url, { settle: false })
      expect(await screen.findByRole('heading', { level: 2, name: 'Fiscal year not found' })).not.toBeNull()
      expect(getFiscalYear).not.toHaveBeenCalled()
    },
  )

  it('shows the 503 variant with Retry, and Retry reloads', async () => {
    getFiscalYear.mockRejectedValueOnce(problem(503))
    await renderPage('/years/welld_ch/2026', { settle: false })
    expect((await screen.findByRole('alert')).textContent).toContain('Authorization service unavailable')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByRole('heading', { level: 2, name: 'Fiscal year 2026' })).not.toBeNull()
  })

  it('shows a network failure with Retry', async () => {
    getFiscalYear.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await renderPage('/years/welld_ch/2026', { settle: false })
    expect((await screen.findByRole('alert')).textContent).toMatch(/could not reach the server/i)
    expect(screen.getByRole('button', { name: 'Retry' })).not.toBeNull()
  })

  it('a failed closable lookup is a page failure too (Close must never be guessed)', async () => {
    listFiscalYears.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await renderPage('/years/welld_ch/2026', { settle: false })
    expect(await screen.findByRole('alert')).not.toBeNull()
    expect(screen.queryByRole('button', { name: /Close year/ })).toBeNull()
  })
})

describe('FiscalYearDetailPage — roll-forward and per-asset table', () => {
  it('shows the heading, the entity badge, the status word and the five lines with currency', async () => {
    await renderPage()
    expect(screen.getByTestId('entity-badge').textContent).toContain('WellD CH')
    expect(screen.getByTestId('year-status').textContent).toContain('Open')
    expect(screen.getByRole('heading', { level: 3, name: 'Roll-forward (CHF)' })).not.toBeNull()
    const statement = screen.getByTestId('roll-forward-statement')
    expect(within(statement).getAllByRole('rowheader')).toHaveLength(5)
    expect(within(statement).getByText('16996,58 CHF')).not.toBeNull()
  })

  it('shows per-asset opening, purchase, depreciation, disposal and closing figures', async () => {
    await renderPage()
    const table = screen.getByRole('table', { name: /Per-asset figures for fiscal year 2026/ })
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((header) => header.textContent),
    ).toEqual([
      'Purchase date',
      'Description',
      'Serial number',
      'Held by',
      'Purchase price',
      'Opening',
      'Purchases',
      'Depreciation',
      'Disposals',
      'Closing',
    ])
    const first = within(table).getByRole('rowheader', { name: 'MacBook Pro 14' }).closest('tr') as HTMLElement
    expect(
      within(first)
        .getAllByRole('cell')
        .map((cell) => cell.textContent),
    ).toEqual([
      '02.03.2026',
      'SN123',
      'Anna Rossi',
      '3323,90 CHF',
      '0,00 CHF',
      '3323,90 CHF',
      '1107,96 CHF',
      '0,00 CHF',
      '2215,94 CHF',
    ])
    const second = within(table).getByRole('rowheader', { name: 'Dell monitor' }).closest('tr') as HTMLElement
    const cells = within(second)
      .getAllByRole('cell')
      .map((cell) => cell.textContent)
    expect(cells.slice(1, 3)).toEqual(['—', '—'])
    expect(cells.slice(4)).toEqual(['200,00 CHF', '0,00 CHF', '150,00 CHF', '50,00 CHF', '0,00 CHF'])
  })

  it('renders EUR figures for a welld_it year', async () => {
    getFiscalYear.mockResolvedValue(view({ entity: 'welld_it', currency: 'EUR' }))
    await renderPage('/years/welld_it/2026')
    expect(within(screen.getByTestId('roll-forward-statement')).getByText('16996,58 €')).not.toBeNull()
  })

  it('says "No assets in this year" instead of an empty table', async () => {
    getFiscalYear.mockResolvedValue(view({ assets: [] }))
    await renderPage()
    expect(screen.getByText('No assets in this year')).not.toBeNull()
    expect(screen.queryByRole('table', { name: /Per-asset figures/ })).toBeNull()
  })

  it('labels a deleted holder instead of a blank', async () => {
    getFiscalYear.mockResolvedValue(
      view({ assets: [{ ...view().assets[0], holder: { id: 'u9', name: null, status: 'deleted' } }] }),
    )
    await renderPage()
    expect(screen.getByText('Deleted account')).not.toBeNull()
  })

  it('has the Export XLSX control for the shown year', async () => {
    await renderPage()
    expect(screen.getByRole('button', { name: 'Export XLSX' })).not.toBeNull()
  })
})

describe('FiscalYearDetailPage — open year', () => {
  it('shows the Provisional banner as a status, and an enabled Close year button when closable', async () => {
    await renderPage()
    expect(
      screen.getByText(/Provisional: figures change until this year is closed/).closest('[role="status"]'),
    ).not.toBeNull()
    const close = screen.getByRole('button', { name: 'Close year 2026' })
    expect(close.getAttribute('aria-disabled')).toBeNull()
    expect(screen.queryByText(/Closed on/)).toBeNull()
  })

  it('when not closable the button is aria-disabled, focusable, points at its reason and does nothing', async () => {
    listFiscalYears.mockResolvedValue(summary(false))
    await renderPage()
    const close = screen.getByRole('button', { name: 'Close year 2026' })
    expect(close.getAttribute('aria-disabled')).toBe('true')
    expect((close as HTMLButtonElement).disabled).toBe(false)
    const reason = document.getElementById(close.getAttribute('aria-describedby') ?? '')
    expect(reason?.textContent).toBe('Close 2025 first.')
    fireEvent.click(close)
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('opens the Close dialog from the button', async () => {
    await renderPage()
    fireEvent.click(screen.getByRole('button', { name: 'Close year 2026' }))
    expect(screen.getByRole('alertdialog', { name: 'Close fiscal year 2026?' })).not.toBeNull()
  })
})

describe('FiscalYearDetailPage — closing', () => {
  const closeIt = () => {
    fireEvent.click(screen.getByRole('button', { name: 'Close year 2026' }))
    fireEvent.click(screen.getByRole('checkbox', { name: /cannot be reopened/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Close 2026' }))
  }

  it('on success re-renders closed: no Provisional banner, no Close button, closed-on date, focus on the heading, announced', async () => {
    closeFiscalYear.mockResolvedValue(view({ status: 'closed', closedAt: '2026-12-31T10:00:00Z' }))
    await renderPage()
    closeIt()
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(screen.queryByRole('button', { name: /Close year/ })).toBeNull()
    expect(screen.queryByText(/Provisional/)).toBeNull()
    expect(screen.getByText('Closed on 31.12.2026.')).not.toBeNull()
    expect(screen.getByTestId('year-status').textContent).toContain('Closed')
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('heading', { level: 2, name: 'Fiscal year 2026' })),
    )
    expect(screen.getByTestId('year-status-line').textContent).toBe('Fiscal year 2026 is closed.')
  })

  it('after already_closed the page refetches and shows the closed year', async () => {
    closeFiscalYear.mockRejectedValue(problem(409, 'already_closed'))
    await renderPage()
    getFiscalYear.mockResolvedValue(view({ status: 'closed', closedAt: '2026-12-31T10:00:00Z' }))
    listFiscalYears.mockResolvedValue(summary(false, 'closed'))
    closeIt()
    fireEvent.click(await screen.findByRole('button', { name: 'OK' }))
    await waitFor(() => expect(screen.getByText('Closed on 31.12.2026.')).not.toBeNull())
    expect(screen.queryByRole('button', { name: /Close year/ })).toBeNull()
    expect(getFiscalYear).toHaveBeenCalledTimes(2)
  })

  it('previous_year_open keeps the dialog open with the inline message and the page unchanged', async () => {
    closeFiscalYear.mockRejectedValue(problem(409, 'previous_year_open'))
    await renderPage()
    closeIt()
    expect((await screen.findByRole('alert')).textContent).toBe('Close 2025 first.')
    expect(screen.getByRole('alertdialog')).not.toBeNull()
  })
})

describe('FiscalYearDetailPage — closed year', () => {
  beforeEach(() => {
    getFiscalYear.mockResolvedValue(view({ status: 'closed', closedAt: '2026-12-31T10:00:00Z' }))
    listFiscalYears.mockResolvedValue(summary(false, 'closed'))
  })

  it('shows the closed-on date and status, with NO close or reopen control and no provisional mark', async () => {
    await renderPage()
    expect(screen.getByText('Closed on 31.12.2026.')).not.toBeNull()
    expect(screen.getByTestId('year-status').textContent).toContain('Closed')
    expect(screen.queryByText(/Provisional/)).toBeNull()
    const names = screen.getAllByRole('button').map((button) => button.textContent ?? '')
    expect(names.some((name) => /close|reopen|re-open/i.test(name))).toBe(false)
  })

  it('still shows the statement, the per-asset table and the export', async () => {
    await renderPage()
    expect(screen.getByTestId('roll-forward-statement')).not.toBeNull()
    expect(screen.getByRole('table', { name: /Per-asset figures/ })).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Export XLSX' })).not.toBeNull()
  })
})
