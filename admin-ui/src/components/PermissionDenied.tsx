/**
 * PermissionDenied — in-place authorization-failure state (T22,
 * specs/20260713-auth-roles-permissions, design.md Screen E1: "Permission denied
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
 * A11y: the library `StatePanel` (`role="alert"`, `focusOnMount`, INC-30)
 * moves focus to the heading on mount, so assistive tech announces the state
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
 * `message` (T11, specs/20260720-mileage-rate, design.md "Gaps" — first
 * section-level 403 in this app): every screen up to this feature shares the
 * whole-tool 403 boundary, so the generic "You no longer have admin access"
 * copy has always been correct. A section-level 403 is narrower (the Mileage
 * Rates screen's, until it moved to refund-ui on 2026-11-13), where the
 * generic copy would misleadingly suggest total admin lockout. `message` overrides the body copy for that
 * case; omitted, every existing call site (`<PermissionDenied />`) is
 * unaffected.
 *
 */

import { StatePanel } from '@operai/ui'
import { strings } from '../strings'

export type PermissionDeniedProps = {
  /** Overrides the generic "If this is unexpected…" body copy. Omit for the default. */
  message?: string
  /** 2 when it replaces a whole page (no PageHeader above it), 3 under a page's own header. */
  headingLevel?: 2 | 3
}

export default function PermissionDenied({ message, headingLevel = 2 }: PermissionDeniedProps = {}) {
  return (
    <StatePanel
      role="alert"
      focusOnMount
      headingLevel={headingLevel}
      title={strings.common.permissionDenied.title}
      testId="permission-denied"
      headingTestId="permission-denied-heading"
    >
      {message ?? strings.common.permissionDenied.body}
    </StatePanel>
  )
}
