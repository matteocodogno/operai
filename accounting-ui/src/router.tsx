import { createRootRoute, createRoute, createRouter, Outlet, redirect } from '@tanstack/react-router'
import type { RouteComponent } from '@tanstack/react-router'
import ExchangeRatesPage from './pages/ExchangeRatesPage'
import LedgerAccountsPage from './pages/LedgerAccountsPage'
import NotFoundPage from './pages/NotFoundPage'
import VatCodesPage from './pages/VatCodesPage'

/**
 * accounting-ui's inner router (specs/20261119-accounting), basepath `/accounting` — the shell mounts this remote at its
 * gated `/accounting/$` route:
 *
 *   /accounting                    redirects to /accounting/ledger-accounts (`?entity=` kept)
 *   /accounting/ledger-accounts    the three views are routes, so they are a `TabNav` of links (design UX-1)
 *   /accounting/vat-codes
 *   /accounting/exchange-rates     the AC-7.3 deep link is `?entity=welld_ch&month=2026-03`
 *
 * The routes below are relative to the basepath. Any other path is the not-found panel (design AS7). No auth guard and no
 * chrome (ADR 20260709-suite-frontend-module-federation). `Root` is the layout seam: App.tsx passes `AccountingShell`; tests
 * may render a page under a bare `<Outlet/>`.
 */

/** The search parameters every view takes. */
export type AccountingSearch = { entity?: string; month?: string }

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/

/**
 * `?entity=` is kept as the string it is, NOT narrowed to the two entity ids: the frame tells "absent", "not an entity id" (falls
 * back and is rewritten) and "a known entity the person does not cover" (the not-found view) apart (design UX-12), and a
 * validator that dropped a garbage value would erase the first and the second. `?month=YYYY-MM` is kept only when well formed.
 */
export const validateAccountingSearch = (raw: Record<string, unknown>): AccountingSearch => ({
  entity: typeof raw.entity === 'string' && raw.entity !== '' ? raw.entity : undefined,
  month: typeof raw.month === 'string' && MONTH.test(raw.month) ? raw.month : undefined,
})

export function createAppRouter(basepath?: string, Root: RouteComponent = Outlet) {
  const rootRoute = createRootRoute({ component: Root })

  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    validateSearch: validateAccountingSearch,
    beforeLoad: ({ search }) => {
      throw redirect({ to: '/ledger-accounts', search: { entity: search.entity }, replace: true })
    },
  })
  const ledgerAccountsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/ledger-accounts',
    validateSearch: validateAccountingSearch,
    component: LedgerAccountsPage,
  })
  const vatCodesRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/vat-codes',
    validateSearch: validateAccountingSearch,
    component: VatCodesPage,
  })
  const exchangeRatesRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/exchange-rates',
    validateSearch: validateAccountingSearch,
    component: ExchangeRatesPage,
  })

  const routeTree = rootRoute.addChildren([indexRoute, ledgerAccountsRoute, vatCodesRoute, exchangeRatesRoute])

  return createRouter({ routeTree, basepath, defaultNotFoundComponent: NotFoundPage })
}

export type AppRouter = ReturnType<typeof createAppRouter>

declare module '@tanstack/react-router' {
  interface Register {
    router: AppRouter
  }
}
