import { createRootRoute, createRoute, createRouter, Outlet } from '@tanstack/react-router'
import type { RouteComponent } from '@tanstack/react-router'
import NotFoundPage from './pages/NotFoundPage'
import ProjectDetailPage from './pages/ProjectDetailPage'
import ProjectsPage from './pages/ProjectsPage'

/**
 * projects-ui's inner router (specs/024-projects), basepath `/projects` — the
 * shell mounts this remote at its gated `/projects/$` route:
 *
 *   /projects        Projects list (T12)
 *   /projects/$id    Project page: details, state, team, contracts (T13, T14)
 *
 * The routes below are relative to the basepath. No auth guard and no chrome
 * (ADR-0006). `Root` is the layout seam: App.tsx passes `ProjectsShell`; tests
 * may render a page under a bare `<Outlet/>`.
 */
export function createAppRouter(basepath?: string, Root: RouteComponent = Outlet) {
  const rootRoute = createRootRoute({ component: Root })

  const listRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: ProjectsPage })
  const projectRoute = createRoute({ getParentRoute: () => rootRoute, path: '/$id', component: ProjectDetailPage })

  const routeTree = rootRoute.addChildren([listRoute, projectRoute])

  return createRouter({ routeTree, basepath, defaultNotFoundComponent: NotFoundPage })
}

export type AppRouter = ReturnType<typeof createAppRouter>

declare module '@tanstack/react-router' {
  interface Register {
    router: AppRouter
  }
}
