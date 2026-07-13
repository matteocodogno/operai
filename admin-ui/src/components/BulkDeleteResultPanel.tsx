/**
 * BulkDeleteResultPanel — persistent bulk soft-delete result report (T11,
 * specs/006-user-invitations, design.md Panel N3: "Bulk delete result — no
 * precedent in-repo").
 *
 * Renders directly above the Users list table after a
 * `POST /admin/users/delete` response, and stays visible until the admin
 * explicitly dismisses it or navigates away — critically, this is NEVER a
 * toast/auto-timeout notification (AC-6.3: "never a silent partial result
 * indistinguishable from full success"). `role="status"` (polite, not
 * assertive — the admin caused this, it isn't an unprompted interruption).
 *
 * Renders a one-line summary ("Deleted 2 of 3 selected users.") plus a real
 * `<ul>` of SKIPPED users only (successes aren't re-listed — the table
 * itself, re-fetched underneath, already shows who's gone). Each `<li>`
 * carries the user's own identifying email and the server's own `reason`
 * string VERBATIM — never re-derived or paraphrased client-side, so the UI
 * can never drift from what the API actually decided (design.md: "copy
 * sourced from the response, not re-derived client-side").
 *
 * Presentational: all data arrives via props; the caller (../pages/UsersPage.tsx)
 * owns when this mounts/unmounts and what happens on dismiss.
 *
 * A11y: the dismiss "×" mirrors `ErrorBanner.tsx`'s existing
 * `aria-label="Dismiss"` affordance — the ONLY way this panel disappears
 * before the admin navigates away (design.md).
 */

export type BulkDeleteSkipItem = {
  userId: string
  /** The skipped user's identifying label (name or email) — resolved from the
   *  selection snapshot at confirm time, since the server's `skipped` entries
   *  carry only `{ userId, reason }` (plan.md), no identifying info. */
  label: string
  /** The server's own reason string, verbatim (e.g. "last remaining admin"). */
  reason: string
}

export type BulkDeleteResultPanelProps = {
  /** Number of users actually deleted. */
  deletedCount: number
  /** Total number of users the admin attempted to delete (deleted + skipped). */
  totalCount: number
  /** Skipped users, each with the server's own verbatim reason. */
  skipped: BulkDeleteSkipItem[]
  /** Called when the admin dismisses the panel (clicks "×"). */
  onDismiss: () => void
}

export default function BulkDeleteResultPanel({
  deletedCount,
  totalCount,
  skipped,
  onDismiss,
}: BulkDeleteResultPanelProps) {
  return (
    <div
      role="status"
      data-testid="bulk-delete-result-panel"
      className="mb-4 p-4 border rounded-md"
      style={{ borderColor: 'var(--rule)', backgroundColor: 'var(--ink-soft)' }}
    >
      <div className="flex items-center justify-between gap-4">
        <h3 className="text-sm font-semibold" style={{ color: 'var(--text)' }}>
          Bulk delete result
        </h3>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          data-testid="bulk-delete-result-dismiss"
          className="text-base leading-none transition-opacity hover:opacity-80"
          style={{ color: 'var(--muted)' }}
        >
          ×
        </button>
      </div>

      <p className="mt-1 text-sm" style={{ color: 'var(--text)' }} data-testid="bulk-delete-result-summary">
        Deleted {deletedCount} of {totalCount} selected {totalCount === 1 ? 'user' : 'users'}.
      </p>

      {skipped.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1" data-testid="bulk-delete-result-skipped-list">
          {skipped.map((item) => (
            <li
              key={item.userId}
              className="text-sm"
              style={{ color: 'var(--org)' }}
              data-testid={`bulk-delete-result-skipped-${item.userId}`}
            >
              {item.label} — skipped: {item.reason}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
