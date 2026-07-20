/**
 * PermissionDenied — in-place authorization-failure state (T22,
 * specs/004-auth-roles-permissions, design.md Screen E1: "Permission denied
 * (in-place, admin-ui)").
 *
 * Fires when an admin API call returns `403` *after* admin-ui is already
 * mounted — the F7 race case (AC-1.5): the shell's own layers (Sidebar
 * filtering + the route guard, T24/T25) are the primary defense, but a
 * session's admin access can be revoked while admin-ui is already open, and
 * the shell only revalidates on navigation. The next `/admin/*` call then
 * comes back `403`, and this component renders in place of the affected
 * screen's content — the surrounding chrome/nav stays fully mounted and
 * interactive, mirroring `shell/src/components/RemoteMount.tsx`'s "a failure
 * here only replaces the content subtree" philosophy, applied to an
 * authorization failure instead of a load failure.
 *
 * Deliberately has **no Retry action** (unlike `ErrorBanner`/`RemoteMount`'s
 * error fallback): a `403` is not a transient condition a retry could ever
 * resolve — it means this session's access has actually been revoked. The
 * only real recovery is navigating away, which the still-live shell chrome
 * already allows (design.md).
 *
 * A11y: the heading receives programmatic focus on mount (`tabIndex={-1}` +
 * `ref.current?.focus()`), the same technique `ShellLayout` already uses for
 * its skip-link target and `GuardrailDialog`/`ConfirmDeleteModal` use for
 * their default-focused action — so assistive tech announces the state
 * immediately instead of requiring the user to explore the page to discover
 * why the screen's content disappeared. The container is `role="alert"` so
 * the announcement fires the moment this component is inserted, even before
 * focus has had a chance to move (belt-and-braces with the focus move, not a
 * substitute for it — some AT/browser combinations don't always move focus
 * reliably on mount, e.g. inside nested async boundaries).
 *
 * Presentational: no required props, no data fetching — the screen that
 * detects the `403` (T17–T21's list/detail screens, and T11's Mileage Rates
 * screen) is responsible for catching it and rendering this component
 * instead of its normal content.
 *
 * `message` (T11, specs/009-mileage-rate, design.md "Gaps" — first
 * section-level 403 in this app): every screen up to this feature shares the
 * whole-tool 403 boundary, so the generic "You no longer have admin access"
 * copy has always been correct. The Mileage Rates screen's 403 is narrower —
 * a caller can be a perfectly valid admin-ui user who simply lacks
 * `rate:read`/`rate:manage` — and the generic copy would misleadingly
 * suggest total admin lockout. `message` overrides the body copy for that
 * case; omitted, every existing call site (`<PermissionDenied />`) is
 * unaffected.
 *
 * Styling note: colors/fonts use the shared stylesheet's plain CSS custom
 * properties (`var(--text)`, `var(--muted)`, `var(--disp)`, …) rather than
 * Tailwind's palette-specific utility classes — admin-ui's own build never
 * processes `shell/tokens.css`'s `@theme` block through Tailwind's compiler
 * (see `ConfirmDeleteModal.tsx`'s styling note). Generic layout/spacing/
 * type-scale Tailwind utilities are used freely.
 */

import { useEffect, useRef } from 'react'

export type PermissionDeniedProps = {
  /** Overrides the generic "If this is unexpected…" body copy. Omit for the default. */
  message?: string
}

export default function PermissionDenied({ message }: PermissionDeniedProps = {}) {
  const headingRef = useRef<HTMLHeadingElement>(null)

  // Focus the heading on mount — same technique ShellLayout uses for its
  // skip-link target (design.md "Accessibility — Permission-denied /
  // no-access states").
  useEffect(() => {
    headingRef.current?.focus()
  }, [])

  return (
    <div
      role="alert"
      data-testid="permission-denied"
      className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center"
    >
      <h2
        ref={headingRef}
        tabIndex={-1}
        data-testid="permission-denied-heading"
        className="text-lg font-bold focus:outline-none"
        style={{ fontFamily: 'var(--disp)', color: 'var(--text)' }}
      >
        You no longer have admin access.
      </h2>
      <p className="max-w-md text-sm leading-relaxed" style={{ color: 'var(--muted)' }}>
        {message ?? 'If this is unexpected, contact your administrator.'}
      </p>
    </div>
  )
}
