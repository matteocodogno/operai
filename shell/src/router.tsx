import { createRootRoute, createRoute, createRouter, redirect, Outlet } from '@tanstack/react-router'
import { ShellLayout } from './components/ShellLayout'
import { RemoteMount } from './components/RemoteMount'
import Header from './components/Header'
import Footer from './components/Footer'
import Sidebar from './components/Sidebar'
import { getSession } from './lib/session'
import { recordLastTool, resolveLastToolPath } from './lib/tools'

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
// ---------------------------------------------------------------------------

const indexRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/',
  beforeLoad: () => {
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

// Each tool route's `beforeLoad` writes its id to `operai_last_tool` (T10,
// AC-3.4, Flow 3 step 4) whenever the route matches — the writer lives on the
// ROUTE, not on a sidebar click handler, so deep links (typed/shared URLs)
// and programmatic `.navigate()` calls record the tool exactly like a
// sidebar click does. `recordLastTool` is defensive about storage failures
// itself (shell/src/lib/tools.ts), so no try/catch is needed here.

const estimaiRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/estimai/$',
  beforeLoad: () => {
    recordLastTool('estimai')
  },
  component: () => <RemoteMount loader={loadEstimaiApp} moduleLabel="EstimAI" />,
})

const refundRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/refund/$',
  beforeLoad: () => {
    recordLastTool('refund')
  },
  component: () => <RemoteMount loader={loadRefundApp} moduleLabel="Refund" />,
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
