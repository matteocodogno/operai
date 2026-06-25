import { createRootRoute, createRoute, createRouter, redirect, Outlet } from '@tanstack/react-router'
import EstimatesPage from './pages/EstimatesPage'
import EstimatePage from './pages/EstimatePage'
import SharedEstimatePage from './pages/SharedEstimatePage'
import { getLastProjectId, loadProject, createProject } from './lib/projects'
import { authClient } from './lib/authClient'

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
    const lastId = getLastProjectId()
    if (lastId && loadProject(lastId)) {
      throw redirect({ to: '/estimates/$estimateId', params: { estimateId: lastId } })
    }
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
  beforeLoad: ({ params }) => {
    // If the estimate doesn't exist in localStorage, redirect to list
    if (!loadProject(params.estimateId)) {
      throw redirect({ to: '/estimates' })
    }
  },
  loader: ({ params }) => {
    // Track the last opened estimate
    localStorage.setItem('estimai_current_id', params.estimateId)
    return null
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
