import { useEffect, useRef } from 'react'
import { strings } from '../strings'

/**
 * NotFoundPage — refund-ui's inner-router-wide not-found fallback (T14,
 * specs/007-refund-service/tasks.md's router foundation). Wired as
 * `defaultNotFoundComponent` in `createAppRouter` (../router.tsx), so any
 * unmatched path under refund-ui's basepath renders this instead of a blank
 * screen — mirrors `admin-ui/src/pages/NotFoundPage.tsx` exactly, including
 * its focus-on-mount a11y technique (design.md Accessibility: "Focus
 * management on state transitions … the same tabIndex={-1} +
 * ref.current?.focus() technique").
 *
 * Distinct from Screen R2/A2's own record-level "NF" (not-found) render
 * variant (design.md — a request that doesn't exist or isn't owned/in-scope,
 * a 404 from the API): this is the ROUTER-level fallback for a path that
 * matches none of refund-ui's five routes at all (e.g. a typo'd URL).
 */
export default function NotFoundPage() {
  const headingRef = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    headingRef.current?.focus()
  }, [])

  return (
    <section aria-labelledby="refund-not-found-heading" data-testid="refund-not-found-page">
      <h2
        id="refund-not-found-heading"
        ref={headingRef}
        tabIndex={-1}
        className="text-lg font-semibold outline-none"
        style={{ fontFamily: 'var(--disp)' }}
      >
        {strings.pages.notFound.heading}
      </h2>
      <p className="mt-2 text-sm" style={{ color: 'var(--soft)' }}>
        {strings.pages.notFound.body}
      </p>
    </section>
  )
}
