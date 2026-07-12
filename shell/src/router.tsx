import { createRootRoute, createRoute, createRouter, redirect, Outlet } from '@tanstack/react-router'
import { ShellLayout } from './components/ShellLayout'
import { RemoteMount } from './components/RemoteMount'
import { NoAccessScreen } from './components/NoAccessScreen'
import Header from './components/Header'
import Footer from './components/Footer'
import Sidebar from './components/Sidebar'
import { ensurePermissions, getSession, revalidatePermissions } from './lib/session'
import { recordLastTool, resolveLastToolPath, TOOLS, type ToolId } from './lib/tools'

// ---------------------------------------------------------------------------
// Shell router — the integration keystone (T9, specs/003-suite-shell).
//
// Composes everything built by the earlier tasks into a real, guarded,
// routed app:
//   - `_authed` (pathless): the suite-wide session guard (AC-2.1, ADR-0002),
//     ported verbatim from estimai-ui's `_authed` route (T4's `shell/session`
//     supplies `getSession` instead of estimai-ui's own `authClient`).
//   - `_shell` (pathless, child of `_authed`): renders ShellLayout (T5) with
//     its header/footer slots filled by the T6 chrome and the T8 footer.
//     Because this is a shared PARENT layout route, TanStack Router keeps it
//     (and everything it renders — header, sidebar slot, footer) mounted
//     across navigations between its child routes; only the child route's
//     content re-renders (AC-1.2).
//   - Tool routes, children of `_shell`: `/estimai/$` and `/refund/$` (a
//     splat/catch-all path, which also matches the bare `/estimai`/`/refund`
//     — see the "One route per tool" comment below for why there's no
//     separate exact-path route) each mount their remote via RemoteMount
//     (T11). The catch-all exists because each remote runs its OWN inner
//     router (basepath `/estimai` / `/refund`, T12/T15) — the shell only
//     needs to know "this whole subtree belongs to this tool", not the
//     remote's internal route shape, so a deep link like
//     `/estimai/estimates/42` resolves to the SAME shell route (and the SAME
//     RemoteMount/loader) as `/estimai`, and the remote's own router takes it
//     from there (AC-3.2, AC-3.3).
//
// Deliberately NOT built here (see task scope guardrails):
//   - `refund-ui` doesn't exist yet (T15) — `/refund`'s loader will 404 at
//     runtime until then; RemoteMount's error boundary (T11) is exactly the
//     mechanism that turns that into an in-place, recoverable error instead
//     of a crash (see this task's final report for why that's a drift note,
//     not a blocker).
//
// T10 (AC-3.4) adds:
//   - The root-landing redirect on `/` (see indexRoute below): resolves the
//     most-recently-used tool from `operai_last_tool` (shell/src/lib/tools.ts),
//     falling back to EstimAI, and throws a client-side `redirect` to it.
//   - A `beforeLoad` writer on each tool route (estimaiRoute/refundRoute)
//     that records the tool as most-recently-used whenever that ROUTE
//     becomes active — sidebar clicks, deep links, and programmatic
//     `.navigate()` calls all go through route matching, so all of them are
//     captured uniformly here rather than only wiring the sidebar's click
//     handler.
//
// T25 (specs/004-auth-roles-permissions, US-7, AC-7.3/7.4/7.5) adds:
//   - `/admin/$`: a third tool route, mounting the new `admin-ui` remote
//     exactly like `/estimai/$`/`/refund/$` (see "New admin-ui remote"
//     below).
//   - An app-access guard on EVERY tool route (`createToolAccessBeforeLoad`):
//     resolves the caller's live permissions (`shell/session`'s
//     `revalidatePermissions()`, ADR-0007) and, if the tool being navigated
//     to is not in the resolved `apps` set, redirects to a permitted tool
//     (or `/no-access` if the user has none) INSTEAD of recording/mounting
//     the tool. `revalidatePermissions()` (not the cached `ensurePermissions()`)
//     is used deliberately here — it force-refetches `GET /authz/me` on every
//     navigation into a tool route, so a just-revoked app is blocked on the
//     very next navigation (AC-7.5), not merely on the next full page load.
//     This is a real, if modest, network cost per tool navigation; the plan
//     accepts it explicitly ("Navigations are user-paced, so revalidation is
//     cheap" — plan.md "Immediate revocation (AC-4.3) — the mechanism").
//   - `/no-access` (Screen S1, design.md): rendered when the caller has zero
//     granted apps at all — reached either via the root `/` redirect (below)
//     or via a tool route's access guard.
// ---------------------------------------------------------------------------

