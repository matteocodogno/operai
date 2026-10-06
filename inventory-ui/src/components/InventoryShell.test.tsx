/**
 * @vitest-environment jsdom
 *
 * Component tests for InventoryShell (T28, specs/015-hardware-inventory;
 * design.md § T0 InventoryShell and § Screens & states; refs AC-9.1, AC-9.3,
 * AC-9.4, AC-9.6; Resolutions G1/G11).
 *
 * A real, minimal TanStack Router harness (as RefundShell.test.tsx does), with
 * stand-in pages so these tests do not depend on the real pages, which later
 * tasks fill in. `usePermissions` and `GET /scope` are mocked to put the layout
 * in each user's position: manager-only, accountant-only, both, neither, and a
 * user with tool access whose scope is empty.
 *
 * The central assertion is ABSENCE, not disabledness: a capability the caller
 * lacks removes the tab from the DOM, and its route renders PermissionDenied
 * (a deep link must not show the tool's content).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router'
import type { Permission, PermissionsResult } from 'shell/session'
import { ApiError } from '../lib/api'

const { usePermissions, getScope } = vi.hoisted(() => ({ usePermissions: vi.fn(), getScope: vi.fn() }))
vi.mock('shell/session', () => ({ usePermissions }))
vi.mock('../lib/scopeApi', () => ({ getScope }))

import InventoryShell from './InventoryShell'

const ASSETS: Permission = { resource: 'asset', action: 'manage' }
const LEDGER: Permission = { resource: 'ledger', action: 'manage' }

const permissionsWith = (permissions: Permission[]): PermissionsResult => ({
  epoch: 0,
  apps: ['inventory'],
  roles: [],
  departments: [],
  permissions,
})

const asUser = (permissions: Permission[], scope = { asset: ['welld_ch'], ledger: ['welld_ch'] }) => {
  usePermissions.mockReturnValue(permissionsWith(permissions))
  getScope.mockResolvedValue(scope)
}

beforeEach(() => {
  asUser([ASSETS, LEDGER])
  // jsdom does not implement scrolling; the router's scroll restoration calls it on every navigation.
  window.scrollTo = () => undefined
})

afterEach(() => {
  cleanup()
  window.history.pushState(null, '', '/')
  vi.clearAllMocks()
})

const renderShellAt = async (path: string) => {
  window.history.pushState(null, '', path)

  const rootRoute = createRootRoute({ component: InventoryShell })
  const page = (path: string, text: string) =>
    createRoute({ getParentRoute: () => rootRoute, path, component: () => <p>{text}</p> })
  const routeTree = rootRoute.addChildren([
    page('/assets', 'assets page'),
    page('/assets/new', 'register page'),
    page('/assets/$id', 'detail page'),
    page('/rules', 'rules page'),
    page('/years', 'years page'),
    page('/years/$entity/$year', 'year detail page'),
  ])
  const router = createRouter({ routeTree })
  render(<RouterProvider router={router} />)
  await screen.findByRole('heading', { level: 1, name: 'Inventory' })
}

const tabLabels = () =>
  Array.from(screen.getByRole('navigation', { name: 'Inventory sections' }).querySelectorAll('a')).map(
    (link) => link.textContent,
  )

describe('structure', () => {
  it('renders the h1 "Inventory" and a navigation landmark labelled "Inventory sections"', async () => {
    await renderShellAt('/assets')

    expect(screen.getByRole('heading', { level: 1, name: 'Inventory' })).not.toBeNull()
    expect(screen.getByRole('navigation', { name: 'Inventory sections' })).not.toBeNull()
  })

  it('renders the tabs as real links and the routed page inside <main>', async () => {
    await renderShellAt('/assets')

    screen.getAllByRole('link').forEach((link) => expect(link.tagName).toBe('A'))
    expect(await screen.findByText('assets page')).not.toBeNull()
    expect(screen.getByRole('main').textContent).toContain('assets page')
  })
})

describe('tabs by capability (absent from the DOM, never disabled)', () => {
  it('manager only: Assets, and neither accountant tab', async () => {
    asUser([ASSETS])
    await renderShellAt('/assets')

    expect(tabLabels()).toEqual(['Assets'])
    expect(screen.queryByRole('link', { name: 'Depreciation rules' })).toBeNull()
    expect(screen.queryByRole('link', { name: 'Fiscal years' })).toBeNull()
    expect(screen.queryByText('Depreciation rules')).toBeNull()
  })

  it('accountant only: Assets (read-only for them), Depreciation rules and Fiscal years', async () => {
    asUser([LEDGER])
    await renderShellAt('/assets')

    expect(tabLabels()).toEqual(['Assets', 'Depreciation rules', 'Fiscal years'])
  })

  it('both capabilities: all three tabs, in order', async () => {
    asUser([ASSETS, LEDGER])
    await renderShellAt('/assets')

    expect(tabLabels()).toEqual(['Assets', 'Depreciation rules', 'Fiscal years'])
  })

  it('neither capability: no tab at all', async () => {
    asUser([])
    await renderShellAt('/assets')

    expect(screen.queryAllByRole('link')).toHaveLength(0)
  })

  it('shows the same tabs for an entity-conditioned grant as for an unconditioned one', async () => {
    asUser([{ ...LEDGER, conditions: { entity: 'welld_ch' } }])
    await renderShellAt('/assets')

    expect(tabLabels()).toEqual(['Assets', 'Depreciation rules', 'Fiscal years'])
  })
})

describe('active tab (aria-current)', () => {
  it.each([
    ['/assets', 'Assets'],
    ['/assets/new', 'Assets'],
    ['/assets/abc', 'Assets'],
    ['/rules', 'Depreciation rules'],
    ['/years', 'Fiscal years'],
    ['/years/welld_ch/2025', 'Fiscal years'],
  ])('on %s only "%s" is current', async (path, active) => {
    await renderShellAt(path)

    for (const link of screen.getAllByRole('link')) {
      expect(link.getAttribute('aria-current')).toBe(link.textContent === active ? 'page' : null)
    }
  })
})

describe('a route the caller has no capability for renders PermissionDenied', () => {
  it.each(['/rules', '/years', '/years/welld_ch/2025'])('manager only on %s', async (path) => {
    asUser([ASSETS])
    await renderShellAt(path)

    expect(screen.getByTestId('permission-denied')).not.toBeNull()
    expect(screen.queryByText(/page$/)).toBeNull()
  })

  it.each(['/assets', '/assets/new', '/assets/abc'])('neither capability on %s', async (path) => {
    asUser([])
    await renderShellAt(path)

    expect(screen.getByTestId('permission-denied')).not.toBeNull()
    expect(screen.queryByText(/page$/)).toBeNull()
  })

  it('does not call GET /scope for a user with neither capability', async () => {
    asUser([])
    await renderShellAt('/assets')

    expect(getScope).not.toHaveBeenCalled()
  })

  it('accountant only reaches the asset routes (read access) and the ledger routes', async () => {
    asUser([LEDGER])
    await renderShellAt('/rules')

    expect(await screen.findByText('rules page')).not.toBeNull()
    expect(screen.queryByTestId('permission-denied')).toBeNull()
  })

  it('manager only reaches /assets/new', async () => {
    asUser([ASSETS])
    await renderShellAt('/assets/new')

    expect(await screen.findByText('register page')).not.toBeNull()
  })
})

describe('scope states', () => {
  it('shows a loading skeleton with a polite status line until /scope answers, then the page', async () => {
    getScope.mockReturnValue(new Promise(() => undefined))
    await renderShellAt('/assets')

    expect(screen.getByRole('status').textContent).toContain('Loading inventory')
    expect(screen.getByTestId('skeleton-list-rows')).not.toBeNull()
    expect(screen.queryByText('assets page')).toBeNull()
  })

  it('shows "no entity in your scope" instead of the page when both lists are empty, tabs kept', async () => {
    asUser([ASSETS], { asset: [], ledger: [] })
    await renderShellAt('/assets')

    expect(await screen.findByRole('heading', { level: 2, name: 'No entity in your scope' })).not.toBeNull()
    expect(screen.getByText(/ask an administrator/i)).not.toBeNull()
    expect(screen.queryByText('assets page')).toBeNull()
    expect(tabLabels()).toEqual(['Assets'])
  })

  it('the empty-scope state is plain page text, not an alert', async () => {
    asUser([ASSETS], { asset: [], ledger: [] })
    await renderShellAt('/assets')

    await screen.findByRole('heading', { level: 2, name: 'No entity in your scope' })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('renders the page when only the ledger scope is non-empty (an accountant with no asset entity)', async () => {
    asUser([LEDGER], { asset: [], ledger: ['welld_it'] })
    await renderShellAt('/assets')

    expect(await screen.findByText('assets page')).not.toBeNull()
    expect(screen.queryByText('No entity in your scope')).toBeNull()
  })

  it('503 from /scope shows the authorization-unavailable banner with Retry, and Retry recovers', async () => {
    getScope.mockRejectedValueOnce(new ApiError({ status: 503, title: 'Service Unavailable' }))
    await renderShellAt('/assets')

    const banner = await screen.findByRole('alert')
    expect(banner.textContent).toContain('Authorization service unavailable')
    expect(banner.textContent).toContain('Nothing was changed.')
    expect(screen.queryByText('assets page')).toBeNull()

    fireEvent.click(screen.getByTestId('error-banner-retry'))

    expect(await screen.findByText('assets page')).not.toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(getScope).toHaveBeenCalledTimes(2)
  })

  it('another ApiError shows its detail in the banner', async () => {
    getScope.mockRejectedValueOnce(new ApiError({ status: 500, title: 'Internal', detail: 'Scope lookup failed.' }))
    await renderShellAt('/assets')

    expect((await screen.findByRole('alert')).textContent).toContain('Scope lookup failed.')
    expect(screen.queryByTestId('error-banner-heading')).toBeNull()
  })

  it('a network failure shows the generic retry banner', async () => {
    getScope.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await renderShellAt('/assets')

    expect((await screen.findByRole('alert')).textContent).toContain('Could not reach the server')
    expect(screen.getByTestId('error-banner-retry')).not.toBeNull()
  })

  it('a 403 from /scope renders PermissionDenied, with no Retry', async () => {
    getScope.mockRejectedValueOnce(new ApiError({ status: 403, title: 'Forbidden' }))
    await renderShellAt('/assets')

    expect(await screen.findByTestId('permission-denied')).not.toBeNull()
    expect(screen.queryByTestId('error-banner-retry')).toBeNull()
  })

  it('keeps the heading and tabs on screen while the scope is loading or failed (the chrome never blanks)', async () => {
    getScope.mockRejectedValueOnce(new ApiError({ status: 503, title: 'x' }))
    await renderShellAt('/assets')
    await screen.findByRole('alert')

    expect(screen.getByRole('heading', { level: 1, name: 'Inventory' })).not.toBeNull()
    expect(tabLabels()).toEqual(['Assets', 'Depreciation rules', 'Fiscal years'])
  })
})
