import { createRootRoute, createRoute, createRouter, Outlet } from '@tanstack/react-router'
import type { RouteComponent } from '@tanstack/react-router'
import NotFoundPage from './pages/NotFoundPage'

/**
 * accounting-ui's inner router (specs/20261119-accounting), basepath `/accounting` — the shell mounts this remote at
 * its gated `/accounting/$` route.
 *
 * SCAFFOLD (T26): a root layout seam and the index route only. The frame, the three view routes and the
 * `/accounting` → `/accounting/ledger-accounts` redirect are T28. Any path no route matches is the not-found panel
 * (design AS7). No auth guard and no chrome (ADR 20260709-suite-frontend-module-federation).
 */
export function createAppRouter(basepath?: string, Root: RouteComponent = Outlet) {
  const rootRoute = createRootRoute({ component: Root })

  const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: () => null })

  const routeTree = rootRoute.addChildren([indexRoute])

  return createRouter({ routeTree, basepath, defaultNotFoundComponent: NotFoundPage })
}

export type AppRouter = ReturnType<typeof createAppRouter>

declare module '@tanstack/react-router' {
  interface Register {
    router: AppRouter
  }
}
