import { useEffect, useRef } from 'react'
import { strings } from '../strings'

/**
 * NotFoundPage — inventory-ui's router-level not-found fallback (T24), wired as
 * `defaultNotFoundComponent` in `createAppRouter` (../router.tsx). Distinct
 * from a record-level "not found" (an asset or fiscal year the API 404s on,
 * design.md error catalogue): this is a path that matches no route at all.
 * Focus moves to the heading on mount (design.md Accessibility), the same
 * technique refund-ui/admin-ui use.
 */
export default function NotFoundPage() {
  const headingRef = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    headingRef.current?.focus()
  }, [])

  return (
    <section aria-labelledby="inventory-not-found-heading" data-testid="inventory-not-found-page">
      <h2
        id="inventory-not-found-heading"
        ref={headingRef}
        tabIndex={-1}
        className="text-lg font-semibold outline-none"
        style={{ fontFamily: 'var(--disp)' }}
      >
        {strings.notFound.heading}
      </h2>
      <p className="mt-2 text-sm" style={{ color: 'var(--soft)' }}>
        {strings.notFound.body}
      </p>
    </section>
  )
}
