import { createRootRoute, createRoute, createRouter, redirect, Outlet } from '@tanstack/react-router'
import EstimatesPage from './pages/EstimatesPage'
import EstimatePage from './pages/EstimatePage'
import { createProject } from './lib/projects'
import * as estimatesApi from './lib/estimatesApi'
import type { EstimateFull } from './lib/estimatesApi'

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
// T13 (specs/003-suite-shell/tasks.md, AC-2.3): this router NO LONGER runs
// its own `_authed` session guard. estimai-ui runs as a federated remote
// inside the shell; the shell's OWN `_authed` guard (shell/src/router.tsx,
// T9) already resolves the session — via the SAME shared `shell/session`
// module this file's own session/API facades now delegate to (see
// src/lib/api.ts, src/lib/authClient.ts) — before RemoteMount (shell T11)
// ever imports this module. A second, independent guard here would be
// redundant at best and, per AC-2.3 ("the tool ... does not perform its own
// independent sign-in redirect"), is an explicit non-goal. All four app
// routes below are therefore direct children of the root route, unguarded.
//
// This does leave the standalone dev/test bootstrap (src/main.tsx) without
// ANY sign-in redirect of its own when run outside the shell — see that
// file's doc comment for why that's an accepted limitation (AC-4.3: EstimAI
// is reachable only through the shell in production).
// ---------------------------------------------------------------------------

export function createAppRouter(basepath?: string) {
  const rootRoute = createRootRoute({ component: () => <Outlet /> })

  // ---------------------------------------------------------------------------
  // App routes (direct children of root — no guarding layout route, AC-2.3)
  // ---------------------------------------------------------------------------

  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    beforeLoad: () => {
      // After localStorage→server cutover, the index simply redirects to the
      // list. The "last opened" localStorage key is preserved (not deleted) so
      // the T12 import flow can still read legacy keys.
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

  // ---------------------------------------------------------------------------
  // Route tree
  // ---------------------------------------------------------------------------

  const routeTree = rootRoute.addChildren([indexRoute, estimatesRoute, estimateRoute])

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
