/**
 * @vitest-environment jsdom
 *
 * Integration tests for the shell router (T9, specs/003-suite-shell):
 *   - deep-linking directly to `/estimai/...` and `/refund` resolves the
 *     correct tool as the FIRST paint of the content area (AC-3.2, AC-3.3)
 *   - the shared chrome (header/footer, rendered by the `_shell` layout
 *     route) stays mounted — not remounted — when switching tools (AC-1.2)
 *
 * Split from router.test.tsx (the `_authed` guard unit tests) because these
 * need REAL RouterProvider rendering + navigation via `window.history`,
 * which conflicts with router.test.tsx's technique of replacing
 * `window.location` with a static object (fine there — it never renders a
 * router, only calls beforeLoad directly). Mixing both techniques in one
 * jsdom window (shared per test FILE, not per test) would leak an
 * unnavigable `window.location` stub into these tests.
 *
 * Federated remotes are mocked (`vi.mock('estimai/App', …)` /
 * `vi.mock('refund/App', …)`) rather than loaded from a real
 * `remoteEntry.js` — per T9's done-when, the point here is that the ROUTE
 * resolves to the right tool and mounts it via RemoteMount, not exercising
 * the real Module Federation runtime (that's T16, against real built
 * remotes + a real seeded session).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { RouterProvider } from '@tanstack/react-router'

// ---------------------------------------------------------------------------
// Module mocks — hoisted above imports/dynamic imports of the modules they
// replace.
// ---------------------------------------------------------------------------

// Fully-permissioned fixture shared by usePermissions/ensurePermissions/
// revalidatePermissions below (T24/T25, specs/004-auth-roles-permissions).
// These tests deep-link into both estimai and refund routes, and each tool
// route's access guard (router.tsx, T25) now force-revalidates permissions
// on every navigation — `revalidatePermissions()` must therefore resolve a
// grant for whichever tool is being navigated to, or the guard would
// redirect away instead of letting the route render.
const PERMISSIONS_FIXTURE = {
  epoch: 0,
  apps: ['estimai', 'refund'],
  roles: [],
  departments: [],
  permissions: [],
}

vi.mock('./lib/session', () => ({
  getSession: vi.fn(),
  useSession: vi.fn(() => ({
    data: { user: { id: 'u1', email: 'consultant@welld.ch', name: 'Consultant' } },
  })),
  signOut: vi.fn(),
  usePermissions: vi.fn(() => PERMISSIONS_FIXTURE),
  ensurePermissions: vi.fn(async () => PERMISSIONS_FIXTURE),
  revalidatePermissions: vi.fn(async () => PERMISSIONS_FIXTURE),
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

import { getSession } from './lib/session'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Navigates the (real) jsdom location to `path` BEFORE constructing the
 * router, then imports router.tsx fresh (cache-busted) so the module-scope
 * `router` singleton it creates picks up that location as its initial
 * match — this is what proves a deep link resolves the right tool on FIRST
 * paint, rather than starting at some other default route and navigating
 * away from it.
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
  vi.mocked(getSession).mockResolvedValue({
    data: { user: { id: 'u1', email: 'consultant@welld.ch', name: 'Consultant' }, session: {} },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any)
})

afterEach(() => {
  cleanup()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  vi.resetModules()
  window.history.pushState(null, '', '/')
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('deep-link routing (AC-3.2, AC-3.3)', () => {
  it('deep-links directly to /refund without ever mounting EstimAI', async () => {
    await renderShellAt('/refund')

    expect(await screen.findByTestId('refund-app')).not.toBeNull()
    expect(screen.queryByTestId('estimai-app')).toBeNull()
  })

  it('deep-links directly to a nested EstimAI path (/estimai/estimates/42) without mounting Refund', async () => {
    await renderShellAt('/estimai/estimates/42')

    expect(await screen.findByTestId('estimai-app')).not.toBeNull()
    expect(screen.queryByTestId('refund-app')).toBeNull()
  })

  it('resolves /estimai (exact, no sub-path) to the EstimAI remote', async () => {
    await renderShellAt('/estimai')

    expect(await screen.findByTestId('estimai-app')).not.toBeNull()
  })
})

describe('chrome persists across a tool switch (AC-1.2)', () => {
  it('keeps the header and footer DOM nodes mounted (same node identity) while the content area swaps', async () => {
    const { router } = await renderShellAt('/estimai')

    await screen.findByTestId('estimai-app')
    const headerBefore = screen.getByRole('banner')
    const footerBefore = screen.getByRole('contentinfo')

    await router.navigate({ to: '/refund' })

    expect(await screen.findByTestId('refund-app')).not.toBeNull()
    expect(screen.queryByTestId('estimai-app')).toBeNull()

    const headerAfter = screen.getByRole('banner')
    const footerAfter = screen.getByRole('contentinfo')

    // Referential equality of the actual DOM nodes proves the layout route
    // (and everything it renders — header, sidebar slot, footer) was never
    // torn down and remounted; only the child route's content changed.
    expect(headerAfter).toBe(headerBefore)
    expect(footerAfter).toBe(footerBefore)
  })
})
