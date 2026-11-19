import { createRootRoute, createRoute, createRouter, Outlet } from '@tanstack/react-router'
import type { RouteComponent, RouterHistory } from '@tanstack/react-router'
import EveryoneHoursPage from './pages/EveryoneHoursPage'
import MyHoursPage from './pages/MyHoursPage'
import NotFoundPage from './pages/NotFoundPage'
import SettingsPage from './pages/SettingsPage'

/**
 * hours-ui's inner router (specs/20261112-time-tracking, ADR 20261112-hours-ui-ungated-remote), basepath `/hours` — the shell mounts
 * this remote at its own ungated `/hours/$` route (no `beforeLoad`, not a TOOLS entry):
 *
 *   /hours        My hours: the person's own entries, totals and the entry dialog (T24–T28, T30)
 *   /hours/all    Everyone's hours: read only, for holders of `time-entry:read-all` (T29)
 *   /hours/settings  Settings: the time lists (categories, work types), for holders of `time-list:manage` (T43, D51;
 *                 was admin-ui's /admin/time-lists)
 *
 * The routes below are relative to the basepath. Anything else is the not-found panel. No auth guard
 * and no chrome (ADR 20260709-suite-frontend-module-federation). `Root` is the layout seam: App.tsx passes `HoursShell`; tests may
 * render a page under a bare `<Outlet/>`. The optional `history` is for tests (a memory history);
 * production uses the browser's.
 */
export function createAppRouter(basepath?: string, Root: RouteComponent = Outlet, history?: RouterHistory) {
  const rootRoute = createRootRoute({ component: Root })

  const myHoursRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: MyHoursPage })
  const everyoneRoute = createRoute({ getParentRoute: () => rootRoute, path: '/all', component: EveryoneHoursPage })

  // The route is open and the page checks the permission, as Everyone's hours does: the tab is a convenience
  // and hours-api is the gate (a typed address without the permission shows the denial and asks nothing).
  const settingsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/settings', component: SettingsPage })

  const routeTree = rootRoute.addChildren([myHoursRoute, everyoneRoute, settingsRoute])

  return createRouter({ routeTree, basepath, history, defaultNotFoundComponent: NotFoundPage })
}

export type AppRouter = ReturnType<typeof createAppRouter>

declare module '@tanstack/react-router' {
  interface Register {
    router: AppRouter
  }
}
