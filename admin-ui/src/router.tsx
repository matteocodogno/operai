import { createRootRoute, createRoute, createRouter, redirect } from '@tanstack/react-router'
import AdminShell from './components/AdminShell'
import RolesPage from './pages/RolesPage'
import RoleEditor from './pages/RoleEditor'
import DepartmentsPage from './pages/DepartmentsPage'
import UsersPage from './pages/UsersPage'
import AuditPage from './pages/AuditPage'
import NotFoundPage from './pages/NotFoundPage'

// ---------------------------------------------------------------------------
// createAppRouter — factory, not a module-scope singleton (T14,
// specs/004-auth-roles-permissions/tasks.md — "give admin-ui its inner
// TanStack Router (basepath `/admin`, mirroring estimai-ui's `createAppRouter`
// factory)"). Mirrors estimai-ui/src/router.tsx's T12 (specs/003-suite-shell)
// factory exactly, same shape, new routes:
//
//   - Standalone (dev/test bootstrap, src/main.tsx): createAppRouter() with
//     no basepath — routes resolve at the document root.
//   - As a federated remote (src/App.tsx, exposed as `./App`, per
//     vite.config.ts): the shell mounts admin-ui under `/admin/*`, so
//     createAppRouter('/admin') rebases the SAME route definitions under
//     that prefix so internal navigation between sections (Roles ↔
//     Departments ↔ Users ↔ Audit) resolves correctly there.
//
// All route objects are built fresh inside the factory (not at module
// scope) so two router instances — one per basepath — never share mutable
// route-tree state, same reasoning as estimai-ui's router.
//
// No `_authed` (or `access`) guard here either — same rationale as
// estimai-ui's router (specs/003-suite-shell, AC-2.3) and design.md's F7:
// the shell's own `_authed` guard, and (per a later task of this feature) a
// per-tool `access` guard, already run before admin-ui is ever mounted. A
// second, independent guard here would be redundant; a mid-session 403 from
// an actual `/admin/*` API call (design.md's F7 "defense in depth" race
// case, Screen E1) is a later task's concern (T15/T22), not this router's.
//
// The root route's component (AdminShell, ./components/AdminShell.tsx) is
// "the App root that renders the nav + an `<Outlet/>`" this task's
// description asks for — it mounts the section nav (./components/
// SectionNav.tsx) once, above whichever section route currently renders.
// ---------------------------------------------------------------------------

export function createAppRouter(basepath?: string) {
  const rootRoute = createRootRoute({ component: AdminShell })

  // Root redirects to the first section (Roles) — mirrors estimai-ui's own
  // index → /estimates redirect (src/router.tsx's indexRoute).
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    beforeLoad: () => {
      throw redirect({ to: '/roles' })
    },
  })

  // ---------------------------------------------------------------------------
  // The four admin sections (design.md Screens A1/B1/C1/D1) — placeholder
  // pages for now; the real screens are T17–T21.
  // ---------------------------------------------------------------------------

  const rolesRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/roles',
    component: RolesPage,
  })

  // Screen A2 (Role editor / rule composer — T18, specs/004-auth-roles-permissions).
  // A sibling of `rolesRoute` under the same root, exactly like estimai-ui's
  // `/estimates` + `/estimates/$estimateId` pair (src/router.tsx) — not a
  // nested child of `rolesRoute`, since neither route renders the other's
  // content around an <Outlet/>.
  const roleEditorRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/roles/$id',
    component: RoleEditor,
  })

  const departmentsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/departments',
    component: DepartmentsPage,
  })

  const usersRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/users',
    component: UsersPage,
  })

  const auditRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/audit',
    component: AuditPage,
  })

  // ---------------------------------------------------------------------------
  // Route tree
  // ---------------------------------------------------------------------------

  const routeTree = rootRoute.addChildren([
    indexRoute,
    rolesRoute,
    roleEditorRoute,
    departmentsRoute,
    usersRoute,
    auditRoute,
  ])

  // `defaultNotFoundComponent` is the router-wide fallback for any path that
  // matches none of the routes above (TanStack Router's own "not-found route"
  // mechanism — no explicit catch-all/splat route needed for this).
  return createRouter({ routeTree, basepath, defaultNotFoundComponent: NotFoundPage })
}

export type AppRouter = ReturnType<typeof createAppRouter>

// TypeScript registration
declare module '@tanstack/react-router' {
  interface Register {
    router: AppRouter
  }
}
