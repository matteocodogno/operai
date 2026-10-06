/**
 * SkeletonListRows — presentational loading skeleton (T25, specs/015-hardware-
 * inventory; design.md § Screens & states: "Loading: SkeletonListRows plus an
 * sr-only aria-live="polite" line"). Re-authored from refund-ui's component
 * (ADR-0006: no cross-remote imports) with the same props and markup:
 * placeholder rows with an animated pulse, a name column plus a trailing
 * actions column, `rows` defaulting to 3.
 *
 * The rows are aria-hidden because they carry no semantic content; the parent
 * screen provides the aria-live line that announces the loading state
 * (`strings.common.skeletonListRows.loadingLabel` is the default text).
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
