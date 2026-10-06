import { Link, Outlet, useMatchRoute } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { useInventoryCapabilities } from '../hooks/useInventoryCapabilities'
import { useScope } from '../hooks/useScope'
import { ApiError } from '../lib/api'
import { strings } from '../strings'
import ErrorBanner from './ErrorBanner'
import PermissionDenied from './PermissionDenied'
import SkeletonListRows from './SkeletonListRows'

/**
 * InventoryShell — inventory-ui's root layout (T28, specs/015-hardware-
 * inventory; design.md § T0 InventoryShell), passed to `createAppRouter` by
 * App.tsx as the router's root route component. Re-authored from refund-ui's
 * RefundShell: an h1, a labelled tab nav and the routed `<Outlet/>` — no suite
 * chrome (the shell owns it, ADR-0006) and no auth guard.
 *
 * Capability gating (AC-9.1, 9.3, 9.4, 9.6; UX only — the server's 403 is the
 * gate, AC-9.7). A tab the caller lacks the capability for is ABSENT from the
 * DOM, never disabled:
 *   - Assets: `asset:manage` or `ledger:manage` (the accountant reads assets);
 *   - Depreciation rules, Fiscal years: `ledger:manage`.
 * A deep link to a route the caller has no capability for renders
 * `PermissionDenied` in place of the page, so the tool's content never shows.
 *
 * Scope (plan.md `GET /scope`, design Resolutions G1/G11): once a route is
 * allowed, `useScope` loads the entities each capability covers and the layout
 * renders, in place of the page,
 *   - a skeleton with a polite "Loading inventory…" line while it loads;
 *   - `ErrorBanner` with Retry on failure — the 503 "authorization service
 *     unavailable" variant for a fail-closed `auth` outage (ADR-0014);
 *   - "No entity in your scope" when both lists are empty (a user with tool
 *     access whose grants are entity-conditioned with no entity). Plain page
 *     text, distinct from an empty list: nothing is wrong with the list.
 * The heading and tabs stay on screen in every state.
 */

const messageForScopeError = (error: unknown): string => {
  if (error instanceof ApiError) return error.detail ?? strings.errors.unknown
  return strings.errors.network
}

const TAB_CLASS =
  'inline-block border-b-2 border-transparent px-3 py-3 text-sm font-medium transition-colors hover:text-[var(--text)]'
const TAB_STYLE = { color: 'var(--soft)' }
const TAB_ACTIVE = { style: { color: 'var(--acc)', borderColor: 'var(--acc)' } }

export default function InventoryShell() {
  const { canManageAssets, canManageLedger } = useInventoryCapabilities()
  const matchRoute = useMatchRoute()

  const canReadAssets = canManageAssets || canManageLedger
  const onLedgerRoute = Boolean(matchRoute({ to: '/rules' })) || Boolean(matchRoute({ to: '/years', fuzzy: true }))
  const allowed = onLedgerRoute ? canManageLedger : canReadAssets

  const scope = useScope(allowed)

  const scopeStatus = scope.error instanceof ApiError ? scope.error.status : null

  let content: ReactNode
  if (!allowed || scopeStatus === 403) {
    content = <PermissionDenied />
  } else if (scope.status === 'error') {
    content =
      scopeStatus === 503 ? (
        <ErrorBanner variant="authUnavailable" onRetry={scope.retry} />
      ) : (
        <ErrorBanner message={messageForScopeError(scope.error)} onRetry={scope.retry} />
      )
  } else if (scope.status !== 'ready') {
    content = (
      <div>
        <p role="status" aria-live="polite" className="sr-only">
          {strings.nav.loading}
        </p>
        <SkeletonListRows />
      </div>
    )
  } else if (scope.isEmpty) {
    content = (
      <section aria-labelledby="inventory-scope-empty-heading" data-testid="inventory-scope-empty">
        <h2 id="inventory-scope-empty-heading" className="text-lg font-semibold" style={{ fontFamily: 'var(--disp)' }}>
          {strings.nav.scopeEmpty.heading}
        </h2>
        <p className="mt-2 text-sm" style={{ color: 'var(--soft)' }}>
          {strings.nav.scopeEmpty.body}
        </p>
      </section>
    )
  } else {
    content = <Outlet />
  }

  return (
    <div className="min-h-screen" style={{ color: 'var(--text)', fontFamily: 'var(--body)' }}>
      <header style={{ borderBottom: '1px solid var(--rule)', backgroundColor: 'var(--ink-soft)' }}>
        <div className="mx-auto max-w-5xl px-6 py-4">
          <h1 className="text-xl font-bold" style={{ fontFamily: 'var(--disp)' }}>
            {strings.nav.heading}
          </h1>
        </div>
        <nav aria-label={strings.nav.landmarkLabel}>
          <ul className="mx-auto flex max-w-5xl gap-1 px-6">
            {canReadAssets && (
              <li>
                <Link to="/assets" className={TAB_CLASS} style={TAB_STYLE} activeProps={TAB_ACTIVE}>
                  {strings.nav.assets}
                </Link>
              </li>
            )}
            {canManageLedger && (
              <li>
                <Link to="/rules" className={TAB_CLASS} style={TAB_STYLE} activeProps={TAB_ACTIVE}>
                  {strings.nav.rules}
                </Link>
              </li>
            )}
            {canManageLedger && (
              <li>
                <Link to="/years" className={TAB_CLASS} style={TAB_STYLE} activeProps={TAB_ACTIVE}>
                  {strings.nav.years}
                </Link>
              </li>
            )}
          </ul>
        </nav>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-8">{content}</main>
    </div>
  )
}
