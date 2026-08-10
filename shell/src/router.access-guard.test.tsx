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

const { getSession, ensurePermissions, revalidatePermissions, usePermissions, getCachedPermissions, getCachedSession } =
  vi.hoisted(() => ({
    getSession: vi.fn(),
    ensurePermissions: vi.fn(),
    revalidatePermissions: vi.fn(),
    usePermissions: vi.fn(),
    getCachedPermissions: vi.fn(),
    getCachedSession: vi.fn(),
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
  // Bug fix (2026-07, shell/src/router.tsx's createToolAccessBeforeLoad): the
  // synchronous same-app fast path reads the cache via this getter instead of
  // ensurePermissions/revalidatePermissions. Defaults to `null` (cold cache)
  // below so every EXISTING test in this file keeps exercising the async
  // (revalidate) branch exactly as before — tests that specifically want the
  // sync fast path override this per-test.
  getCachedPermissions,
  // Same fix, same shape, for the `_authed` session guard — defaults to a
  // warm, session-present cache (this file exercises the ACCESS guard, not
  // the session guard; it must never redirect to sign-in) so the `_authed`
  // guard resolves synchronously and out of the way of every test here. This
  // ALSO means these tests never call the mocked `getSession()` — asserted
  // nowhere here, but see router.session-guard.test.tsx for that behavior.
  getCachedSession,
  // T11 (specs/005-notification-center): Header now mounts Bell, which reads
  // useUnreadCount() (shell/src/lib/notifications.ts) on every render of the
  // shared chrome these tests exercise via ShellLayout/Header. notifications.ts
  // imports apiFetch/onSignOut from this same module, so a mock of
  // './lib/session' that omits them breaks — not because these tests care
  // about notifications, but because the mocked module must still satisfy
  // every export the transitively-rendered chrome touches. apiFetch resolving
  // to nothing (undefined) makes the SSE manager's ticket mint fail closed
  // (mirrors "signed out" — see notifications.ts's mintStreamTicket try/catch),
  // so Bell just renders with 0 unread here, harmlessly.
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
  getCachedPermissions.mockReturnValue(null)
  // Warm session cache by default — this file is about the ACCESS guard, not
  // the session guard, so the `_authed` guard should resolve synchronously
  // and never redirect to sign-in here.
  getCachedSession.mockReturnValue({
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

// ---------------------------------------------------------------------------
// Bug fix (2026-07): same-app (inner-route) navigation must resolve the
// access guard SYNCHRONOUSLY from the cached permissions — no
// `revalidatePermissions` call, no pending fallback, and (proven at the
// integration level in router.integration.test.tsx) no remote teardown/
// remount. An app switch, or a cold permissions cache, must still
// force-revalidate and show the pending fallback exactly as before.
// ---------------------------------------------------------------------------

describe('same-app navigation resolves the access guard synchronously (bug fix 2026-07)', () => {
  it('does NOT call revalidatePermissions and does NOT show the pending fallback for an inner-route change within the same tool', async () => {
    const permissions = permissionsWith(['estimai', 'refund', 'admin'])
    ensurePermissions.mockResolvedValue(permissions)
    revalidatePermissions.mockResolvedValue(permissions)

    // First navigation into /estimai is necessarily a cold-cache app entry —
    // it goes through the async (revalidate) branch, which is what records
    // 'estimai' as the last-used tool (recordLastTool runs at the END of
    // that branch). Only AFTER that has this test simulate a warm cache.
    const { router } = await renderShellAt('/estimai/requests')
    const firstEstimaiNode = await screen.findByTestId('estimai-app')

    getCachedPermissions.mockReturnValue(permissions)
    revalidatePermissions.mockClear()

    await router.navigate({ to: '/estimai/requests/123' })

    // Same DOM node — the remote was never unmounted/remounted, only the
    // inner route (which the remote's OWN router resolves) changed.
    expect(await screen.findByTestId('estimai-app')).toBe(firstEstimaiNode)
    expect(revalidatePermissions).not.toHaveBeenCalled()
    expect(screen.queryByTestId('route-pending')).toBeNull()
  })

  it('still enforces the access decision from the cached permissions on same-app navigation (redirects if the cache no longer grants the tool)', async () => {
    const adminGranted = permissionsWith(['admin'])
    ensurePermissions.mockResolvedValue(adminGranted)
    revalidatePermissions.mockResolvedValue(adminGranted)

    const { router } = await renderShellAt('/admin')
    await screen.findByTestId('admin-app')

    // Simulate the cached permissions snapshot no longer granting ANY app
    // (redirect target is /no-access, which has NO `beforeLoad` of its own —
    // isolating this assertion to the admin route's OWN synchronous
    // decision, uncontaminated by a fallback tool's own guard also running).
    getCachedPermissions.mockReturnValue(permissionsWith([]))
    revalidatePermissions.mockClear()

    await router.navigate({ to: '/admin/users' })

    expect(await screen.findByRole('heading', { name: 'No apps available yet' })).not.toBeNull()
    expect(screen.queryByTestId('admin-app')).toBeNull()
    expect(router.state.location.pathname).toBe('/no-access')
    // Proves the redirect came from the SYNCHRONOUS cached-permissions path,
    // not a fallthrough to the async revalidate branch.
    expect(revalidatePermissions).not.toHaveBeenCalled()
  })

  it('an app switch still force-revalidates and shows the pending fallback while it resolves', async () => {
    const permissions = permissionsWith(['estimai', 'refund'])
    ensurePermissions.mockResolvedValue(permissions)
    revalidatePermissions.mockResolvedValue(permissions)

    const { router } = await renderShellAt('/estimai')
    await screen.findByTestId('estimai-app')

    let resolveRevalidate!: (value: PermissionsResult) => void
    revalidatePermissions.mockImplementation(
      () =>
        new Promise<PermissionsResult>((resolve) => {
          resolveRevalidate = resolve
        }),
    )

    const navigation = router.navigate({ to: '/refund' })

    // The pending fallback shows for the DURATION of the forced revalidate.
    // (Whether React keeps the outgoing estimai Suspense subtree in the DOM
    // hidden via `display:none` while its own boundary re-suspends is a
    // React/TanStack Suspense reconciliation detail, orthogonal to this
    // guard's sync-vs-async behavior — not asserted here.)
    expect(await screen.findByTestId('route-pending')).not.toBeNull()
    expect(screen.queryByTestId('refund-app')).toBeNull()

    resolveRevalidate(permissions)
    await navigation

    expect(await screen.findByTestId('refund-app')).not.toBeNull()
    expect(screen.queryByTestId('route-pending')).toBeNull()
  })

  it('a cold permissions cache still force-revalidates even when a stale operai_last_tool (from a previous session) happens to match', async () => {
    // Simulates a fresh page load / hard refresh: localStorage carries the
    // last-used tool from a PRIOR session, but this session's in-memory
    // permissions cache is empty (getCachedPermissions() -> null) —
    // "same tool by localStorage" must never substitute for a real cache hit.
    localStorage.setItem('operai_last_tool', 'estimai')
    getCachedPermissions.mockReturnValue(null)
    ensurePermissions.mockResolvedValue(permissionsWith(['estimai']))
    revalidatePermissions.mockResolvedValue(permissionsWith(['estimai']))

    await renderShellAt('/estimai')

    expect(await screen.findByTestId('estimai-app')).not.toBeNull()
    expect(revalidatePermissions).toHaveBeenCalled()
  })

  it('a preload does not corrupt same-app detection for the real navigation that follows it', async () => {
    const permissions = permissionsWith(['estimai', 'refund'])
    ensurePermissions.mockResolvedValue(permissions)
    revalidatePermissions.mockResolvedValue(permissions)

    const { router } = await renderShellAt('/estimai')
    await screen.findByTestId('estimai-app')
    revalidatePermissions.mockClear()

    // Hover-intent preload of a DIFFERENT tool must not write operai_last_tool
    // — if it did, the real navigation that follows would look like "same
    // app" (last-written id === 'refund') and wrongly take the synchronous
    // cached-permissions path instead of revalidating.
    await router.preloadRoute({ to: '/refund' })
    expect(localStorage.getItem('operai_last_tool')).toBe('estimai')

    revalidatePermissions.mockClear()
    await router.navigate({ to: '/refund' })

    expect(await screen.findByTestId('refund-app')).not.toBeNull()
    expect(revalidatePermissions).toHaveBeenCalled()
    expect(localStorage.getItem('operai_last_tool')).toBe('refund')
  })
})
