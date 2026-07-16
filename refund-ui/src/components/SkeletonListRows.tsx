/**
 * SkeletonListRows — presentational loading skeleton for refund-ui's list
 * screens (R1 "My requests", A1 "Review queue" — T15, specs/007-refund-service/
 * tasks.md, design.md Component inventory: "SkeletonListRows — Reuse (ported
 * pattern) — admin-ui/src/components/SkeletonListRows.tsx").
 *
 * Ported pattern: `refund-ui` cannot import admin-ui's source across the
 * Module Federation boundary (ADR-0006), so this is a near-verbatim
 * re-authoring of `admin-ui/src/components/SkeletonListRows.tsx` (itself
 * ported from `estimai-ui`) — same shape: placeholder rows with an animated
 * pulse, a name/date-like column plus a trailing action-buttons column.
 * Generalised with a `rows` prop (defaults to 3, matching the source) since
 * both refund-ui list screens use this same shape regardless of row count.
 *
 * The rows are aria-hidden because they carry no semantic content; the
 * parent screen is responsible for providing an aria-live region that
 * announces the loading state to assistive technologies (design.md Screen
 * R1: 'the same aria-live="polite" "Loading your requests" sr-only
 * announcement EstimatesPage.tsx uses').
 */

export type SkeletonListRowsProps = {
  /** Number of placeholder rows to render. Defaults to 3. */
  rows?: number
}

export default function SkeletonListRows({ rows = 3 }: SkeletonListRowsProps) {
  return (
    <div className="flex flex-col gap-2" aria-hidden="true" data-testid="skeleton-list-rows">
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          className="flex items-center gap-4 px-4 py-3 rounded-md border animate-pulse"
          style={{ borderColor: 'var(--rule)', backgroundColor: 'var(--ink-soft)' }}
        >
          {/* Name + meta column */}
          <div className="flex-1 flex flex-col gap-1.5">
            <div className="h-3.5 w-1/2 rounded" style={{ backgroundColor: 'var(--ink-mid)', opacity: 0.6 }} />
            <div className="h-2.5 w-1/4 rounded" style={{ backgroundColor: 'var(--ink-mid)', opacity: 0.4 }} />
          </div>

          {/* Action buttons placeholder */}
          <div className="flex items-center gap-1 shrink-0">
            {[0, 1, 2, 3].map((j) => (
              <div key={j} className="h-6 w-10 rounded" style={{ backgroundColor: 'var(--ink-mid)', opacity: 0.4 }} />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
