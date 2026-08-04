import { createRootRoute, createRoute, createRouter, redirect, Outlet } from '@tanstack/react-router'
import { ShellLayout } from './components/ShellLayout'
import { RemoteMount } from './components/RemoteMount'
import { NoAccessScreen } from './components/NoAccessScreen'
import { AccountScreen } from './components/AccountScreen'
import { RoutePendingFallback } from './components/RoutePendingFallback'
import Header from './components/Header'
import Footer from './components/Footer'
import Sidebar from './components/Sidebar'
import {
  ensurePermissions,
  getCachedPermissions,
  getCachedSession,
  getSession,
  revalidatePermissions,
} from './lib/session'
import { readLastToolId, recordLastTool, resolveLastToolPath, TOOLS, type ToolId } from './lib/tools'

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
//     resolves the caller's live permissions and, if the tool being navigated
//     to is not in the resolved `apps` set, redirects to a permitted tool
//     (or `/no-access` if the user has none) INSTEAD of recording/mounting
//     the tool. On an APP SWITCH (or a cold permissions cache), this
//     force-refetches `GET /authz/me` via `shell/session`'s
//     `revalidatePermissions()` (not the cached `ensurePermissions()`), so a
//     just-revoked app is blocked on the very next navigation into it
//     (AC-7.5), not merely on the next full page load. This is a real, if
//     modest, network cost per app switch; the plan accepts it explicitly
//     ("Navigations are user-paced, so revalidation is cheap" — plan.md
//     "Immediate revocation (AC-4.3) — the mechanism").
//
//     Bug fix (2026-07): navigating WITHIN the same tool (e.g.
//     `/refund/requests` → `/refund/requests/:id`) used to pay this same
//     forced-revalidate + pending-fallback cost on every inner-route change,
//     because the shell and each remote run separate TanStack routers over
//     one shared browser history — the shell's splat route (`/estimai/$`
//     etc.) re-matches on EVERY inner navigation the remote makes, re-running
//     `beforeLoad`. With `defaultPendingMs: 0`, an async `beforeLoad` made
//     the pending fallback immediately unmount the mounted remote for that
//     ~1s round trip, then remount it — a visible tear-down/rebuild for what
//     should have been an inner-route swap invisible to the shell. Same-app
//     navigation with an already-warm permissions cache now resolves the
//     guard SYNCHRONOUSLY (see `createToolAccessBeforeLoad` below) instead —
//     no Promise returned from `beforeLoad`, so TanStack Router never enters
//     its pending state and the remote stays mounted. An app switch, or a
//     cold cache, still force-revalidates + shows the pending fallback
//     exactly as before.
//   - `/no-access` (Screen S1, design.md): rendered when the caller has zero
//     granted apps at all — reached either via the root `/` redirect (below)
//     or via a tool route's access guard.
//
// T13 (specs/005-notification-center, US-2 AC-2.1) adds:
//   - `/notify/$`: mounts the new `notify-ui` remote via RemoteMount exactly
//     like the tool routes above (see "New notify-ui remote" below) — SAME
//     mounting mechanism, but a DELIBERATE DIVERGENCE from the app-access
//     pattern: it has NO `beforeLoad` app-access guard and is NOT listed in
//     `shell/src/lib/tools.ts`'s `TOOLS` (so it never appears in the
//     permission-filtered Sidebar). plan.md "Shell changes" is explicit about
//     why: every signed-in user has notifications (US-6), and the spec's
//     non-goal forbids re-gating notification visibility by app-access. It
//     is still a CHILD of `shellRoute` (not `authedRoute` directly), so it
//     still requires a session (the `_authed` guard above) and still renders
//     inside the shared chrome — only the per-tool access check is skipped.
//     Reached from the bell (T11), not the nav.
//
// T14/T15 (specs/012-employee-address, US-6 AC-6.1; ADR-0034) add:
//   - `/account`: renders `AccountScreen` (T14) directly — the employee
//     self-view of their own stored address. Structurally identical to
//     `/notify` above (child of `shellRoute`, NO `beforeLoad` app-access
//     guard, NOT listed in `shell/src/lib/tools.ts`'s `TOOLS`) and for the
//     identical reason (plan.md "Where US-6 lives"): an employee may hold
//     ZERO app grants, and this screen must still be reachable by every
//     signed-in user regardless — a tool-gated placement would defeat the
//     GDPR transparency purpose the spec states outright. Unlike `/notify`
//     (and every tool route), `/account` doesn't mount a federated remote at
//     all — `AccountScreen` is a shell-local component (T14) — so there is
//     no `RemoteMount`/loader here, just a plain `component`. Reached from
//     the new "My profile" entry in `UserMenu` (T15), not the nav/sidebar.
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
//
// Bug fix (2026-07): this guard used to call `getSession()` unconditionally
// on EVERY navigation — a real async `/get-session` network fetch. Because
// `beforeLoad` returned a Promise, TanStack Router (`defaultPendingMs: 0`)
// entered its pending state on every same-app inner-route navigation too
// (e.g. `/refund/requests` → `/refund/review`), unmounting the mounted
// remote for the round trip and remounting it once the (unchanged) session
// check resolved — the exact same failure mode as the app-access guard
// below (`createToolAccessBeforeLoad`'s own "Bug fix (2026-07)" doc), just
// one guard earlier in the chain. Same fix, same shape: `getCachedSession()`
// (shell/session, mirrors `getCachedPermissions()`) lets a warm navigation
// resolve the decision SYNCHRONOUSLY from the last-confirmed session result
// — no Promise returned from `beforeLoad`, so the router never enters its
// pending state and the remote stays mounted. Only a cold cache (hard
// refresh, deep link, first navigation of the tab — `getCachedSession()`
// returns `null`) still awaits the real `getSession()` fetch, exactly as
// before this fix; the pending fallback is expected there. `signOut()`
// clears the session cache (session.ts), so a signed-out user is never
// treated as still-authed by this fast path — the very next navigation
// (cache now cleared) falls through to the real async check.
// ---------------------------------------------------------------------------