const getAuthUrl = (): string => import.meta.env.VITE_AUTH_URL as string

const rootRoute = createRootRoute({ component: () => <Outlet /> })

// ---------------------------------------------------------------------------
// _authed — pathless guard (AC-2.1, AC-2.5)
//
// Identical contract to estimai-ui/src/router.tsx's `_authed` route (the
// pattern this task is told to reuse exactly): resolves the session via
// shell/session's getSession() (cookie-based, T4); no session → throws a
// full-page redirect (redirect({ href }) infers reloadDocument: true, see
// @tanstack/router-core's redirect.js) to
// `<AUTH_URL>/sign-in?redirect=<current absolute URL>`. The `redirect` value
// is the real window.location.href — open-redirect safe because the auth
// service only ever honours its own ALLOWED_ORIGINS allowlist when deciding
// where to send the user back to (ADR-0002), not because this value is
// validated client-side.
// ---------------------------------------------------------------------------

const authedRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: '_authed',
  beforeLoad: async () => {
    const session = await getSession()
    if (!session?.data) {
      const signInUrl = `${getAuthUrl()}/sign-in?redirect=${encodeURIComponent(window.location.href)}`
      throw redirect({ href: signInUrl })
    }
  },
})

// ---------------------------------------------------------------------------
// _shell — pathless layout route, child of _authed (AC-1.1, AC-1.2)
//
// Renders ShellLayout with the header/sidebar/footer slots filled — Header
// (T6 chrome, composed in its own file, components/Header.tsx: see that
// file's doc for why it isn't defined inline here), Sidebar (T7, the tool
// switcher — reads the active route itself via useMatchRoute, needs no props
// from here), and Footer (T8).
// ---------------------------------------------------------------------------

const shellRoute = createRoute({
  getParentRoute: () => authedRoute,
  id: '_shell',
  component: () => <ShellLayout header={<Header />} sidebar={<Sidebar />} footer={<Footer />} />,
})

// ---------------------------------------------------------------------------
// Root index `/` — redirect to the most-recently-used tool (T10, AC-3.4,
// design.md Flow 2)
//
// `/` never renders a screen of its own (design.md: "Root path / — No
// dedicated screen"). `resolveLastToolPath()` (shell/src/lib/tools.ts) reads
// `localStorage['operai_last_tool']`, VALIDATES it against the known tool id
// set (`isToolId`), and returns that tool's path — or the EstimAI default's
// path when the key is absent, unreadable (storage exception, no
// localStorage), or holds an unrecognized/tampered value. A bad stored value
// can therefore only ever resolve to a route this app itself defines, never
// an arbitrary string (no open-redirect surface).
//
// `redirect({ to })` (no `href`) is a CLIENT-SIDE router redirect, not a full
// page navigation — this happens inside the shell, under the already-
// resolved `_authed` guard, so a client-side transition (not a document
// reload, unlike the guard's sign-in redirect) is correct here.
//
// T25 (AC-7.4, design.md Flow F8): if the caller's `apps` is empty, there is
// nothing to redirect to — this route sends them to `/no-access` (Screen S1)
// directly instead of following `resolveLastToolPath()`'s always-a-tool
// fallback. `ensurePermissions()` (the CACHED resolver, not the forced
// `revalidatePermissions()` used by the tool routes below) is enough here:
// this route never mounts a tool itself, and whichever tool it redirects to
// re-checks access itself via its own guard on the very next `beforeLoad`, so
// a value that's gone stale between this check and that one self-corrects
// there (see "New in T25" module doc above).
// ---------------------------------------------------------------------------

const indexRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/',
  beforeLoad: async () => {
    const permissions = await ensurePermissions()
    if (permissions.apps.length === 0) {
      throw redirect({ to: '/no-access' })
    }
    throw redirect({ to: resolveLastToolPath() })
  },
})

