/**
 * @vitest-environment jsdom
 *
 * Tests for the `/notify` route registration (T13, specs/005-notification-
 * center, US-2 AC-2.1; plan.md "Shell changes" + "The `/notify` route is
 * deliberately NOT a permission-gated `tools.ts` entry").
 *
 * Two properties, both required by this task's done-when:
 *
 *   1. The `notify` remote mounts at `/notify` (mirrors
 *      router.integration.test.tsx's deep-link technique: real
 *      RouterProvider + `window.history` navigation, the federated remote
 *      mocked via `vi.mock`) — including for a caller with ZERO granted
 *      apps, proving the route has no app-access `beforeLoad` guard (unlike
 *      `/estimai`, `/refund`, `/admin`, which redirect a zero-apps caller to
 *      `/no-access` — see router.access-guard.test.tsx).
 *   2. `/notify` is absent from the permission-filtered sidebar `TOOLS`
 *      list — asserted both at the data level (`shell/src/lib/tools.ts`'s
 *      `TOOLS` array never contains a `notify` entry, so it structurally
 *      cannot leak into Sidebar's `usePermissions().apps`-filtered render)
 *      and at the component level (Sidebar renders no "notify"-named link
 *      even when the mocked permissions grant every known app).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { RouterProvider, createRootRoute, createRoute, createRouter, Outlet } from '@tanstack/react-router'

// ---------------------------------------------------------------------------
// Module mocks — hoisted above imports/dynamic imports of the modules they
// replace (mirrors router.integration.test.tsx / router.access-guard.test.tsx).
// ---------------------------------------------------------------------------

const { getSession, usePermissions, ensurePermissions, revalidatePermissions } = vi.hoisted(() => ({
  getSession: vi.fn(),
  usePermissions: vi.fn(),
  ensurePermissions: vi.fn(),
  revalidatePermissions: vi.fn(),
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
  // Bug fix (2026-07, shell/src/router.tsx's `_authed` guard): `null` (cold
  // cache) keeps every test in this file exercising the async `getSession()`
  // branch, exactly as before this getter existed (see
  // router.session-guard.test.tsx for the synchronous warm-cache fast path).
  getCachedSession: vi.fn(() => null),
  // T11 (specs/005): Header mounts Bell → useUnreadCount() (notifications.ts),
  // which imports apiFetch/onSignOut from this module. Mounting the router in
  // these tests renders the chrome, so the session mock must supply them
  // (fail-closed no-ops — the SSE ticket-mint just degrades gracefully).
  apiFetch: vi.fn(),
  onSignOut: vi.fn(),
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

vi.mock('notify/App', () => ({
  default: () => <div data-testid="notify-app">Notify mounted</div>,
}))

import Sidebar from './components/Sidebar'
import { SidebarCollapsedProvider } from './hooks/SidebarCollapsedProvider'
import { TOOLS } from './lib/tools'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const permissionsWith = (apps: string[]) => ({
  epoch: 0,
  apps,
  roles: [],
  departments: [],
  permissions: [],
})

/**
 * Navigates the (real) jsdom location to `path` BEFORE constructing the
 * router, then imports router.tsx fresh (cache-busted) so the module-scope
 * `router` singleton it creates picks up that location as its initial match
 * — same technique as router.integration.test.tsx's `renderShellAt`.
 */
async function renderShellAt(path: string) {
  window.history.pushState(null, '', path)
  const mod = await import('./router?t=' + Date.now())
  const utils = render(<RouterProvider router={mod.router} />)
  return { router: mod.router, ...utils }
}

