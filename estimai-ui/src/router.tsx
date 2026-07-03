import { createRootRoute, createRoute, createRouter, redirect, Outlet } from '@tanstack/react-router'
import EstimatesPage from './pages/EstimatesPage'
import EstimatePage from './pages/EstimatePage'
import SharedEstimatePage from './pages/SharedEstimatePage'
import { createProject } from './lib/projects'
import { authClient } from './lib/authClient'
import * as estimatesApi from './lib/estimatesApi'
import type { EstimateFull } from './lib/estimatesApi'

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

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

const getAuthUrl = (): string => import.meta.env.VITE_AUTH_URL as string

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

export const router = createRouter({ routeTree })

// TypeScript registration
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

// Helpers used by pages
export { createProject }
