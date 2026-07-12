/**
 * SkeletonListRows — presentational loading skeleton for admin-ui's list
 * screens (Roles/Departments/Users/Audit — T15, specs/004-auth-roles-permissions).
 *
 * Ported pattern from `estimai-ui/src/components/SkeletonListRows.tsx`
 * (same shape: placeholder rows with an animated pulse, a name/date-like
 * column plus a trailing action-buttons column) — admin-ui cannot import
 * across the Module Federation boundary (ADR-0006), so this is a
 * near-verbatim re-authoring. Generalised with a `rows` prop (defaults to 3,
 * matching the source) since every admin-ui list uses this same shape
 * regardless of row count.
 *
 * The rows are aria-hidden because they carry no semantic content; the
 * parent is responsible for providing an aria-live region that announces
 * the loading state to assistive technologies (mirrors EstimatesPage's
 * `<p className="sr-only" aria-live="polite">Loading …</p>` convention).
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
              <div
                key={j}
                className="h-6 w-10 rounded"
                style={{ backgroundColor: 'var(--ink-mid)', opacity: 0.4 }}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
