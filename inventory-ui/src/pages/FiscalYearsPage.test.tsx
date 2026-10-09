/**
 * @vitest-environment jsdom
 *
 * Page tests for FiscalYearsPage (T38, specs/015-hardware-inventory; design.md T5,
 * F12; refs AC-8.1). `fiscalYearsApi`, `getScope` and `usePermissions` are the seams.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router'
import type { Permission } from 'shell/session'
import { ApiError } from '../lib/api'
import type { Entity } from '../lib/types'

const { usePermissions, listFiscalYears, getScope } = vi.hoisted(() => ({
  usePermissions: vi.fn(),
  listFiscalYears: vi.fn(),
  getScope: vi.fn(),
}))
vi.mock('shell/session', () => ({ usePermissions }))
vi.mock('../lib/fiscalYearsApi', () => ({ listFiscalYears }))
vi.mock('../lib/scopeApi', () => ({ getScope }))

import FiscalYearsPage from './FiscalYearsPage'

const ASSETS: Permission = { resource: 'asset', action: 'manage' }
const LEDGER: Permission = { resource: 'ledger', action: 'manage' }

const asUser = (permissions: Permission[], ledger: Entity[]) => {
  usePermissions.mockReturnValue({ epoch: 0, apps: ['inventory'], roles: [], departments: [], permissions })
  getScope.mockResolvedValue({ asset: [], ledger })
}

const YEARS = {
  years: [
    { year: 2024, status: 'closed', closedAt: '2025-01-15T09:00:00Z', closable: false },
    { year: 2026, status: 'open', closedAt: null, closable: false },
    { year: 2025, status: 'closed', closedAt: '2026-01-20T09:00:00Z', closable: false },
  ],
}

const renderPage = () => {
  const history = createMemoryHistory({ initialEntries: ['/years'] })
  const rootRoute = createRootRoute()
  const route = (path: string, component: () => React.ReactNode) =>
    createRoute({ getParentRoute: () => rootRoute, path, component })
  const routeTree = rootRoute.addChildren([
    route('/years', FiscalYearsPage),
    route('/years/$entity/$year', () => <p>year detail</p>),
  ])
  const router = createRouter({ routeTree, history })
  render(<RouterProvider router={router} />)
  return router
}

const problem = (status: number) => new ApiError({ status, title: 'x', detail: 'boom' })

beforeEach(() => {
  asUser([LEDGER], ['welld_ch'])
  listFiscalYears.mockResolvedValue(YEARS)
  window.scrollTo = () => undefined
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('FiscalYearsPage — access and scope', () => {
  it('shows PermissionDenied and calls nothing for a caller without ledger:manage', async () => {
    asUser([ASSETS], ['welld_ch'])
    renderPage()
    expect(await screen.findByText('You do not have access to this section.')).not.toBeNull()
    expect(getScope).not.toHaveBeenCalled()
    expect(listFiscalYears).not.toHaveBeenCalled()
  })

  it('shows one section per entity of the ledger scope, each loading its own years', async () => {
    asUser([LEDGER], ['welld_ch', 'welld_it'])
    renderPage()
    await screen.findByTestId('fiscal-years-table-welld_ch')
    expect(screen.getByRole('heading', { level: 3, name: /Fiscal years for WellD CH/ })).not.toBeNull()
    expect(screen.getByRole('heading', { level: 3, name: /Fiscal years for WellD Italia/ })).not.toBeNull()
    expect(listFiscalYears.mock.calls.map((call) => call[0]).sort()).toEqual(['welld_ch', 'welld_it'])
  })

  it('says so when no entity is in scope', async () => {
    asUser([LEDGER], [])
    renderPage()
    expect(await screen.findByText(/No entity is in your scope for fiscal years/)).not.toBeNull()
    expect(listFiscalYears).not.toHaveBeenCalled()
  })

  it('shows a retryable error when the scope fails, and the 503 variant for an auth outage', async () => {
    getScope.mockRejectedValueOnce(problem(503)).mockResolvedValueOnce({ asset: [], ledger: ['welld_ch'] })
    renderPage()
    expect((await screen.findByRole('alert')).textContent).toContain('Authorization service unavailable')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByTestId('fiscal-years-table-welld_ch')).not.toBeNull()
  })
})

describe('FiscalYearsPage — the table', () => {
  it('lists the years newest first with status words and the closed-on date', async () => {
    renderPage()
    const table = await screen.findByTestId('fiscal-years-table-welld_ch')
    const rows = within(table).getAllByRole('row').slice(1)
    expect(rows.map((row) => within(row).getByRole('rowheader').textContent)).toEqual(['2026', '2025', '2024'])
    expect(within(rows[0]).getAllByRole('cell')[0].textContent).toContain('Open')
    expect(within(rows[0]).getAllByRole('cell')[1].textContent).toBe('—')
    expect(within(rows[1]).getAllByRole('cell')[0].textContent).toContain('Closed')
    expect(within(rows[1]).getAllByRole('cell')[1].textContent).toBe('20.01.2026')
  })

  it('has a caption and column headers', async () => {
    renderPage()
    expect(await screen.findByRole('table', { name: /Fiscal years for WellD CH, newest first/ })).not.toBeNull()
    expect(screen.getAllByRole('columnheader').map((header) => header.textContent)).toEqual([
      'Year',
      'Status',
      'Closed on',
      'Details',
    ])
  })

  it('links each row to its detail, named with the year and entity', async () => {
    const router = renderPage()
    const link = await screen.findByRole('link', { name: 'Open fiscal year 2025 for WellD CH' })
    expect(link.getAttribute('href')).toBe('/years/welld_ch/2025')
    fireEvent.click(link)
    await waitFor(() => expect(router.state.location.pathname).toBe('/years/welld_ch/2025'))
  })

  it('shows the empty note for an entity without years', async () => {
    listFiscalYears.mockResolvedValue({ years: [] })
    renderPage()
    expect(await screen.findByText('No fiscal years yet. A year appears once WellD CH has assets.')).not.toBeNull()
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('announces loading while a section loads', async () => {
    listFiscalYears.mockReturnValue(new Promise(() => undefined))
    renderPage()
    expect(await screen.findByText('Loading fiscal years for WellD CH')).not.toBeNull()
    expect(screen.getByTestId('skeleton-list-rows')).not.toBeNull()
  })
})

describe('FiscalYearsPage — failures stay inside their section', () => {
  it('one entity failing does not hide the other; Retry reloads only the failed one', async () => {
    asUser([LEDGER], ['welld_ch', 'welld_it'])
    listFiscalYears.mockImplementation((entity: Entity) =>
      entity === 'welld_it' ? Promise.reject(new TypeError('Failed to fetch')) : Promise.resolve(YEARS),
    )
    renderPage()
    await screen.findByTestId('fiscal-years-table-welld_ch')
    expect((await screen.findByRole('alert')).textContent).toMatch(/could not reach the server/i)
    listFiscalYears.mockResolvedValue({ years: [{ year: 2026, status: 'open', closedAt: null, closable: true }] })
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByTestId('fiscal-years-table-welld_it')).not.toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('a 503 shows the authorization-unavailable variant with Retry', async () => {
    listFiscalYears.mockRejectedValue(problem(503))
    renderPage()
    expect((await screen.findByRole('alert')).textContent).toContain('Authorization service unavailable')
    expect(screen.getByRole('button', { name: 'Retry' })).not.toBeNull()
  })

  it('a 403 shows PermissionDenied inside the section', async () => {
    listFiscalYears.mockRejectedValue(problem(403))
    renderPage()
    expect(await screen.findByText('You do not have access to this section.')).not.toBeNull()
  })
})