/** Minimal router harness for Sidebar alone (mirrors Sidebar.test.tsx). */
async function renderSidebarAt(path: string) {
  window.history.pushState(null, '', path)

  const rootRoute = createRootRoute({
    component: () => (
      <SidebarCollapsedProvider>
        <Sidebar />
        <Outlet />
      </SidebarCollapsedProvider>
    ),
  })
  const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: '/' })
  const estimaiRoute = createRoute({ getParentRoute: () => rootRoute, path: '/estimai/$' })
  const refundRoute = createRoute({ getParentRoute: () => rootRoute, path: '/refund/$' })
  const adminRoute = createRoute({ getParentRoute: () => rootRoute, path: '/admin/$' })
  const routeTree = rootRoute.addChildren([indexRoute, estimaiRoute, refundRoute, adminRoute])
  const router = createRouter({ routeTree })
  const utils = render(<RouterProvider router={router} />)
  await screen.findByRole('button', { name: /collapse sidebar|expand sidebar/i })
  return { router, ...utils }
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.stubEnv('VITE_AUTH_URL', 'http://auth.test')
  getSession.mockResolvedValue({
    data: { user: { id: 'u1', email: 'consultant@welld.ch', name: 'Consultant' }, session: {} },
  })
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

describe('/notify route registration (T13, AC-2.1)', () => {
  it('mounts the notify remote at /notify for a fully-permissioned caller', async () => {
    usePermissions.mockReturnValue(permissionsWith(['estimai', 'refund', 'admin']))
    ensurePermissions.mockResolvedValue(permissionsWith(['estimai', 'refund', 'admin']))
    revalidatePermissions.mockResolvedValue(permissionsWith(['estimai', 'refund', 'admin']))

    const { router } = await renderShellAt('/notify')

    expect(await screen.findByTestId('notify-app')).not.toBeNull()
    expect(router.state.location.pathname).toBe('/notify')
  })

  it('mounts the notify remote at a deep-linked /notify sub-path (own inner router)', async () => {
    usePermissions.mockReturnValue(permissionsWith(['estimai', 'refund', 'admin']))
    ensurePermissions.mockResolvedValue(permissionsWith(['estimai', 'refund', 'admin']))
    revalidatePermissions.mockResolvedValue(permissionsWith(['estimai', 'refund', 'admin']))

    await renderShellAt('/notify/some/inner/path')

    expect(await screen.findByTestId('notify-app')).not.toBeNull()
  })

  it('mounts the notify remote even for a caller with ZERO granted apps — NOT app-access-gated (plan.md "Shell changes")', async () => {
    usePermissions.mockReturnValue(permissionsWith([]))
    ensurePermissions.mockResolvedValue(permissionsWith([]))
    revalidatePermissions.mockResolvedValue(permissionsWith([]))

    const { router } = await renderShellAt('/notify')

    // A zero-apps caller navigating to any OTHER tool route lands on
    // /no-access (router.access-guard.test.tsx) — /notify must behave
    // differently: it renders regardless.
    expect(await screen.findByTestId('notify-app')).not.toBeNull()
    expect(screen.queryByRole('heading', { name: 'No apps available yet' })).toBeNull()
    expect(router.state.location.pathname).toBe('/notify')
  })

  it('does not record notify as the last-used tool (no ToolId exists for it)', async () => {
    usePermissions.mockReturnValue(permissionsWith(['estimai']))
    ensurePermissions.mockResolvedValue(permissionsWith(['estimai']))
    revalidatePermissions.mockResolvedValue(permissionsWith(['estimai']))

    await renderShellAt('/notify')

    await screen.findByTestId('notify-app')
    expect(localStorage.getItem('operai_last_tool')).toBeNull()
  })
})

describe('/notify absent from the permission-filtered sidebar TOOLS list (plan.md "Shell changes")', () => {
  it('TOOLS (shell/src/lib/tools.ts) contains no entry for "notify"', () => {
    const ids: string[] = TOOLS.map(tool => tool.id)
    expect(ids.includes('notify')).toBe(false)
    expect(TOOLS.some(tool => tool.to === '/notify')).toBe(false)
  })

  it('Sidebar renders no "notify" link even when permissions grant every known app', async () => {
    usePermissions.mockReturnValue(permissionsWith(['estimai', 'refund', 'admin', 'notify']))
    await renderSidebarAt('/estimai')

    expect(screen.queryByRole('link', { name: /notify/i })).toBeNull()
    // The three real tools still render — filtering isn't accidentally
    // hiding everything, just correctly omitting the non-existent entry.
    expect(screen.getAllByRole('link')).toHaveLength(3)
  })
})
