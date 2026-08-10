/**
 * SkeletonListRows — presentational loading skeleton for the EstimatesPage list.
 *
 * Renders three placeholder rows with an animated pulse, matching the
 * dimensions of the real estimate list rows (name line + date line + action
 * buttons area). The rows are aria-hidden because they carry no semantic
 * content; the parent is responsible for providing an aria-live region that
 * announces the loading state to assistive technologies.
 *
 * Design tokens used: bg-ink-mid (row background), rounded-md border-rule
 * (card shape matching the real rows).
 */
export default function SkeletonListRows() {
  return (
    <div className="flex flex-col gap-2" aria-hidden="true" data-testid="skeleton-list-rows">
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="flex items-center gap-4 px-4 py-3 rounded-md border border-rule bg-ink-soft animate-pulse"
        >
          {/* Name + date column */}
          <div className="flex-1 flex flex-col gap-1.5">
            <div className="h-3.5 w-1/2 rounded bg-ink-mid opacity-60" />
            <div className="h-2.5 w-1/4 rounded bg-ink-mid opacity-40" />
          </div>

          {/* Action buttons placeholder */}
          <div className="flex items-center gap-1 shrink-0">
            {[0, 1, 2, 3].map((j) => (
              <div key={j} className="h-6 w-10 rounded bg-ink-mid opacity-40" />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
