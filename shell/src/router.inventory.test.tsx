/**
 * @vitest-environment jsdom
 *
 * Tests for the `/inventory/$` tool route and the ungated `/devices` route
 * (specs/015-hardware-inventory, T42, AC-4.1, AC-9.6; ADR-0045 — the plan's
 * R-5 early check: one remote, two entries, two different guards).
 *
 * Mirrors router.account.test.tsx / router.notify.test.tsx: real RouterProvider,
 * `window.history` navigation, federated remotes mocked via `vi.mock`,
 * `./router` re-imported fresh per test.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
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
// `inventory/MyDevices` is registered with vi.doMock in beforeEach (not the
// hoisted vi.mock) so the failing-remote test can replace it and the next test
// gets the healthy one back — a doMock registration outlives vi.resetModules.

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
  vi.doMock('inventory/MyDevices', () => ({
    default: () => <div data-testid="my-devices">My devices mounted</div>,
  }))
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

describe('/inventory/$ — the access-gated tool route (AC-9.6)', () => {
  it('mounts inventory/App for a caller granted inventory, and records it as the last tool', async () => {
    grantApps(['inventory'])

    const { router } = await renderShellAt('/inventory')

    expect(await screen.findByTestId('inventory-app')).not.toBeNull()
    expect(router.state.location.pathname).toBe('/inventory')
    expect(localStorage.getItem('operai_last_tool')).toBe('inventory')
  })

  it('mounts inventory/App for a deep link below /inventory', async () => {
    grantApps(['inventory'])

    await renderShellAt('/inventory/assets/abc')

    expect(await screen.findByTestId('inventory-app')).not.toBeNull()
  })

  it('redirects a caller with NO grants to /no-access, with no Inventory sidebar entry', async () => {
    grantApps([])

    const { router } = await renderShellAt('/inventory')

    expect(await screen.findByRole('heading', { name: 'No apps available yet' })).not.toBeNull()
    expect(router.state.location.pathname).toBe('/no-access')
    expect(screen.queryByTestId('inventory-app')).toBeNull()
    expect(screen.queryByRole('link', { name: 'Inventory' })).toBeNull()
    expect(localStorage.getItem('operai_last_tool')).toBeNull()
  })

  it('redirects a caller granted only another tool to that tool', async () => {
    grantApps(['estimai'])

    const { router } = await renderShellAt('/inventory')

    expect(await screen.findByTestId('estimai-app')).not.toBeNull()
    expect(router.state.location.pathname).toBe('/estimai')
  })

  it('shows the Inventory sidebar link only to a caller granted inventory', async () => {
    grantApps(['estimai', 'inventory'])
    await renderShellAt('/estimai')
    await screen.findByTestId('estimai-app')
    expect(screen.getByRole('link', { name: 'Inventory' }).getAttribute('href')).toBe('/inventory')
  })

  it('carries an app-access beforeLoad on /inventory/$ and none on /devices (ADR-0045)', async () => {
    grantApps(['inventory'])
    const { router } = await renderShellAt('/inventory')
    await screen.findByTestId('inventory-app')

    const routes = router.routesByPath as Record<string, { options: { beforeLoad?: unknown } }>
    expect(typeof routes['/inventory/$'].options.beforeLoad).toBe('function')
    expect(routes['/devices'].options.beforeLoad).toBeUndefined()
  })
})

describe('/devices — the ungated, identity-scoped route (AC-4.1, ADR-0045)', () => {
  it('mounts inventory/MyDevices for a caller with ZERO grants, with no redirect', async () => {
    grantApps([])

    const { router } = await renderShellAt('/devices')

    expect(await screen.findByTestId('my-devices')).not.toBeNull()
    expect(router.state.location.pathname).toBe('/devices')
    expect(screen.queryByRole('heading', { name: 'No apps available yet' })).toBeNull()
    // The tool itself stays invisible to this user (AC-9.6).
    expect(screen.queryByRole('link', { name: 'Inventory' })).toBeNull()
  })

  it('does not write operai_last_tool, and leaves a previously recorded tool untouched', async () => {
    grantApps(['estimai'])
    localStorage.setItem('operai_last_tool', 'refund')

    await renderShellAt('/devices')

    await screen.findByTestId('my-devices')
    expect(localStorage.getItem('operai_last_tool')).toBe('refund')
  })

  it('does not write operai_last_tool when it was empty either', async () => {
    grantApps(['inventory'])

    await renderShellAt('/devices')

    await screen.findByTestId('my-devices')
    expect(localStorage.getItem('operai_last_tool')).toBeNull()
  })

  it('shows RemoteMount\'s error state inside an intact shell when the remote fails to load', async () => {
    // Makes `import('inventory/MyDevices')` reject, as a failed remoteEntry.js fetch would.
    vi.doMock('inventory/MyDevices', () => {
      throw new Error('Failed to fetch remoteEntry.js')
    })
    grantApps([])

    await renderShellAt('/devices')

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain("My devices couldn't load")
    expect(screen.getByRole('button', { name: 'Retry' })).not.toBeNull()
    // Chrome untouched: the user menu is still there to leave the page.
    expect(screen.getByRole('button', { name: 'Consultant' })).not.toBeNull()
  })

  it('is reached through the "My devices" menu row from any tool', async () => {
    grantApps(['estimai'])
    const { router } = await renderShellAt('/estimai')
    await screen.findByTestId('estimai-app')

    fireEvent.click(screen.getByRole('button', { name: 'Consultant' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'My devices' }))

    expect(await screen.findByTestId('my-devices')).not.toBeNull()
    expect(router.state.location.pathname).toBe('/devices')
  })
})
