/**
 * @vitest-environment jsdom
 *
 * Tests for the `/account` route registration (T15, specs/012-employee-address,
 * US-6 AC-6.1; ADR-0034; plan.md "Where US-6 lives" / design.md F6).
 *
 * Two properties, both required by this task's done-when:
 *
 *   1. `/account` resolves — mounts `AccountScreen` — for a caller with ZERO
 *      app-access grants, proving the route has NO app-access `beforeLoad`
 *      guard (unlike `/estimai`, `/refund`, `/admin` —
 *      router.access-guard.test.tsx — and structurally identical to
 *      `/notify`, router.notify.test.tsx). This is the entire point of the
 *      ADR-0034 placement: every signed-in employee must reach their own
 *      address regardless of which tools they've been granted.
 *   2. The "My profile" item appears in the UserMenu dropdown and links to
 *      `/account` (UserMenu.test.tsx covers this in isolation; this file
 *      proves it end-to-end through the REAL shell router).
 *
 * Mirrors router.notify.test.tsx's technique exactly (real RouterProvider +
 * `window.history` navigation, federated remotes mocked via `vi.mock`,
 * `./router` re-imported fresh per test so the module-scope `router`
 * singleton picks up the pushed location as its initial match).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { RouterProvider } from '@tanstack/react-router'

// ---------------------------------------------------------------------------
// Module mocks — hoisted above imports/dynamic imports of the modules they
// replace (mirrors router.notify.test.tsx / router.access-guard.test.tsx).
// ---------------------------------------------------------------------------

const { getSession, usePermissions, ensurePermissions, revalidatePermissions, apiFetch } = vi.hoisted(
  () => ({
    getSession: vi.fn(),
    usePermissions: vi.fn(),
    ensurePermissions: vi.fn(),
    revalidatePermissions: vi.fn(),
    apiFetch: vi.fn(),
  }),
)

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
  apiFetch,
  onSignOut: vi.fn(),
  // AccountScreen's profileApi.getMyAddress() (T14) also goes through
  // apiFetch/getAuthBaseUrl — supplying getAuthBaseUrl here keeps the URL it
  // builds well-formed; apiFetch itself is configured per-test below.
  getAuthBaseUrl: vi.fn(() => 'http://auth.test'),
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
 * — same technique as router.notify.test.tsx's `renderShellAt`.
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
  // AccountScreen's GET /me/address — default to "no address on file" so
  // every test in this file lands on a deterministic, non-error state
  // unless a test overrides it.
  apiFetch.mockResolvedValue({
    ok: true,
    json: async () => ({ address: null }),
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

describe('/account route registration (T15, AC-6.1, ADR-0034)', () => {
  it('mounts AccountScreen at /account for a caller with ZERO granted apps — NOT app-access-gated', async () => {
    usePermissions.mockReturnValue(permissionsWith([]))
    ensurePermissions.mockResolvedValue(permissionsWith([]))
    revalidatePermissions.mockResolvedValue(permissionsWith([]))

    const { router } = await renderShellAt('/account')

    // A zero-apps caller navigating to any OTHER tool route lands on
    // /no-access (router.access-guard.test.tsx) — /account must behave
    // differently, exactly like /notify: it renders regardless.
    expect(await screen.findByTestId('account-screen')).not.toBeNull()
    expect(screen.queryByRole('heading', { name: 'No apps available yet' })).toBeNull()
    expect(router.state.location.pathname).toBe('/account')
  })

  it('mounts AccountScreen at /account for a fully-permissioned caller too', async () => {
    usePermissions.mockReturnValue(permissionsWith(['estimai', 'refund', 'admin']))
    ensurePermissions.mockResolvedValue(permissionsWith(['estimai', 'refund', 'admin']))
    revalidatePermissions.mockResolvedValue(permissionsWith(['estimai', 'refund', 'admin']))

    const { router } = await renderShellAt('/account')

    expect(await screen.findByTestId('account-screen')).not.toBeNull()
    expect(router.state.location.pathname).toBe('/account')
  })

  it('renders the fetched address inside the shared chrome (header/sidebar/footer stay mounted)', async () => {
    usePermissions.mockReturnValue(permissionsWith(['estimai']))
    ensurePermissions.mockResolvedValue(permissionsWith(['estimai']))
    revalidatePermissions.mockResolvedValue(permissionsWith(['estimai']))
    apiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        address: {
          countryCode: 'CH',
          city: 'Zürich',
          street: 'Bahnhofstrasse',
          houseNumber: '12b',
          formatted: 'Bahnhofstrasse 12b, 8001 Zürich, Zürich, Switzerland',
          updatedAt: '2026-08-03T09:12:44.123Z',
        },
      }),
    })

    await renderShellAt('/account')

    expect(
      await screen.findByText('Bahnhofstrasse 12b, 8001 Zürich, Zürich, Switzerland'),
    ).not.toBeNull()
    // The chrome's tool switcher is still there — /account isn't a full-page takeover.
    expect(screen.getByRole('link', { name: 'EstimAI' })).not.toBeNull()
  })

  it('does not record account as the last-used tool (no ToolId exists for it)', async () => {
    usePermissions.mockReturnValue(permissionsWith(['estimai']))
    ensurePermissions.mockResolvedValue(permissionsWith(['estimai']))
    revalidatePermissions.mockResolvedValue(permissionsWith(['estimai']))

    await renderShellAt('/account')

    await screen.findByTestId('account-screen')
    expect(localStorage.getItem('operai_last_tool')).toBeNull()
  })
})

describe('/account absent from the permission-filtered sidebar TOOLS list (mirrors /notify)', () => {
  it('TOOLS (shell/src/lib/tools.ts) contains no entry for "account"', async () => {
    const { TOOLS } = await import('./lib/tools')
    expect(TOOLS.some(tool => tool.to === '/account')).toBe(false)
  })
})

describe('UserMenu "My profile" reaches /account through the real shell router (T15, AC-6.1)', () => {
  it('navigates from any tool to /account via the "My profile" menu item', async () => {
    usePermissions.mockReturnValue(permissionsWith(['estimai']))
    ensurePermissions.mockResolvedValue(permissionsWith(['estimai']))
    revalidatePermissions.mockResolvedValue(permissionsWith(['estimai']))

    const { router } = await renderShellAt('/estimai')
    await screen.findByTestId('estimai-app')

    fireEvent.click(screen.getByRole('button', { name: 'Consultant' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'My profile' }))

    expect(await screen.findByTestId('account-screen')).not.toBeNull()
    expect(router.state.location.pathname).toBe('/account')
  })
})
