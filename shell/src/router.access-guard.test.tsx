/**
 * @vitest-environment jsdom
 *
 * Integration tests for the app-access route guard (T25,
 * specs/004-auth-roles-permissions, US-7, AC-7.3/7.4/7.5): a tool route the
 * signed-in user lacks `access` for must never mount that tool's remote —
 * it redirects to a permitted tool, or to `/no-access` (Screen S1) if the
 * user has none at all — and a revocation is caught on the very next
 * navigation, without requiring a reload.
 *
 * Mirrors router.integration.test.tsx / router.root-redirect.test.tsx's
 * technique (real RouterProvider + `window.history` navigation, federated
 * remotes mocked via `vi.mock`) since the guard is a `beforeLoad` that must
 * be exercised through real route resolution to prove the REDIRECT (not
 * just that some function returns the right value).
 *
 * `ensurePermissions`/`revalidatePermissions`/`usePermissions` are mocked
 * directly (not the underlying `/authz/me` fetch) — done when unit-testing
 * shell/session's own contract (session.test.ts, T23); here the concern is
 * purely "does the router redirect correctly given a resolved permission
 * set", so a real backend is unnecessary (per this task's done-when: "a
 * full e2e run needs the backend; a unit/component-level guard test is
 * sufficient for done").
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { RouterProvider } from '@tanstack/react-router'
import type { PermissionsResult } from './lib/session'

// ---------------------------------------------------------------------------
// Module mocks — hoisted above imports/dynamic imports of the modules they
// replace. `vi.hoisted` lets the mock functions be configured per-test.
// ---------------------------------------------------------------------------

const { getSession, ensurePermissions, revalidatePermissions, usePermissions } = vi.hoisted(() => ({
  getSession: vi.fn(),
  ensurePermissions: vi.fn(),
  revalidatePermissions: vi.fn(),
  usePermissions: vi.fn(),
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
}))

vi.mock('estimai/App', () => ({
  default: () => <div data-testid="estimai-app">EstimAI mounted</div>,
}))

vi.mock('refund/App', () => ({
  default: () => <div data-testid="refund-app">Refund mounted</div>,
}))

vi.mock('admin/App', () => ({
  default: () => <div data-testid="admin-app">Admin mounted</div>,
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const permissionsWith = (apps: string[]): PermissionsResult => ({
  epoch: 0,
  apps,
  roles: [],
  departments: [],
  permissions: [],
})

/**
 * Navigates the (real) jsdom location to `path` BEFORE constructing the
 * router, then imports router.tsx fresh (cache-busted) so the module-scope
 * `router` singleton it creates picks up that location as its initial
 * match — same technique as router.integration.test.tsx's `renderShellAt`.
 */
async function renderShellAt(path: string) {
  window.history.pushState(null, '', path)
  const mod = await import('./router?t=' + Date.now())
  const utils = render(<RouterProvider router={mod.router} />)
  return { router: mod.router, ...utils }
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.stubEnv('VITE_AUTH_URL', 'http://auth.test')
  getSession.mockResolvedValue({
    data: { user: { id: 'u1', email: 'consultant@welld.ch', name: 'Consultant' }, session: {} },
  })
  usePermissions.mockReturnValue(permissionsWith(['estimai', 'refund', 'admin']))
})