// ---------------------------------------------------------------------------
// Tool routes — mount a remote's exposed `./App` via RemoteMount (T11).
//
// `loadEstimaiApp`/`loadRefundApp` are module-scope constants (not inline
// arrows in the route `component`) so their identity is stable across
// re-renders — RemoteMount's `loader` feeds a `useMemo([loader, attempt])`
// that must NOT recompute on every parent render, only on an explicit Retry
// (see RemoteMount.tsx's module doc) or a genuine navigation. An inline
// `() => import(...)` here would get a fresh identity every render and
// defeat that memoization.
//
// One route per tool, using a `$` catch-all/splat path (`/estimai/$`, not a
// separate `/estimai` + `/estimai/$` pair): TanStack Router's splat matches
// the bare parent path too (an empty splat), so a *second*, separate exact
// route at the same literal path is redundant and actively ambiguous — it
// produced a "matched route ... instead" console warning during `.navigate()`
// reverse-path generation in this task's own integration tests, because two
// distinct route definitions both claimed the literal `/estimai` path. One
// splat route per tool covers both `/estimai` and `/estimai/anything/else`
// cleanly. Each remote runs its own inner router (basepath `/estimai` /
// `/refund`, T12/T15) — the shell only needs to recognize "this whole
// subtree is this tool" (see the file-level doc above), never the remote's
// internal route shape.
// ---------------------------------------------------------------------------

const loadEstimaiApp = () => import('estimai/App')
const loadRefundApp = () => import('refund/App')
// T25 (specs/004-auth-roles-permissions, US-1 host side): admin-ui's exposed
// root — same loader shape as the two above.
const loadAdminApp = () => import('admin/App')

// ---------------------------------------------------------------------------
// App-access guard (T25, US-7, AC-7.3/7.4/7.5) — one factory shared by every
// tool route's `beforeLoad`, so the check/redirect logic exists exactly once
// instead of being hand-copied per tool.
//
// `resolveAccessRedirectTarget` picks the fallback destination for a caller
// who lacks the tool they navigated to: the first tool (in `TOOLS` order,
// shell/src/lib/tools.ts) present in their resolved `apps`, or `/no-access`
// (Screen S1) if `apps` is empty. Never returns the tool that was just
// denied — by construction it can't: the caller only reaches this branch
// when that tool's id is NOT in `apps`.
// ---------------------------------------------------------------------------

const resolveAccessRedirectTarget = (apps: readonly string[]): string => {
  const permitted = TOOLS.find(tool => apps.includes(tool.id))
  return permitted ? permitted.to : '/no-access'
}

/**
 * Builds a tool route's combined `beforeLoad`: revalidate permissions live
 * (force-refetch `GET /authz/me` via `revalidatePermissions()`, not the
 * cached `ensurePermissions()`, so a revocation is caught on THIS
 * navigation — AC-7.5), then either redirect away (tool not granted) or
 * record the tool as most-recently-used (T10) and let the route render.
 */
const createToolAccessBeforeLoad = (toolId: ToolId) => async () => {
  const permissions = await revalidatePermissions()
  if (!permissions.apps.includes(toolId)) {
    throw redirect({ to: resolveAccessRedirectTarget(permissions.apps) })
  }
  recordLastTool(toolId)
}

const estimaiRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/estimai/$',
  beforeLoad: createToolAccessBeforeLoad('estimai'),
  component: () => <RemoteMount loader={loadEstimaiApp} moduleLabel="EstimAI" />,
})

const refundRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/refund/$',
  beforeLoad: createToolAccessBeforeLoad('refund'),
  component: () => <RemoteMount loader={loadRefundApp} moduleLabel="Refund" />,
})

const adminRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/admin/$',
  beforeLoad: createToolAccessBeforeLoad('admin'),
  component: () => <RemoteMount loader={loadAdminApp} moduleLabel="Admin" />,
})

// ---------------------------------------------------------------------------
// `/no-access` — Screen S1 (T25, design.md, AC-7.4). Reached either from the
// root `/` redirect above (zero apps, nothing to land on) or from a tool
// route's access guard (zero apps, redirected here instead of a permitted
// tool). No `beforeLoad` of its own — it is always the TARGET of a redirect
// already backed by a resolved (empty) `apps` set, never navigated to
// directly by the user.
// ---------------------------------------------------------------------------

const noAccessRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/no-access',
  component: () => <NoAccessScreen />,
})

// ---------------------------------------------------------------------------
// Route tree + router
// ---------------------------------------------------------------------------

export const routeTree = rootRoute.addChildren([
  authedRoute.addChildren([
    shellRoute.addChildren([
      indexRoute,
      estimaiRoute,
      refundRoute,
      adminRoute,
      noAccessRoute,
    ]),
  ]),
])

export const router = createRouter({ routeTree })

// TypeScript registration
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
