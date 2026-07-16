/**
 * PermissionDenied — in-place authorization-failure state (T15,
 * specs/007-refund-service/tasks.md, design.md Screen R1: "an employee whose
 * refund:access/request:read grant was revoked … sees PermissionDenied
 * (ported, unchanged)"; Screen A1: "a user without request:review at all …
 * sees PermissionDenied (ported, unchanged) in place of the table, no
 * Retry"; Component inventory: "PermissionDenied — Reuse (ported pattern) —
 * admin-ui/src/components/PermissionDenied.tsx").
 *
 * Ported pattern: `refund-ui` cannot import admin-ui's source across the
 * Module Federation boundary (ADR-0006), so this is a near-verbatim
 * re-authoring of `admin-ui/src/components/PermissionDenied.tsx` — same
 * no-props, no-Retry, focus-on-mount contract.
 *
 * Fires when a `403` comes back from `GET /requests` (Screen R1) or
 * `GET /review/requests` (Screen A1) — refund access is never automatic
 * (design.md Constraints), so this is the expected first-run state for most
 * employees on Screen A1, and the recovery state for anyone whose
 * `refund:access`/`request:read`/`request:review` grant is revoked while
 * refund-ui is already open. Deliberately has **no Retry action** (unlike
 * `ErrorBanner`): a `403` is not transient — the only real recovery is
 * navigating away, which the still-live shell chrome already allows.
 *
 * A11y: the heading receives programmatic focus on mount (`tabIndex={-1}` +
 * `ref.current?.focus()`), the same technique `GuardrailDialog`/
 * `ConfirmDeleteModal` use for their own default-focused action — so
 * assistive tech announces the state immediately instead of requiring the
 * user to explore the page to discover why the screen's content disappeared.
 * The container is `role="alert"` so the announcement fires the moment this
 * component is inserted, even before focus has had a chance to move.
 *
 * Presentational: no props, no data fetching — the screen that detects the
 * `403` (T16/T18) is responsible for catching it and rendering this
 * component instead of its normal content.
 *
 * Copy sourced from `strings.ts` (T14/T15 convention: no hardcoded UI
 * strings) — refund-specific wording ("refund access", not "admin access").
 */

import { useEffect, useRef } from 'react'
import { strings } from '../strings'

export default function PermissionDenied() {
  const headingRef = useRef<HTMLHeadingElement>(null)

  // Focus the heading on mount.
  useEffect(() => {
    headingRef.current?.focus()
  }, [])

  return (
    <div role="alert" data-testid="permission-denied" className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center">
      <h2
        ref={headingRef}
        tabIndex={-1}
        data-testid="permission-denied-heading"
        className="text-lg font-bold focus:outline-none"
        style={{ fontFamily: 'var(--disp)', color: 'var(--text)' }}
      >
        {strings.components.permissionDenied.heading}
      </h2>
      <p className="max-w-md text-sm leading-relaxed" style={{ color: 'var(--muted)' }}>
        {strings.components.permissionDenied.body}
      </p>
    </div>
  )
}
