/**
 * @vitest-environment jsdom
 *
 * Integration tests for the `_authed` session guard's synchronous warm-cache
 * fast path (bug fix 2026-07, shell/src/router.tsx). Companion to
 * router.access-guard.test.tsx's "same-app navigation resolves the access
 * guard synchronously" describe block — same bug, same fix shape, one guard
 * earlier in the chain (`_authed` wraps `_shell` wraps every tool route).
 *
 * Before this fix, `_authed`'s `beforeLoad` called `getSession()`
 * unconditionally on EVERY navigation — a real async `/get-session` network
 * fetch. Because TanStack Router (`defaultPendingMs: 0`) enters its pending
 * state the instant `beforeLoad` returns a Promise, this unmounted the
 * currently-mounted remote on every navigation, including a same-app
 * inner-route change that should have been invisible to the shell (the exact
 * failure this task fixes — see router.tsx's `_authed` doc comment).
 *
 * Mirrors router.integration.test.tsx / router.access-guard.test.tsx's
 * technique: real RouterProvider + `window.history` navigation, federated
 * remotes mocked via `vi.mock`, `getSession` mocked as a genuinely
 * async/deferred promise (not instantly resolved) so a test that asserts "no
 * pending fallback appeared" is actually proving something — an instantly-
 * resolving mock would mask the very regression this suite exists to catch.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { RouterProvider } from '@tanstack/react-router'

// ---------------------------------------------------------------------------
// Module mocks — hoisted above imports/dynamic imports of the modules they
// replace. vi.hoisted lets the mock functions be configured per-test.
// ---------------------------------------------------------------------------

const { getSession, getCachedSession, ensurePermissions, revalidatePermissions, usePermissions, getCachedPermissions } =
  vi.hoisted(() => ({
    getSession: vi.fn(),
    getCachedSession: vi.fn(),
    ensurePermissions: vi.fn(),
    revalidatePermissions: vi.fn(),
    usePermissions: vi.fn(),
    getCachedPermissions: vi.fn(),
  }))

vi.mock('./lib/session', () => ({
  getSession,
  useSession: vi.fn(() => ({
    data: { user: { id: 'u1', email: 'consultant@welld.ch', name: 'Consultant' } },
  })),
  signOut: vi.fn(),
  // Bug fix under test — the synchronous fast path this guard's beforeLoad
  // now checks first.
  getCachedSession,
  // The tool routes' OWN access guard (createToolAccessBeforeLoad) sits
  // between `_authed` and the mounted remote in the matched chain — these
  // tests grant every app up front so that guard never interferes with what
  // this file is actually testing (the session guard, one level up).
  usePermissions,
  ensurePermissions,
  revalidatePermissions,
  getCachedPermissions,
  // T11 (specs/005-notification-center): Header mounts Bell, which reads
  // useUnreadCount() (shell/src/lib/notifications.ts) on every render of the
  // shared chrome these tests exercise. notifications.ts imports
  // apiFetch/onSignOut from this same module.
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

const SESSION_FIXTURE = {
  data: { user: { id: 'u1', email: 'consultant@welld.ch', name: 'Consultant' }, session: {} },
}

const GRANTED_PERMISSIONS = {
  epoch: 0,
  apps: ['estimai', 'refund', 'admin'],
  roles: [],
  departments: [],
  permissions: [],
}

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

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.stubEnv('VITE_AUTH_URL', 'http://auth.test')

  usePermissions.mockReturnValue(GRANTED_PERMISSIONS)
  ensurePermissions.mockResolvedValue(GRANTED_PERMISSIONS)
  revalidatePermissions.mockResolvedValue(GRANTED_PERMISSIONS)
  // Warm permissions cache from the start — these tests are about the
  // SESSION guard, not the access guard (covered separately in
  // router.access-guard.test.tsx), so the access guard should always resolve
  // synchronously and out of the way.
  getCachedPermissions.mockReturnValue(GRANTED_PERMISSIONS)

  // Cold session cache by default — each test explicitly arranges the
  // warm/cold state it needs.
  getCachedSession.mockReturnValue(null)
  getSession.mockResolvedValue(SESSION_FIXTURE)
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

describe('cold session cache — still awaits getSession() (baseline, unchanged behavior)', () => {
  it('shows the pending fallback while a genuinely deferred getSession() is in flight, then mounts', async () => {
    let resolveGetSession!: (value: typeof SESSION_FIXTURE) => void
    getSession.mockReturnValue(
      new Promise((resolve) => {
        resolveGetSession = resolve
      }),
    )

    const renderPromise = renderShellAt('/estimai')

    expect(await screen.findByTestId('route-pending')).not.toBeNull()
    expect(screen.queryByTestId('estimai-app')).toBeNull()

    resolveGetSession(SESSION_FIXTURE)
    await renderPromise

    expect(await screen.findByTestId('estimai-app')).not.toBeNull()
    expect(screen.queryByTestId('route-pending')).toBeNull()
    expect(getSession).toHaveBeenCalledTimes(1)
  })
})

describe('warm session cache — same-app navigation resolves the guard synchronously (bug fix 2026-07)', () => {
  it('does NOT call getSession() again and does NOT show the pending fallback for an inner-route change within the same tool', async () => {
    getCachedSession.mockReturnValue(SESSION_FIXTURE)

    const { router } = await renderShellAt('/estimai/requests')
    const firstEstimaiNode = await screen.findByTestId('estimai-app')

    getSession.mockClear()

    // Make ABSOLUTELY sure a real getSession() call would be observable as
    // still-pending — if the guard wrongly took the async branch here, this
    // navigation would hang the pending fallback forever (never resolved).
    getSession.mockReturnValue(new Promise(() => {}))

    await router.navigate({ to: '/estimai/requests/123' })

    // Same DOM node — the remote was never unmounted/remounted, only the
    // inner route (which the remote's OWN router resolves) changed.
    expect(await screen.findByTestId('estimai-app')).toBe(firstEstimaiNode)
    expect(getSession).not.toHaveBeenCalled()
    expect(screen.queryByTestId('route-pending')).toBeNull()
  })

  it('a warm session cache also resolves synchronously across an APP SWITCH (session validity is not per-app)', async () => {
    getCachedSession.mockReturnValue(SESSION_FIXTURE)

    const { router } = await renderShellAt('/estimai')
    await screen.findByTestId('estimai-app')

    getSession.mockClear()
    getSession.mockReturnValue(new Promise(() => {}))

    await router.navigate({ to: '/refund' })

    expect(await screen.findByTestId('refund-app')).not.toBeNull()
    expect(screen.queryByTestId('estimai-app')).toBeNull()
    expect(getSession).not.toHaveBeenCalled()
    // No pending fallback attributable to the SESSION guard — the access
    // guard's own (separate) revalidation on an app switch is covered by
    // router.access-guard.test.tsx, and is warmed here via
    // getCachedPermissions, so it doesn't confound this assertion either.
    expect(screen.queryByTestId('route-pending')).toBeNull()
  })
})
