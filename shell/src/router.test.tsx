/**
 * @vitest-environment jsdom
 *
 * Unit tests for the `_authed` layout route guard in src/router.tsx (T9,
 * specs/003-suite-shell, AC-2.1). Ported from estimai-ui/src/router.test.tsx
 * (T7, specs/002) — same guard contract, now backed by shell/session's
 * getSession (T4) instead of estimai-ui's own authClient:
 *
 *   - Resolves the session via shell/session's getSession() (cookie-based).
 *   - No session → throws a TanStack Router redirect to
 *     <VITE_AUTH_URL>/sign-in?redirect=<current absolute URL>.
 *   - A session present → completes without throwing (routes render).
 *
 * We test the guard at the unit level by calling its beforeLoad directly
 * with a mocked shell/session. The "nothing renders before the session
 * check resolves" property is structurally guaranteed by TanStack Router:
 * beforeLoad must resolve/reject before the component mounts. The
 * pending-promise test verifies the guard's promise does not resolve until
 * getSession resolves.
 *
 * Deep-link routing (/estimai/*, /refund) and chrome persistence across a
 * tool switch (AC-1.2, AC-3.2, AC-3.3) are covered separately in
 * router.integration.test.tsx — those need real RouterProvider rendering +
 * navigation, which conflicts with this file's technique of stubbing
 * `window.location` as a static object (see that file's module doc for why
 * they're split).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isRedirect } from '@tanstack/react-router'

// ---------------------------------------------------------------------------
// Module mock — must be hoisted above imports of the module under test.
// vi.mock is hoisted by the vitest transformer. router.tsx imports both
// getSession and useSession from ./lib/session; useSession is unused by the
// guard itself but must be present since router.tsx's ShellHeader imports it
// too and the whole module is evaluated on import.
// ---------------------------------------------------------------------------

vi.mock('./lib/session', () => ({
  getSession: vi.fn(),
  useSession: vi.fn(() => ({ data: null })),
  signOut: vi.fn(),
}))

// router.tsx also dynamically imports estimai/App and refund/App (T9's tool
// routes) — Vite's import-analysis resolves every static/dynamic import
// specifier in a transformed module up front, even ones the guard tests
// never execute, so these two federated remotes must be mocked here as well
// or importing router.tsx at all fails before any test runs.
vi.mock('estimai/App', () => ({ default: () => null }))
vi.mock('refund/App', () => ({ default: () => null }))
vi.mock('admin/App', () => ({ default: () => null }))

// Import getSession AFTER vi.mock so we get the mocked version.
import { getSession } from './lib/session'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AUTH_URL = 'http://auth.test'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Imports the router module fresh so import.meta.env is read after
 * vi.stubEnv has been called and each test gets an isolated module instance
 * (see vi.resetModules() in afterEach). Unlike estimai-ui's router (a
 * `createAppRouter(basepath?)` factory, needed because that module is
 * consumed both standalone and as a federated remote), the shell has exactly
 * one router shape — no basepath variants — so router.tsx exports a plain
 * `routeTree` we can inspect directly.
 *
 * The `_authed` route is the first (and only) child of the root route.
 */
const getAuthedBeforeLoad = async (): Promise<
  ((ctx: { location: { href: string } }) => Promise<void>) | undefined
> => {
  const mod = await import('./router?t=' + Date.now())
  const authedNode = mod.routeTree.children?.[0]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (authedNode as any)?.options?.beforeLoad as
    | ((ctx: { location: { href: string } }) => Promise<void>)
    | undefined
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.stubEnv('VITE_AUTH_URL', AUTH_URL)

  // Default: simulate a page at the suite root.
  Object.defineProperty(window, 'location', {
    value: {
      href: 'http://localhost:5173/',
    },
    writable: true,
    configurable: true,
  })
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  vi.resetModules()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('_authed layout route guard (beforeLoad)', () => {
  describe('unauthenticated visitor — redirects to sign-in for each guarded route', () => {
    const routes: Array<{ name: string; href: string }> = [
      { name: '/', href: 'http://localhost:5173/' },
      { name: '/estimai', href: 'http://localhost:5173/estimai' },
      { name: '/estimai/$ (deep link)', href: 'http://localhost:5173/estimai/estimates/42' },
      { name: '/refund', href: 'http://localhost:5173/refund' },
      { name: '/refund/$ (deep link)', href: 'http://localhost:5173/refund/requests/7' },
    ]

    for (const route of routes) {
      it(`redirects to <AUTH_URL>/sign-in?redirect=<current URL> when visiting ${route.name}`, async () => {
        // Arrange: no session.
        vi.mocked(getSession).mockResolvedValue(null)

        // Simulate the visitor being on this route's URL.
        Object.defineProperty(window, 'location', {
          value: { href: route.href },
          writable: true,
          configurable: true,
        })

        const beforeLoad = await getAuthedBeforeLoad()
        expect(beforeLoad, 'beforeLoad must be defined on the _authed route').toBeDefined()

        // Act: call beforeLoad — it should throw a TanStack Router redirect.
        let thrown: unknown
        try {
          await beforeLoad!({ location: { href: route.href } })
        } catch (err) {
          thrown = err
        }

        // Assert: thrown value is a TanStack Router redirect.
        expect(isRedirect(thrown), 'expected a TanStack Router redirect to be thrown').toBe(true)

        const response = thrown as Response & { options: { href: string; reloadDocument?: boolean } }

        // The Location header must point to <AUTH_URL>/sign-in with the
        // current absolute URL encoded as the `redirect` query param.
        const expectedSignInUrl = `${AUTH_URL}/sign-in?redirect=${encodeURIComponent(route.href)}`
        expect(response.headers.get('Location')).toBe(expectedSignInUrl)

        // reloadDocument must be true so the browser performs a full navigation
        // to the external auth service (not a client-side router transition) —
        // this is what makes the visitor see NONE of the suite's chrome (AC-2.1).
        expect(response.options.reloadDocument).toBe(true)
      })
    }
  })

  describe('authenticated visitor — beforeLoad completes without throwing', () => {
    it('does NOT redirect when a valid session is present', async () => {
      // Arrange: session exists.
      vi.mocked(getSession).mockResolvedValue({
        data: { user: { id: 'u1', email: 'consultant@welld.ch', name: 'Consultant' }, session: {} },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any)

      const beforeLoad = await getAuthedBeforeLoad()
      expect(beforeLoad).toBeDefined()

      // Act + Assert: must not throw.
      await expect(beforeLoad!({ location: { href: 'http://localhost:5173/estimai' } })).resolves.toBeUndefined()
    })
  })

  describe('session check is async — nothing renders before it resolves', () => {
    it('beforeLoad promise does not resolve until getSession resolves', async () => {
      // Arrange: delay the session response.
      let resolveSession!: (value: null) => void
      const pendingSession = new Promise<null>((resolve) => {
        resolveSession = resolve
      })
      vi.mocked(getSession).mockReturnValue(pendingSession)

      const beforeLoad = await getAuthedBeforeLoad()
      expect(beforeLoad).toBeDefined()

      // Act: start beforeLoad but do not await.
      let resolved = false
      const promise = beforeLoad!({ location: { href: 'http://localhost:5173/estimai' } })
        .catch(() => {
          resolved = true
        })
        .then(() => {
          resolved = true
        })

      // The guard must still be pending — nothing can render yet.
      expect(resolved).toBe(false)

      // Resolve the session check (no session → will throw redirect).
      resolveSession(null)
      await promise

      // Now the guard has completed (with a redirect throw, caught above).
      expect(resolved).toBe(true)
    })
  })
})
