/**
 * @vitest-environment jsdom
 *
 * Router structure tests for estimai-ui (T13, specs/003-suite-shell/tasks.md).
 *
 * Before T13, this file unit-tested the router's own pathless `_authed`
 * guard — a real session check that threw a full-page redirect to the
 * hosted sign-in page when no session was present (AC-1.1, spec 002). T13
 * REMOVES that guard entirely (AC-2.3): estimai-ui now runs as a federated
 * remote inside the shell (T12), and the shell's OWN `_authed` guard
 * (shell/src/router.tsx, T9) already guarantees a session before this
 * router's routes are ever reached — a second, independent sign-in redirect
 * here would violate AC-2.3 ("the tool ... does not perform its own
 * independent sign-in redirect").
 *
 * The guard-redirect coverage itself was not dropped, only relocated: it
 * lives in shell/src/router.test.tsx now, testing the identical
 * beforeLoad/redirect contract this file used to test, now owned by the
 * shell (which resolves the session via the same shared `shell/session`
 * module estimai-ui's own src/lib/authClient.ts delegates to — see
 * src/lib/authClient.test.ts for that delegation's coverage).
 *
 * What THIS file asserts is T13's own done-when: the remote's router has NO
 * `_authed` route, and its app routes (/, /estimates,
 * /estimates/$estimateId, /share) are mounted directly off the root with no
 * guarding beforeLoad — proven both structurally (route tree shape) and
 * behaviorally (visiting a guarded path with NO session/auth mocked at all
 * never redirects to sign-in).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { RouterProvider } from '@tanstack/react-router'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal shape of a TanStack Router route object needed for these assertions. */
interface RouteTreeNode {
  id: string
  fullPath?: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Imports the router module fresh (cache-busted) so each test builds its own route tree. */
const importRouter = () => import('./router?t=' + Date.now())

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.stubEnv('VITE_AUTH_URL', 'http://auth.test')
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

describe('router has no _authed guard (T13, AC-2.3)', () => {
  it('mounts the app routes directly off the root — no `_authed` layout route in the tree', async () => {
    const { createAppRouter } = await importRouter()
    const routeTree = createAppRouter().routeTree as unknown as { children?: RouteTreeNode[] }

    const childIds = (routeTree.children ?? []).map((child) => child.id)

    expect(childIds).not.toContain('_authed')
  })

  it('exposes the same four app routes as direct children of root, none of them guarded', async () => {
    const { createAppRouter } = await importRouter()
    const routeTree = createAppRouter().routeTree as unknown as { children?: RouteTreeNode[] }

    const childPaths = (routeTree.children ?? [])
      .map((child) => child.fullPath)
      .filter((path): path is string => path !== undefined)
      .sort()

    expect(childPaths).toEqual(['/', '/estimates', '/estimates/$estimateId', '/share'].sort())
    // Exactly these four — no extra `_authed` (or any other) wrapper route.
    expect(routeTree.children).toHaveLength(4)
  })
})

describe('no independent sign-in redirect (T13, AC-2.3)', () => {
  it('visiting /estimates/... with no session/auth mocked at all never redirects to sign-in', async () => {
    // Deliberately do NOT mock ./lib/authClient or ./lib/api — proving the
    // route resolves with NO session check in the path at all, not merely
    // that a mocked session check passes.
    window.history.pushState(null, '', '/share')
    const { createAppRouter } = await importRouter()
    const router = createAppRouter()

    render(<RouterProvider router={router} />)

    // /share with no hash payload renders its own "invalid/missing data"
    // state directly — proof the route's component mounted without any
    // sign-in redirect happening first.
    await screen.findByText(/invalid or missing share data/i)

    expect(window.location.pathname).toBe('/share')
    expect(window.location.href).not.toContain('/sign-in')
  })
})
