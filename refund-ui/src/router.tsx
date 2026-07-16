import { createRootRoute, createRoute, createRouter, redirect } from '@tanstack/react-router'
import RefundShell from './components/RefundShell'
import MyRequestsPage from './pages/MyRequestsPage'
import NewRequestPage from './pages/NewRequestPage'
import RequestDetailPage from './pages/RequestDetailPage'
import ReviewQueuePage from './pages/ReviewQueuePage'
import ReviewDetailPage from './pages/ReviewDetailPage'
import NotFoundPage from './pages/NotFoundPage'

// ---------------------------------------------------------------------------
// createAppRouter — factory, not a module-scope singleton (T14,
// specs/007-refund-service/tasks.md: "an inner TanStack Router at
// basepath:'/refund' with routes requests/requests/new/requests/$id/review/
// review/$id"). Mirrors admin-ui/src/router.tsx's T14 (specs/004-auth-roles-
// permissions) factory exactly, same shape:
//
//   - Standalone (dev/test bootstrap, src/main.tsx): createAppRouter() with
//     no basepath — routes resolve at the document root.
//   - As a federated remote (src/App.tsx, exposed as `./App`, per
//     vite.config.ts): the shell mounts refund-ui under `/refund/*`, so
//     createAppRouter('/refund') rebases the SAME route definitions under
//     that prefix.
//
// All route objects are built fresh inside the factory (not at module
// scope) so two router instances — one per basepath — never share mutable
// route-tree state, same reasoning as admin-ui's/estimai-ui's routers.
//
// No `_authed` (or `access`) guard here — same rationale as admin-ui's
// router (ADR-0006): the shell's own `_authed` guard, and (per a later
// per-tool `access` guard, if ever added) already runs before refund-ui is
// ever mounted. `RefundShell` (./components/RefundShell.tsx) is the "App
// root that renders the nav + an <Outlet/>" this task's description asks
// for.
// ---------------------------------------------------------------------------

export function createAppRouter(basepath?: string) {
  const rootRoute = createRootRoute({ component: RefundShell })

  // Root redirects to Screen R1 (My requests) — design.md: "entry point for
  // every employee flow" — mirrors admin-ui's index → /roles redirect and
  // estimai-ui's index → /estimates redirect.
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    beforeLoad: () => {
      throw redirect({ to: '/requests' })
    },
  })

  // Screen R1 (My requests) — T14 placeholder, real screen T16.
  const requestsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/requests',
    component: MyRequestsPage,
  })

  // `/requests/new` — a sibling of `requestsRoute` under the same root (not
  // nested under it — neither route renders the other's content around an
  // <Outlet/>), same flat shape used throughout this suite's routers.
  // design.md F1 step 1: this route immediately POSTs a new draft and
  // redirects to `/requests/$id` — that behavior is T16's; T14 reserves the
  // route only.
  const newRequestRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/requests/new',
    component: NewRequestPage,
  })

  // Screen R2 (draft composer / request detail) — a sibling of
  // `requestsRoute`, not nested (same "/estimates" + "/estimates/$estimateId"
  // flat-sibling shape estimai-ui/admin-ui already establish).
  const requestDetailRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/requests/$id',
    component: RequestDetailPage,
  })

  // Screen A1 (Review queue) — T14 placeholder, real screen T18.
  //
  // `validateSearch` carries a one-shot `confirmation` flash message across
  // the Approve/Reject -> "return to queue" navigation (design.md F6 steps
  // 4-5: "returned to Screen A1 … with an aria-live confirmation"). No
  // existing screen in this suite passes an ephemeral message across a route
  // transition (checked: RoleEditor.tsx navigates back to /roles with no
  // confirmation at all) — TanStack Router's own `search` param is the
  // pragmatic, idiomatic mechanism for exactly this (a decision surfaced as
  // an ADR candidate in this task's implementation report, not a plan.md/
  // design.md requirement). `ReviewQueuePage` reads it once on mount and
  // strips it via a `replace` navigation so a page refresh never repeats it.
  const reviewRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/review',
    component: ReviewQueuePage,
    validateSearch: (search: Record<string, unknown>): { confirmation?: string } => ({
      confirmation: typeof search.confirmation === 'string' ? search.confirmation : undefined,
    }),
  })

  // Screen A2 (Review detail & decide) — a sibling of `reviewRoute`, not
  // nested, same shape as every other list/detail pair in this router.
  const reviewDetailRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/review/$id',
    component: ReviewDetailPage,
  })

  // ---------------------------------------------------------------------------
  // Route tree
  // ---------------------------------------------------------------------------

  const routeTree = rootRoute.addChildren([
    indexRoute,
    requestsRoute,
    newRequestRoute,
    requestDetailRoute,
    reviewRoute,
    reviewDetailRoute,
  ])

  // `defaultNotFoundComponent` is the router-wide fallback for any path that
  // matches none of the routes above.
  return createRouter({ routeTree, basepath, defaultNotFoundComponent: NotFoundPage })
}

export type AppRouter = ReturnType<typeof createAppRouter>

// TypeScript registration
declare module '@tanstack/react-router' {
  interface Register {
    router: AppRouter
  }
}