afterEach(() => {
  cleanup()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  vi.resetModules()
  window.history.pushState(null, '', '/')
  localStorage.clear()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('tool-route access guard (AC-7.3: deep-link to an un-permitted tool is blocked)', () => {
  it('deep-linking to /admin without the admin app redirects to a permitted tool, never mounting admin-ui', async () => {
    ensurePermissions.mockResolvedValue(permissionsWith(['estimai']))
    revalidatePermissions.mockResolvedValue(permissionsWith(['estimai']))

    const { router } = await renderShellAt('/admin')

    expect(await screen.findByTestId('estimai-app')).not.toBeNull()
    expect(screen.queryByTestId('admin-app')).toBeNull()
    expect(router.state.location.pathname).toBe('/estimai')
  })

  it('deep-linking to /refund without the refund app falls through to the next permitted tool (admin)', async () => {
    ensurePermissions.mockResolvedValue(permissionsWith(['admin']))
    revalidatePermissions.mockResolvedValue(permissionsWith(['admin']))

    const { router } = await renderShellAt('/refund')

    expect(await screen.findByTestId('admin-app')).not.toBeNull()
    expect(screen.queryByTestId('refund-app')).toBeNull()
    expect(router.state.location.pathname).toBe('/admin')
  })

  it('deep-linking to /admin WITH the admin app mounts admin-ui and records it as the last-used tool', async () => {
    ensurePermissions.mockResolvedValue(permissionsWith(['estimai', 'admin']))
    revalidatePermissions.mockResolvedValue(permissionsWith(['estimai', 'admin']))

    await renderShellAt('/admin')

    expect(await screen.findByTestId('admin-app')).not.toBeNull()
    expect(localStorage.getItem('operai_last_tool')).toBe('admin')
  })
})

describe('zero-apps user (AC-7.4: /no-access, Screen S1)', () => {
  it('deep-linking to a tool route with zero apps redirects to /no-access', async () => {
    ensurePermissions.mockResolvedValue(permissionsWith([]))
    revalidatePermissions.mockResolvedValue(permissionsWith([]))

    const { router } = await renderShellAt('/admin')

    expect(await screen.findByRole('heading', { name: 'No apps available yet' })).not.toBeNull()
    expect(screen.queryByTestId('admin-app')).toBeNull()
    expect(router.state.location.pathname).toBe('/no-access')
  })

  it('the root "/" redirect lands on /no-access when apps is empty, instead of any tool', async () => {
    ensurePermissions.mockResolvedValue(permissionsWith([]))
    revalidatePermissions.mockResolvedValue(permissionsWith([]))

    const { router } = await renderShellAt('/')

    expect(await screen.findByRole('heading', { name: 'No apps available yet' })).not.toBeNull()
    expect(router.state.location.pathname).toBe('/no-access')
  })

  it('the root "/" redirect still lands on the last-used tool when apps is non-empty', async () => {
    ensurePermissions.mockResolvedValue(permissionsWith(['refund']))
    revalidatePermissions.mockResolvedValue(permissionsWith(['refund']))
    localStorage.setItem('operai_last_tool', 'refund')

    const { router } = await renderShellAt('/')

    expect(await screen.findByTestId('refund-app')).not.toBeNull()
    expect(router.state.location.pathname).toBe('/refund')
  })
})

describe('revocation is blocked on the very next navigation, no reload required (AC-7.5)', () => {
  it('a tool granted at page-load time but revoked mid-session is blocked the next time it is navigated to', async () => {
    // Page loads with admin access.
    ensurePermissions.mockResolvedValue(permissionsWith(['estimai', 'admin']))
    revalidatePermissions.mockResolvedValue(permissionsWith(['estimai', 'admin']))

    const { router } = await renderShellAt('/estimai')
    expect(await screen.findByTestId('estimai-app')).not.toBeNull()

    // Access is revoked server-side sometime after the page loaded. The
    // route guard force-revalidates on every navigation (not the cached
    // ensurePermissions), so the very next in-app navigation sees it —
    // no reload of the page needed.
    revalidatePermissions.mockResolvedValue(permissionsWith(['estimai']))

    await router.navigate({ to: '/admin' })

    expect(await screen.findByTestId('estimai-app')).not.toBeNull()
    expect(screen.queryByTestId('admin-app')).toBeNull()
    expect(router.state.location.pathname).toBe('/estimai')
  })

  it('calls revalidatePermissions (force-refetch), not just the cached ensurePermissions, on a tool-route navigation', async () => {
    ensurePermissions.mockResolvedValue(permissionsWith(['estimai']))
    revalidatePermissions.mockResolvedValue(permissionsWith(['estimai']))

    await renderShellAt('/estimai')
    await screen.findByTestId('estimai-app')

    expect(revalidatePermissions).toHaveBeenCalled()
  })
})
