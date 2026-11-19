/**
 * @vitest-environment jsdom
 *
 * Tests for the `/accounting/$` tool route (specs/20261119-accounting, T32, AC-8.1, AC-3.6, AC-3.9): the Accounting module
 * appears in the suite only for a caller whose `apps` include `accounting`, the same gate the other tools sit behind. `/authz/me`
 * DERIVES that entry from `accounting:read` or `accounting:manage` covering at least one entity (ADR
 * 20261117-an-app-is-reachable-… amendment A6); the shell reads `apps` and evaluates no entity condition, and accounting-api
 * enforces every route. There is no `accounting:access` permission.
 *
 * Mirrors router.letterheads.test.tsx: real RouterProvider, `window.history` navigation, federated remotes mocked via
 * `vi.mock`, `./router` re-imported fresh per test.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { RouterProvider } from '@tanstack/react-router'

const { getSession, usePermissions, ensurePermissions, revalidatePermissions, apiFetch } = vi.hoisted(() => ({
  getSession: vi.fn(),
  usePermissions: vi.fn(),
  ensurePermissions: vi.fn(),
  revalidatePermissions: vi.fn(),
  apiFetch: vi.fn(),
}))

vi.mock('./lib/session', () => ({
  getSession,
  useSession: vi.fn(() => ({
    data: { user: { id: 'u1', email: 'consultant@welld.ch', name: 'Consultant' } },
  })),
  signOut: vi.fn(),
  usePermissions,
  ensurePermissions,
  revalidatePermissions,
  getCachedSession: vi.fn(() => null),
  getCachedPermissions: vi.fn(() => null),
  apiFetch,
  onSignOut: vi.fn(),
  getAuthBaseUrl: vi.fn(() => 'http://auth.test'),
}))

vi.mock('estimai/App', () => ({ default: () => <div data-testid="estimai-app">EstimAI mounted</div> }))
vi.mock('refund/App', () => ({ default: () => <div data-testid="refund-app">Refund mounted</div> }))
vi.mock('admin/App', () => ({ default: () => <div data-testid="admin-app">Admin mounted</div> }))
vi.mock('notify/App', () => ({ default: () => <div data-testid="notify-app">Notify mounted</div> }))
vi.mock('inventory/App', () => ({ default: () => <div data-testid="inventory-app">Inventory mounted</div> }))
vi.mock('crm/App', () => ({ default: () => <div data-testid="crm-app">CRM mounted</div> }))
vi.mock('projects/App', () => ({ default: () => <div data-testid="projects-app">Projects mounted</div> }))
vi.mock('letterheads/App', () => ({
  default: () => <div data-testid="letterheads-app">Letterheads mounted</div>,
}))
vi.mock('accounting/App', () => ({
  default: () => <div data-testid="accounting-app">Accounting mounted</div>,
}))

const permissionsWith = (apps: string[]) => ({
  epoch: 0,
  apps,
  roles: [],
  departments: [],
  permissions: [],
})

function grantApps(apps: string[]) {
  usePermissions.mockReturnValue(permissionsWith(apps))
  ensurePermissions.mockResolvedValue(permissionsWith(apps))
  revalidatePermissions.mockResolvedValue(permissionsWith(apps))
}

async function renderShellAt(path: string) {
  window.history.pushState(null, '', path)
  const mod = await import('./router?t=' + Date.now())
  const utils = render(<RouterProvider router={mod.router} />)
  return { router: mod.router, ...utils }
}

beforeEach(() => {
  vi.stubEnv('VITE_AUTH_URL', 'http://auth.test')
  getSession.mockResolvedValue({
    data: { user: { id: 'u1', email: 'consultant@welld.ch', name: 'Consultant' }, session: {} },
  })
  apiFetch.mockResolvedValue({ ok: true, json: async () => ({}) })
})

afterEach(() => {
  cleanup()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  vi.resetModules()
  window.history.pushState(null, '', '/')
  localStorage.clear()
})

describe('/accounting/$ — the access-gated tool route (AC-8.1)', () => {
  it('mounts accounting/App for a caller whose apps include accounting, and records it as the last tool', async () => {
    grantApps(['accounting'])

    const { router } = await renderShellAt('/accounting')

    expect(await screen.findByTestId('accounting-app')).not.toBeNull()
    expect(router.state.location.pathname).toBe('/accounting')
    expect(localStorage.getItem('operai_last_tool')).toBe('accounting')
  })

  it('mounts accounting/App for a deep link below /accounting (the views, the entity and the month)', async () => {
    grantApps(['accounting'])

    const { router } = await renderShellAt('/accounting/exchange-rates?entity=welld_ch&month=2026-03')

    expect(await screen.findByTestId('accounting-app')).not.toBeNull()
    expect(router.state.location.pathname).toBe('/accounting/exchange-rates')
  })

  it('refuses a caller with NO grants at the route (AC-3.6): /no-access, no Accounting sidebar entry, nothing mounted', async () => {
    grantApps([])

    const { router } = await renderShellAt('/accounting')

    expect(await screen.findByRole('heading', { name: 'No apps available yet' })).not.toBeNull()
    expect(router.state.location.pathname).toBe('/no-access')
    expect(screen.queryByTestId('accounting-app')).toBeNull()
    expect(screen.queryByRole('link', { name: 'Accounting' })).toBeNull()
    expect(localStorage.getItem('operai_last_tool')).toBeNull()
  })

  it('refuses a caller granted another tool: sent to that tool, never to Accounting', async () => {
    grantApps(['crm'])

    const { router } = await renderShellAt('/accounting')

    expect(await screen.findByTestId('crm-app')).not.toBeNull()
    expect(router.state.location.pathname).toBe('/crm')
    expect(screen.queryByTestId('accounting-app')).toBeNull()
    expect(screen.queryByRole('link', { name: 'Accounting' })).toBeNull()
  })

  it('does not let refund or admin stand in for accounting (AC-3.9: a Refund reviewer or admin without the capability cannot open it)', async () => {
    grantApps(['refund', 'admin'])

    const { router } = await renderShellAt('/accounting/ledger-accounts')

    // Sent to the first tool they do hold, never to Accounting.
    expect(await screen.findByTestId('refund-app')).not.toBeNull()
    expect(router.state.location.pathname).toBe('/refund')
    expect(screen.queryByTestId('accounting-app')).toBeNull()
    expect(screen.queryByRole('link', { name: 'Accounting' })).toBeNull()
  })

  it('does not let letterheads or projects stand in for accounting', async () => {
    grantApps(['projects', 'letterheads'])

    const { router } = await renderShellAt('/accounting')

    expect(await screen.findByTestId('projects-app')).not.toBeNull()
    expect(router.state.location.pathname).toBe('/projects')
    expect(screen.queryByTestId('accounting-app')).toBeNull()
  })

  it('shows the Accounting sidebar link to a caller whose apps include it, after Projects', async () => {
    grantApps(['estimai', 'projects', 'accounting'])
    await renderShellAt('/estimai')
    await screen.findByTestId('estimai-app')

    const link = screen.getByRole('link', { name: 'Accounting' })
    expect(link.getAttribute('href')).toBe('/accounting')
    const projects = screen.getByRole('link', { name: 'Projects' })
    expect(projects.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('does not show the Accounting sidebar link to a caller without it', async () => {
    grantApps(['estimai', 'projects'])
    await renderShellAt('/estimai')
    await screen.findByTestId('estimai-app')

    expect(screen.queryByRole('link', { name: 'Accounting' })).toBeNull()
  })
})
