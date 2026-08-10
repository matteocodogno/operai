import { useEffect, useRef } from 'react'

/**
 * NotFoundPage — admin-ui's inner-router-wide not-found fallback (T14,
 * specs/004-auth-roles-permissions/tasks.md's "not-found route"). Wired as
 * `defaultNotFoundComponent` in `createAppRouter` (../router.tsx), so any
 * unmatched path under admin-ui's basepath (e.g. a stale bookmark or
 * typo'd `/admin/whatever`) renders this instead of a blank screen — no
 * separate catch-all route needed, TanStack Router falls back to this
 * component automatically for any path none of the four section routes (or
 * the index redirect) match.
 *
 * A11y: the heading takes programmatic focus on mount
 * (`tabIndex={-1}; ref.current?.focus()`), the same technique design.md's
 * Accessibility section prescribes for Screens E1/S1 ("the heading
 * receives programmatic focus on mount … so assistive tech announces the
 * state immediately") — applied here too since a not-found admin route is
 * the same class of "nothing else on this screen to explore" state, even
 * though it isn't one of those two named screens itself. The chrome around
 * it (AdminShell's heading + SectionNav) stays mounted, so the four real
 * sections remain one click away.
 */
export default function NotFoundPage() {
  const headingRef = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    headingRef.current?.focus()
  }, [])

  return (
    <section aria-labelledby="admin-not-found-heading" data-testid="admin-not-found-page">
      <h2
        id="admin-not-found-heading"
        ref={headingRef}
        tabIndex={-1}
        className="text-lg font-semibold outline-none"
        style={{ fontFamily: 'var(--disp)' }}
      >
        Page not found
      </h2>
      <p className="mt-2 text-sm" style={{ color: 'var(--soft)' }}>
        This admin section doesn&rsquo;t exist. Use the navigation above to pick Roles, Departments, Users, or Audit.
      </p>
    </section>
  )
}
