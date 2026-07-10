import { createRootRoute, createRoute, createRouter, redirect, Outlet } from '@tanstack/react-router'
import { ShellLayout } from './components/ShellLayout'
import { RemoteMount } from './components/RemoteMount'
import Header from './components/Header'
import Footer from './components/Footer'
import { getSession } from './lib/session'

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
//   - The Sidebar (T7) — ShellLayout's `sidebar` slot is left at its built-in
//     placeholder.
//   - The root-landing "last used tool" redirect (T10) — `/` renders a
//     minimal static index for now.
//   - `refund-ui` doesn't exist yet (T15) — `/refund`'s loader will 404 at
//     runtime until then; RemoteMount's error boundary (T11) is exactly the
//     mechanism that turns that into an in-place, recoverable error instead
//     of a crash (see this task's final report for why that's a drift note,
//     not a blocker).
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
// Renders ShellLayout with the header/footer slots filled — Header (T6
// chrome, composed in its own file, components/Header.tsx: see that file's
// doc for why it isn't defined inline here) and Footer (T8). The `sidebar`
// slot is intentionally left unset here — ShellLayout falls back to its own
// placeholder until T7 builds the real Sidebar (see T7's `deps: T5, T9`,
// i.e. T7 depends on THIS route existing, not the other way around).
// ---------------------------------------------------------------------------

const shellRoute = createRoute({
  getParentRoute: () => authedRoute,
  id: '_shell',
  component: () => <ShellLayout header={<Header />} footer={<Footer />} />,
})

// ---------------------------------------------------------------------------
// Root index `/` — minimal placeholder (T10 scope guardrail)
//
// T10 replaces this with the "redirect to most-recently-used tool, fallback
// EstimAI" logic (AC-3.4). Building that here would be scope creep — this is
// deliberately NOT a redirect and NOT a tool launcher, just a static message
// so `/` renders something coherent inside the chrome in the meantime.
// ---------------------------------------------------------------------------

const indexRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/',
  component: () => (
    <div className="px-6 py-16 text-center text-sm text-muted">
      Select a tool to get started.
    </div>
  ),
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

const estimaiRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/estimai/$',
  component: () => <RemoteMount loader={loadEstimaiApp} moduleLabel="EstimAI" />,
})

const refundRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/refund/$',
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
