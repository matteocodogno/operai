import { createRootRoute, createRoute, createRouter, redirect } from '@tanstack/react-router'
import AdminShell from './components/AdminShell'
import RolesPage from './pages/RolesPage'
import RoleEditor from './pages/RoleEditor'
import DepartmentsPage from './pages/DepartmentsPage'
import DepartmentDetail from './pages/DepartmentDetail'
import UsersPage from './pages/UsersPage'
import UserDetail from './pages/UserDetail'
import InvitationsPage from './pages/InvitationsPage'
import AccessRequestsPage from './pages/AccessRequestsPage'
import AuditPage from './pages/AuditPage'
import LegalEntitiesPage from './pages/LegalEntitiesPage'
import NotFoundPage from './pages/NotFoundPage'
import { isLegalEntityId } from './lib/legalEntityModel'
import type { LegalEntityId } from './lib/legalEntityModel'

// ---------------------------------------------------------------------------
// createAppRouter — factory, not a module-scope singleton (T14,
// specs/20260713-auth-roles-permissions/tasks.md — "give admin-ui its inner
// TanStack Router (basepath `/admin`, mirroring estimai-ui's `createAppRouter`
// factory)"). Mirrors estimai-ui/src/router.tsx's T12 (specs/20260709-suite-shell)
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
// estimai-ui's router (specs/20260709-suite-shell, AC-2.3) and design.md's F7:
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

/** The `/legal-entities` search (plan E7): every member optional, only ever one of the closed values. */
export type LegalEntitiesSearch = {
  entity?: LegalEntityId
  view?: 'details' | 'history'
  /** A whole number >= 1, only with `view=history`. */
  version?: number
}

/**
 * validateSearch of `/legal-entities` (plan E7). Whatever is not one of the closed values is DROPPED, not
 * carried, so a bad `?entity=welld_de`, `?view=x` or `?version=abc` becomes the default (no member). The
 * router leaves the raw address alone and merges this over it, so the route's `beforeLoad` rewrites the
 * address to this result (a `replace`, no history entry) before the page mounts: the bad value never reaches it. The default entity depends on what the person may manage, so the page picks it, not this.
 * `version` without `view=history` is dropped too. An unknown key is not kept.
 */
export function validateLegalEntitiesSearch(raw: Record<string, unknown>): LegalEntitiesSearch {
  const search: LegalEntitiesSearch = {}
  if (isLegalEntityId(raw.entity)) search.entity = raw.entity
  if (raw.view === 'details' || raw.view === 'history') search.view = raw.view
  if (
    search.view === 'history' &&
    typeof raw.version === 'number' &&
    Number.isSafeInteger(raw.version) &&
    raw.version >= 1
  ) {
    search.version = raw.version
  }
  return search
}

export function createAppRouter(basepath?: string) {
  const rootRoute = createRootRoute({ component: AdminShell })

  // The index renders nothing of its own: AdminShell redirects it (replace) to the first section the person
  // may use (`/roles` for an administrator, `/legal-entities` for a manager-only person, who has to wait for
  // `manageable` first, plan decision 5), which a `beforeLoad` here could not know.
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => null,
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

  // Screen A2 (Role editor / rule composer — T18, specs/20260713-auth-roles-permissions).
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

  // Screen B2 (design.md "Department detail", T19) — child of the same
  // parent as departmentsRoute, not nested under it, since it renders as
  // its own full section content (no shared layout/outlet between list and
  // detail) — same flat-children shape as every other route in this tree.
  const departmentDetailRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/departments/$id',
    component: DepartmentDetail,
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

  // Screen C2 (design.md) — user detail: attributes + role/department
  // assignment + the AC-6.4 last-admin guardrail (T20). A direct child of
  // root like every other section route above, not nested under `usersRoute`
  // — same flat shape TanStack Router uses elsewhere in this file.
  const userDetailRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/users/$id',
    component: UserDetail,
  })

  // Screen U2 (design.md "Invitations list", T10/T12, specs/20260713-user-invitations)
  // — the Users section's second tab (UsersSubNav), reached at
  // `/users/invitations`. A flat sibling of `usersRoute`/`userDetailRoute`
  // under the same root, same shape as every other route in this tree — NOT
  // nested under `usersRoute` (no shared layout/outlet between the two).
  //
  // Static-vs-dynamic segment precedence (design.md Screen U2's explicit
  // flag): `/users/invitations` (a literal path segment) and `/users/$id` (a
  // dynamic one) are both registered as children of the same parent here.
  // TanStack Router resolves the STATIC segment in preference to the dynamic
  // one regardless of registration order (standard router precedence, same
  // as every other router family) — router.test.tsx asserts this explicitly
  // so a future reordering of this array can never silently regress it.
  const invitationsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/users/invitations',
    component: InvitationsPage,
  })

  // Access requests (T9, specs/20261105-signup-gate) — the waiting list, third Users tab. Same
  // static-vs-dynamic precedence as `/users/invitations` above: the literal
  // segment wins over `/users/$id` regardless of order (asserted in router.test.tsx).
  const accessRequestsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/users/access-requests',
    component: AccessRequestsPage,
  })

  // Legal entities (T35, specs/20261117-legal-entities, plan E7): one page, the entities as tabs; the entity,
  // the view (Details | History) and an opened version are search params (`validateLegalEntitiesSearch`).
  // An unknown entity is not a 404: it falls back to the default tab.
  const legalEntitiesRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/legal-entities',
    validateSearch: validateLegalEntitiesSearch,
    // The router merges what `validateSearch` returns over the raw address, so a member the validator leaves
    // out would still ride along: the address itself is rewritten (replace) to the validated search.
    beforeLoad: ({ location }) => {
      const raw = location.search as Record<string, unknown>
      const clean = validateLegalEntitiesSearch(raw)
      const keys = Object.keys(clean) as (keyof LegalEntitiesSearch)[]
      if (Object.keys(raw).length !== keys.length || keys.some((key) => raw[key] !== clean[key])) {
        throw redirect({ to: '/legal-entities', search: clean, replace: true })
      }
    },
    component: LegalEntitiesPage,
  })

  // The mileage rates and the accounting distribution email used to live here
  // at `/rates`; they moved to refund-ui's Settings tab (`/refund/settings`) on
  // 2026-11-13 (ADR 20260720-mileage-rate-model-snapshot-admin-ui-composition amendment). The old path is left to the not-found page.

  // Time lists (T31, specs/029-time-tracking, design.md S5) — the categories and the two work-type
  // lists, served by hours-api. A flat sibling of the sections above, gated client-side by
  // SectionNav.tsx's proactive nav-entry hide (`time-list:manage`) and by the page's own
  // `PermissionDenied`, no route-level `beforeLoad` guard; the real enforcement is hours-api's live
  // `time-list:manage` check on every list write. The route is registered here, not in App.tsx
  // (specs/029 R3: the shared App.tsx stays untouched).
  const timeListsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/time-lists',
    component: TimeListsPage,
  })

  // ---------------------------------------------------------------------------
  // Route tree
  // ---------------------------------------------------------------------------

  const routeTree = rootRoute.addChildren([
    indexRoute,
    rolesRoute,
    roleEditorRoute,
    departmentsRoute,
    departmentDetailRoute,
    usersRoute,
    userDetailRoute,
    invitationsRoute,
    accessRequestsRoute,
    auditRoute,
    legalEntitiesRoute,
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
