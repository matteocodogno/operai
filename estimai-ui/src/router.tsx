import { createRootRoute, createRoute, createRouter, redirect, Outlet } from '@tanstack/react-router'
import EstimatesPage from './pages/EstimatesPage'
import EstimatePage from './pages/EstimatePage'
import { getLastProjectId, loadProject, createProject } from './lib/projects'

const rootRoute = createRootRoute({ component: () => <Outlet /> })

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
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
  getParentRoute: () => rootRoute,
  path: '/estimates',
  component: EstimatesPage,
})

const estimateRoute = createRoute({
  getParentRoute: () => rootRoute,
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

const routeTree = rootRoute.addChildren([indexRoute, estimatesRoute, estimateRoute])

export const router = createRouter({ routeTree })

// TypeScript registration
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

// Helpers used by pages
export { createProject }