const buildSignInRedirectUrl = (): string =>
  `${getAuthUrl()}/sign-in?redirect=${encodeURIComponent(window.location.href)}`

const authedRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: '_authed',
  beforeLoad: (): void | Promise<void> => {
    const cachedSession = getCachedSession()

    if (cachedSession !== null) {
      // Synchronous fast path — see doc above for why returning here (not a
      // Promise) is the whole point.
      if (!cachedSession.data) {
        throw redirect({ href: buildSignInRedirectUrl() })
      }
      return
    }

    return (async () => {
      const session = await getSession()
      if (!session?.data) {
        throw redirect({ href: buildSignInRedirectUrl() })
      }
    })()
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
// T13 (specs/005-notification-center): notify-ui's exposed root — same
// loader shape as the three above.
const loadNotifyApp = () => import('notify/App')

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
 * Builds a tool route's combined `beforeLoad`.
 *
 * Two paths, chosen synchronously up front:
 *
 * - **Same app, warm cache** (the caller is already in `toolId` — per
 *   `readLastToolId()`, the tool recorded by the END of the PREVIOUS
 *   navigation's `beforeLoad` — and a permissions result is already cached,
 *   `getCachedPermissions()`): the access decision is made against that
 *   cached snapshot and this function returns a plain, non-Promise value
 *   (`undefined`, or throws `redirect` synchronously). Returning a
 *   non-Promise is what matters — TanStack Router only enters its pending
 *   state (and, with `defaultPendingMs: 0`, immediately unmounts the current
 *   route's content) when `beforeLoad` returns a Promise. This is exactly
 *   the inner-route-navigation case (module doc "Bug fix (2026-07)" above):
 *   the mounted remote is never torn down for it.
 * - **App switch, or cold cache** (different tool than last recorded, OR no
 *   permissions cached yet this session — hard refresh, deep link): returns
 *   a Promise that force-refetches `GET /authz/me` via
 *   `revalidatePermissions()` (not the cached `ensurePermissions()`), so a
 *   revocation is caught on THIS navigation (AC-7.5). This is an `async`
 *   function value, which TanStack Router awaits — the pending fallback
 *   shows, same as before this fix.
 *
 * Either path enforces the SAME access decision (redirect to a permitted
 * tool, or `/no-access`, when `toolId` is absent from `apps`) — only the
 * source of `apps` (cached vs. freshly revalidated) and the sync/async shape
 * of the check differ.
 *
 * `recordLastTool` is skipped entirely when `cause === 'preload'`: a preload
 * (e.g. hover-intent on a `Link`) is not a real visit, and writing
 * `operai_last_tool` for it would corrupt the very same-app/switch detection
 * this function relies on for the NEXT (real) navigation — a preload to a
 * different tool must never make a subsequent genuine navigation into it
 * look like "same app" and wrongly skip revalidation.
 */
const createToolAccessBeforeLoad =
  (toolId: ToolId) =>
  ({ cause }: { cause: 'preload' | 'enter' | 'stay' }): void | Promise<void> => {
    const isPreload = cause === 'preload'
    const sameApp = !isPreload && readLastToolId() === toolId
    const cachedPermissions = sameApp ? getCachedPermissions() : null

    if (cachedPermissions !== null) {
      // Synchronous fast path — see doc above for why returning here (not a
      // Promise) is the whole point.
      if (!cachedPermissions.apps.includes(toolId)) {
        throw redirect({ to: resolveAccessRedirectTarget(cachedPermissions.apps) })
      }
      recordLastTool(toolId)
      return
    }

    return (async () => {
      const permissions = await revalidatePermissions()
      if (!permissions.apps.includes(toolId)) {
        throw redirect({ to: resolveAccessRedirectTarget(permissions.apps) })
      }
      if (!isPreload) {
        recordLastTool(toolId)
      }
    })()
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
// `/notify/$` — mounts notify-ui via RemoteMount (T13, specs/005-notification-
// center, US-2 AC-2.1). Structurally identical to estimaiRoute/refundRoute/
// adminRoute above (same catch-all `/$` shape, same RemoteMount boundary,
// same parent — `shellRoute`, so it still sits under the `_authed` session
// guard and inside the shared chrome) with exactly ONE difference: NO
// `beforeLoad`. plan.md "Shell changes" (specs/005-notification-center) is
// explicit that `/notify` is deliberately NOT app-access-gated — every
// signed-in user has notifications (US-6), and the spec's non-goal forbids
// re-gating notification visibility by app-access. Consequently this route
// also does NOT call `recordLastTool` (there is no corresponding `ToolId` —
// `/notify` is intentionally absent from `shell/src/lib/tools.ts`'s `TOOLS`,
// so it never appears in the permission-filtered Sidebar; it's reached from
// the bell, T11, not the nav).
// ---------------------------------------------------------------------------

const notifyRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/notify/$',
  component: () => <RemoteMount loader={loadNotifyApp} moduleLabel="Notifications" />,
})

// ---------------------------------------------------------------------------
// `/account` — AccountScreen (T14/T15, specs/012-employee-address, US-6
// AC-6.1, ADR-0034). Deliberately NO `beforeLoad` — see the T14/T15 module
// doc above for why (mirrors `/notify` exactly). Not a splat/catch-all route
// like the tool routes: `AccountScreen` mounts no inner router of its own
// (unlike a federated remote), so there is no sub-path to catch.
// ---------------------------------------------------------------------------

const accountRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/account',
  component: () => <AccountScreen />,
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
      notifyRoute,
      accountRoute,
      noAccessRoute,
    ]),
  ]),
])

