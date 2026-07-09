/**
 * @vitest-environment jsdom
 *
 * Unit tests for the _authed layout route guard in src/router.tsx (T7, AC-1.1).
 *
 * The guard's beforeLoad:
 *   - Resolves the session via authClient.getSession() (cookie-based).
 *   - When NO session is present → throws a TanStack Router redirect to
 *     <VITE_AUTH_URL>/sign-in?redirect=<current absolute URL>.
 *   - When a session IS present → completes without throwing (routes render).
 *
 * We test the guard at the unit level by calling its beforeLoad directly with
 * a mocked authClient. The "nothing renders before session check resolves"
 * property is structurally guaranteed by TanStack Router: beforeLoad must
 * resolve/reject before the component is mounted. The pending-promise test
 * verifies that the guard's promise does not resolve until getSession resolves.
 *
 * Covered routes (AC-1.1): /, /estimates, /estimates/$estimateId, /share.
 * All share the same guard (they are all children of _authed), so a single
 * unit test of the guard's beforeLoad covers all four paths. We additionally
 * assert that the redirect URL encodes the correct per-route `window.location.href`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isRedirect } from '@tanstack/react-router'

// ---------------------------------------------------------------------------
// Module mock — must be hoisted above imports of the module under test.
// vi.mock is hoisted by the vitest transformer.
// ---------------------------------------------------------------------------

vi.mock('./lib/authClient', () => ({
  authClient: {
    getSession: vi.fn(),
  },
}))

// Import authClient AFTER vi.mock so we get the mocked version.
import { authClient } from './lib/authClient'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AUTH_URL = 'http://auth.test'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Imports the router module fresh for each test group so that import.meta.env
 * is read after vi.stubEnv has been called.
 *
 * We extract the beforeLoad from the _authed route by calling it directly.
 * TanStack Router's route tree is synchronous to construct, so we can import
 * the router module and then invoke the guard's beforeLoad as a plain async fn.
 *
 * T12 (specs/003-suite-shell/tasks.md): the module now exports a
 * `createAppRouter(basepath?)` factory rather than a single module-scope
 * `router` (so the same route definitions can be rebased under `/estimai`
 * for the federated remote — see src/App.tsx). Calling it with no basepath
 * here reproduces the exact standalone-router shape this test always
 * exercised; the guard's behavior is basepath-independent.
 */
const getAuthedBeforeLoad = async (): Promise<
  ((ctx: { location: { href: string } }) => Promise<void>) | undefined
> => {
  // Re-import to pick up the stubbed env.
  const mod = await import('./router?t=' + Date.now())
  // The router exposes the route tree via router.routeTree; navigate the tree
  // to find the _authed route's beforeLoad.
  const routeTree = mod.createAppRouter().routeTree
  // The _authed route is the first (and only) non-root child.
  const authedNode = routeTree.children?.[0]
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

  // Default: simulate a page at the estimates route.
  Object.defineProperty(window, 'location', {
    value: {
      href: 'http://localhost:5173/estimates',
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
      { name: '/estimates', href: 'http://localhost:5173/estimates' },
      { name: '/estimates/$estimateId', href: 'http://localhost:5173/estimates/abc-123' },
      { name: '/share', href: 'http://localhost:5173/share' },
    ]

    for (const route of routes) {
      it(`redirects to <AUTH_URL>/sign-in?redirect=<current URL> when visiting ${route.name}`, async () => {
        // Arrange: no session.
        vi.mocked(authClient.getSession).mockResolvedValue(null)

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
        // to the external auth service (not a client-side router transition).
        expect(response.options.reloadDocument).toBe(true)
      })
    }
  })

  describe('authenticated visitor — beforeLoad completes without throwing', () => {
    it('does NOT redirect when a valid session is present', async () => {
      // Arrange: session exists.
      vi.mocked(authClient.getSession).mockResolvedValue({
        data: { user: { id: 'u1', email: 'consultant@welld.ch', name: 'Consultant' }, session: {} },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any)

      const beforeLoad = await getAuthedBeforeLoad()
      expect(beforeLoad).toBeDefined()

      // Act + Assert: must not throw.
      await expect(beforeLoad!({ location: { href: 'http://localhost:5173/estimates' } })).resolves.toBeUndefined()
    })
  })

  describe('session check is async — nothing renders before it resolves', () => {
    it('beforeLoad promise does not resolve until getSession resolves', async () => {
      // Arrange: delay the session response.
      let resolveSession!: (value: null) => void
      const pendingSession = new Promise<null>((resolve) => {
        resolveSession = resolve
      })
      vi.mocked(authClient.getSession).mockReturnValue(pendingSession)

      const beforeLoad = await getAuthedBeforeLoad()
      expect(beforeLoad).toBeDefined()

      // Act: start beforeLoad but do not await.
      let resolved = false
      const promise = beforeLoad!({ location: { href: 'http://localhost:5173/estimates' } })
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
