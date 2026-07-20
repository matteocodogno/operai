import { Link, Outlet } from '@tanstack/react-router'
import { usePermissions } from 'shell/session'
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
 * The "Review queue" and "Monthly processing" links are rendered only when
 * the signed-in user actually holds a `request:review` grant. The doc
 * comment this replaces claimed refund-ui had "no cheap way to know the
 * caller's permissions client-side" (design.md's Gap #7) — that premise is
 * now OUTDATED: the shell already resolves the caller's full effective
 * permission set (ADR-0007's `GET /authz/me`) and exposes it to every remote
 * via `shell/session`'s `usePermissions()` (the exact same seam the shell's
 * own `Sidebar` uses to filter its tool list). `canReview` below is true for
 * ANY `request:review` grant, conditioned or not — entity-scoping (ADR-0015)
 * is enforced server-side per-request, so mere presence of the capability is
 * enough to decide whether the tab is worth showing at all. Before the
 * initial `/authz/me` fetch settles, `usePermissions()` synchronously returns
 * `EMPTY_PERMISSIONS` (`permissions: []`), so both tabs are briefly hidden
 * and then appear once resolved — the same "narrows down, never flashes
 * unfiltered" behavior as the shell's `Sidebar`. "My requests" is always
 * visible — every user with refund app access can create/list their own
 * requests regardless of `request:review`.
 *
 * This client-side hide is UX-only defense-in-depth, NOT the real gate: the
 * server-side 403 (refund-api's `authzMiddleware`, ADR-0014) and the
 * `PermissionDenied` screens on A1 (Review queue) / B1 (Monthly processing)
 * remain the actual enforcement — a deep link typed/followed by a
 * non-accounting user still lands on `PermissionDenied`, exactly as before.
 * Do not remove that handling on the strength of this nav change.
 */
export default function RefundShell() {
  const { permissions } = usePermissions()
  const canReview = permissions.some((permission) => permission.resource === 'request' && permission.action === 'review')

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
            {canReview && (
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
            )}
            {canReview && (
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
            )}
          </ul>
        </nav>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-8">
        <Outlet />
      </main>
    </div>
  )
}
