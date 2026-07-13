import { useEffect, useRef } from 'react'

/**
 * NotFoundPage — notify-ui's inner-router-wide not-found fallback (T14,
 * specs/005-notification-center/tasks.md), wired as `defaultNotFoundComponent`
 * in `createAppRouter` (../router.tsx). Mirrors
 * `admin-ui/src/pages/NotFoundPage.tsx` exactly (same technique, same
 * rationale): any unmatched path under notify-ui's basepath (e.g. a stale
 * bookmark or typo'd `/notify/whatever`) renders this instead of a blank
 * screen.
 *
 * A11y: the heading takes programmatic focus on mount
 * (`tabIndex={-1}; ref.current?.focus()`), the same technique design.md's
 * Accessibility section prescribes for entry-point pages reached by
 * navigation rather than in-page state change.
 */
export default function NotFoundPage() {
  const headingRef = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    headingRef.current?.focus()
  }, [])

  return (
    <section aria-labelledby="notify-not-found-heading" data-testid="notify-not-found-page">
      <div className="mx-auto max-w-2xl px-6 py-16" style={{ color: 'var(--text)' }}>
        <h2
          id="notify-not-found-heading"
          ref={headingRef}
          tabIndex={-1}
          className="text-lg font-semibold outline-none"
          style={{ fontFamily: 'var(--disp)' }}
        >
          Page not found
        </h2>
        <p className="mt-2 text-sm" style={{ color: 'var(--soft)' }}>
          This notification page doesn&rsquo;t exist.
        </p>
      </div>
    </section>
  )
}
