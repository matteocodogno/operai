import { createRootRoute, createRoute, createRouter, redirect, Outlet } from '@tanstack/react-router'
import EstimatesPage from './pages/EstimatesPage'
import EstimatePage from './pages/EstimatePage'
import SharedEstimatePage from './pages/SharedEstimatePage'
import { createProject } from './lib/projects'
import { authClient } from './lib/authClient'
import * as estimatesApi from './lib/estimatesApi'
import type { EstimateFull } from './lib/estimatesApi'

const getAuthUrl = (): string => import.meta.env.VITE_AUTH_URL as string

// ---------------------------------------------------------------------------
// createAppRouter — factory, not a module-scope singleton (T12, specs/003)
//
// estimai-ui is now consumed two ways:
//   - Standalone (dev/test bootstrap, src/main.tsx): createAppRouter() with
//     no basepath — routes resolve at the document root exactly as before
//     this task (zero behavior change, AC-4.1).
//   - As a federated remote (src/App.tsx, exposed as `./App` — see
//     vite.config.ts): the shell mounts estimai-ui under `/estimai/*`, so
//     createAppRouter('/estimai') rebases the SAME route definitions under
//     that prefix so internal navigation (list ↔ editor ↔ share) resolves
//     correctly there.
//
// All route objects are built fresh inside the factory (rather than at
// module scope, as before) so that two router instances — one per basepath —
// never share mutable route-tree state.
//
// The `_authed` guard below (AC-1.1) is unchanged and identical in both
// modes. T13 is the task that removes it in favor of the shell's session
// guard — out of scope here.
// ---------------------------------------------------------------------------

export function createAppRouter(basepath?: string) {
  const rootRoute = createRootRoute({ component: () => <Outlet /> })

  // ---------------------------------------------------------------------------
  // _authed — pathless layout route that guards all app content (AC-1.1)
  //
  // beforeLoad resolves the session via authClient.getSession() (cookie-based).
  // If there is no active session, throws a full-page redirect to the auth
  // service sign-in page, encoding the current absolute URL as `redirect` so
  // that the user is returned here after sign-in (AC-1.2).
  //
  // The `redirect` param is the real current window.location.href. The auth
  // service's ALLOWED_ORIGINS allowlist (T2) enforces that only trusted origins
  // are honoured — no open-redirect exposure on the UI side.
  // ---------------------------------------------------------------------------

  const authedRoute = createRoute({
    getParentRoute: () => rootRoute,
    id: '_authed',
    beforeLoad: async () => {
      const session = await authClient.getSession()
      if (!session?.data) {
        const signInUrl = `${getAuthUrl()}/sign-in?redirect=${encodeURIComponent(window.location.href)}`
        throw redirect({ href: signInUrl })
      }
    },
  })

  // ---------------------------------------------------------------------------
  // App routes (all children of _authed)
  // ---------------------------------------------------------------------------

  const indexRoute = createRoute({
    getParentRoute: () => authedRoute,
    path: '/',
    beforeLoad: () => {
      // After localStorage→server cutover, the index simply redirects to the
      // list. The "last opened" localStorage key is preserved (not deleted) so
      // the T12 import flow can still read legacy keys.
      throw redirect({ to: '/estimates' })
    },
  })

  const estimatesRoute = createRoute({
    getParentRoute: () => authedRoute,
    path: '/estimates',
    component: EstimatesPage,
  })

  const estimateRoute = createRoute({
    getParentRoute: () => authedRoute,
    path: '/estimates/$estimateId',
    // Loader: fetch the full estimate from the API.
    // On 404 (not found / not owned): redirect to the list.
    // On any other error: also redirect to the list (safe fallback).
    loader: async ({ params }): Promise<EstimateFull> => {
      // Track last-opened in localStorage so T12 import and other tooling can
      // read it, but never gate access on this value.
      localStorage.setItem('estimai_current_id', params.estimateId)
      try {
        return await estimatesApi.get(params.estimateId)
      } catch {
        throw redirect({ to: '/estimates' })
      }
    },
    component: EstimatePage,
  })

  const shareRoute = createRoute({
    getParentRoute: () => authedRoute,
    path: '/share',
    component: SharedEstimatePage,
  })

  // ---------------------------------------------------------------------------
  // Route tree
  // ---------------------------------------------------------------------------

  const routeTree = rootRoute.addChildren([
    authedRoute.addChildren([indexRoute, estimatesRoute, estimateRoute, shareRoute]),
  ])

  return createRouter({ routeTree, basepath })
}

export type AppRouter = ReturnType<typeof createAppRouter>

// TypeScript registration
declare module '@tanstack/react-router' {
  interface Register {
    router: AppRouter
  }
}

// Helpers used by pages
export { createProject }