// Content-area pending fallback (`RoutePendingFallback`, ./components/
// RoutePendingFallback.tsx — QE fix, moved out of this file to fix a
// react-refresh/only-export-components lint error: this module exports route/
// router CONFIGURATION, not components, and Fast Refresh can't safely handle
// a module mixing the two) shown ONLY while an app-switch (or cold-cache)
// tool route's `beforeLoad` is awaiting its Promise (createToolAccessBeforeLoad
// → revalidatePermissions() → GET /authz/me, ~1s) — same-app inner-route
// navigation resolves that same `beforeLoad` synchronously (see
// `createToolAccessBeforeLoad`'s doc) and therefore never triggers this
// fallback at all. On a genuine app switch, without this fallback TanStack
// Router would keep the OUTGOING remote mounted during that window — and that
// remote's inner router, now seeing the new (cross-basepath) URL, would render
// its own "Not Found" until the new route resolves. `defaultPendingMs: 0`
// shows this immediately on an app-switch navigation so the stale remote is
// never displayed mid-switch; the shell chrome (header/sidebar/footer) stays
// mounted since only the tool-route child is pending.

export const router = createRouter({
  routeTree,
  defaultPendingComponent: RoutePendingFallback,
  defaultPendingMs: 0,
})

// TypeScript registration
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
