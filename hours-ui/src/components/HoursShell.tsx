import { Link, Outlet } from '@tanstack/react-router'
import { TabNav, ToolLayout, tabLinkClassName } from '@operai/ui'
import { useHoursAccess } from '../lib/permissions'
import { strings } from '../strings'

/**
 * HoursShell — hours-ui's root layout: the tool title (h1) and the routed page. No suite chrome and no auth guard:
 * the shell owns both (ADR 20260709-suite-frontend-module-federation), and mounts this remote
 * for every signed-in user, whatever their grants (AC-5.1, ADR 20261112-hours-ui-ungated-remote).
 *
 * The column is ToolLayout's `wide` — the full width, the EstimAI workspace's — on every route and every view: My hours
 * (the table view in either period, and the List), Everyone's hours, Settings and the not-found panel (C1, D16, AC-5.33,
 * specs/20261116-record-hours-in-place T10, T19). A table of a week or a month wants the room, and a tool whose pages are
 * different widths jumps when the tabs or the view change, so none is: it reads neither the route nor the address.
 *
 * The tabs exist only for a holder of `time-entry:read-all` or `time-list:manage`: for everyone else there
 * is just My hours, so there is no TabNav at all (one tab is noise; the `MyDevices` precedent, ADR
 * 20261006-ungated-second-federated-entry-of-a-gated-remote). My hours comes first, then Everyone's hours
 * (read-all only), then Settings (the time lists; manage only; T43, D51, the refund-ui Settings tab shape).
 * Each is out of the DOM — never disabled — while the permissions resolve and for a non-holder; it is a
 * UX convenience, and the server is the gate (ADR 20261108-estimai-oversight-permission-amends-0036), so
 * `/all` or `/settings` typed by hand reaches the page, which then refuses (the Settings page asks nothing
 * without the permission, and hours-api enforces it on every write).
 *
 * A tab is the PAGE, not the whole address: both pages keep their filters in the URL's search params
 * (`?period=…&person=…`), and a link is "active" only when the search matches too unless `includeSearch` is
 * off — without it the current tab lost its `aria-current` as soon as a filter was set.
 */
export default function HoursShell() {
  const { canReadAll, canManageLists } = useHoursAccess()

  return (
    <ToolLayout
      title={strings.common.title}
      width="wide"
      testId="hours-shell"
      nav={
        canReadAll || canManageLists ? (
          <TabNav label={strings.common.nav.landmarkLabel}>
            <Link to="/" className={tabLinkClassName} activeOptions={{ exact: true, includeSearch: false }}>
              {strings.common.nav.myHours}
            </Link>
            {canReadAll && (
              <Link to="/all" className={tabLinkClassName} activeOptions={{ exact: true, includeSearch: false }}>
                {strings.common.nav.everyone}
              </Link>
            )}
            {canManageLists && (
              <Link to="/settings" className={tabLinkClassName} activeOptions={{ exact: true, includeSearch: false }}>
                {strings.common.nav.settings}
              </Link>
            )}
          </TabNav>
        ) : undefined
      }
    >
      <Outlet />
    </ToolLayout>
  )
}
