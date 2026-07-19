import { Link, Outlet } from '@tanstack/react-router'
import { strings } from '../strings'

/**
 * RefundShell — refund-ui's own root layout (T14,
 * specs/007-refund-service/tasks.md: "RefundShell root layout: heading + a
 * two-item nav … + <Outlet/>, mirroring AdminShell"), wired as the inner
 * router's root route component (see ../router.tsx's
 * `createRootRoute({ component: RefundShell })`).
 *
 * Mirrors `admin-ui/src/components/AdminShell.tsx` exactly: a heading
 * identifying the tool, a small nav (here: "My requests" | "Review queue" |
 * "Monthly processing" — design.md's `RefundShell` spec), and the
 * `<Outlet/>` the routes (../pages/*.tsx) render into. No suite chrome
 * duplicated here (Header/UserMenu/bell/ThemeToggle, sign-out, …) — per
 * ADR-0006 and design.md's own `RefundShell` note ("No suite chrome
 * duplicated … that already wraps refund-ui from the shell"), that chrome
 * already exists once in the shell. No auth guard either — the shell's own
 * `_authed` guard already runs before refund-ui is ever mounted (same
 * rationale as AdminShell/estimai-ui's router).
 *
 * The "Review queue" and "Monthly processing" links are rendered
 * UNCONDITIONALLY, regardless of whether the signed-in user actually holds
 * the `request:review` capability — this is design.md's deliberate Gap #7,
 * not an oversight: refund-ui has no cheap way to know the caller's
 * permissions client-side (ADR-0007 token minimalism; `GET
 * /authz/resolve`/`GET /authz/me` are resource-server/session-cookie-gated
 * seams this plan does not expose to refund-ui itself). The suite-level
 * shell nav is the actual UX-hiding mechanism (plan.md: "the shell nav item
 * is likewise gated"); these internal tabs are harmless dead ends for a
 * non-accounting user, caught by `PermissionDenied` on Screen A1/B1 once
 * their real screens are built. "Monthly processing" (specs/008 T9) is
 * gated the SAME way "Review queue" already is — the client renders it, the
 * API/`PermissionDenied` is the real gate (design.md's `RefundShell` entry:
 * "gains a third nav item … rendered unconditionally next to 'My
 * requests'/'Review queue'").
 */
export default function RefundShell() {
  return (
    <div className="min-h-screen" style={{ color: 'var(--text)', fontFamily: 'var(--body)' }}>
      <header style={{ borderBottom: '1px solid var(--rule)', backgroundColor: 'var(--ink-soft)' }}>
        <div className="mx-auto max-w-5xl px-6 py-4">
          <h1 className="text-xl font-bold" style={{ fontFamily: 'var(--disp)' }}>
            {strings.appTitle}
          </h1>
        </div>
        <nav aria-label={strings.nav.landmarkLabel}>
          <ul className="mx-auto flex max-w-5xl gap-1 px-6">
            <li>
              <Link
                to="/requests"
                className="inline-block border-b-2 border-transparent px-3 py-3 text-sm font-medium transition-colors hover:text-[var(--text)]"
                style={{ color: 'var(--soft)' }}
                activeProps={{ style: { color: 'var(--acc)', borderColor: 'var(--acc)' } }}
              >
                {strings.nav.myRequests}
              </Link>
            </li>
            <li>
              <Link
                to="/review"
                className="inline-block border-b-2 border-transparent px-3 py-3 text-sm font-medium transition-colors hover:text-[var(--text)]"
                style={{ color: 'var(--soft)' }}
                activeProps={{ style: { color: 'var(--acc)', borderColor: 'var(--acc)' } }}
              >
                {strings.nav.reviewQueue}
              </Link>
            </li>
            <li>
              <Link
                to="/batches"
                className="inline-block border-b-2 border-transparent px-3 py-3 text-sm font-medium transition-colors hover:text-[var(--text)]"
                style={{ color: 'var(--soft)' }}
                activeProps={{ style: { color: 'var(--acc)', borderColor: 'var(--acc)' } }}
              >
                {strings.nav.monthlyProcessing}
              </Link>
            </li>
          </ul>
        </nav>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-8">
        <Outlet />
      </main>
    </div>
  )
}
