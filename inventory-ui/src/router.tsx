import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  redirect,
  type RouteComponent,
} from '@tanstack/react-router'
import AssetDetailPage from './pages/AssetDetailPage'
import AssetsPage from './pages/AssetsPage'
import FiscalYearDetailPage from './pages/FiscalYearDetailPage'
import FiscalYearsPage from './pages/FiscalYearsPage'
import NotFoundPage from './pages/NotFoundPage'
import RegisterAssetPage from './pages/RegisterAssetPage'
import RulesPage from './pages/RulesPage'

/**
 * inventory-ui's inner router (T24, specs/015-hardware-inventory), the tool's
 * six screens from design.md § Screens & states:
 *
 *   /assets                       T1 Assets list
 *   /assets/new                   T3 Register asset
 *   /assets/$id                   T2 Asset detail
 *   /rules                        T4 Depreciation rules
 *   /years                        T5 Fiscal years
 *   /years/$entity/$year          T6 Fiscal year detail
 *
 * The employee devices view (D1) is deliberately NOT here: it is the remote's
 * second, ungated entry (`./MyDevices`, mounted by the shell at `/devices`,
 * ADR-0045) and has no inner router.
 *
 * Every page is a placeholder file in T24; the owning task fills the body of
 * its own page file, so no later task edits this one. The route tree carries
 * NO auth guard and no chrome of its own (ADR-0006) — capability gating is
 * the layout's job (T28).
 *
 * `Root` is the layout seam: it defaults to a bare `<Outlet/>`, and T28's
 * `InventoryShell` is passed in from `App.tsx` (which that task owns), so the
 * shell can use router context (Links, active tab) without this file changing.
 */
export function createAppRouter(basepath?: string, Root: RouteComponent = Outlet) {
  const rootRoute = createRootRoute({ component: Root })

  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    beforeLoad: () => {
      throw redirect({ to: '/assets' })
    },
  })

  const assetsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/assets',
    component: AssetsPage,
  })

  // Sibling of `/assets/$id`, not a child: TanStack Router ranks the static
  // `new` segment above the `$id` param, so `/assets/new` is never read as an id.
  const registerAssetRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/assets/new',
    component: RegisterAssetPage,
  })

  const assetDetailRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/assets/$id',
    component: AssetDetailPage,
  })

  const rulesRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/rules',
    component: RulesPage,
  })

  const yearsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/years',
    component: FiscalYearsPage,
  })

  const yearDetailRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/years/$entity/$year',
    component: FiscalYearDetailPage,
  })

  const routeTree = rootRoute.addChildren([
    indexRoute,
    assetsRoute,
    registerAssetRoute,
    assetDetailRoute,
    rulesRoute,
    yearsRoute,
    yearDetailRoute,
  ])

  return createRouter({ routeTree, basepath, defaultNotFoundComponent: NotFoundPage })
}

export type AppRouter = ReturnType<typeof createAppRouter>

declare module '@tanstack/react-router' {
  interface Register {
    router: AppRouter
  }
}
