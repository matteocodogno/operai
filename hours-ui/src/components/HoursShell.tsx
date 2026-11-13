import { Link, Outlet } from '@tanstack/react-router'
import { TabNav, ToolLayout, tabLinkClassName } from '@operai/ui'
import { useHoursAccess } from '../lib/permissions'
import { strings } from '../strings'

/**
 * HoursShell — hours-ui's root layout: the tool title (h1) and the routed page (ToolLayout `default`
 * width). No suite chrome and no auth guard: the shell owns both (ADR-0006), and mounts this remote
 * for every signed-in user, whatever their grants (AC-5.1, ADR-0090).
 *
 * The tabs exist only for a holder of `time-entry:read-all`: for everyone else there is just My
 * hours, so there is no TabNav at all (one tab is noise; the `MyDevices` precedent, ADR-0045). The
 * tab is out of the DOM — never disabled — while the permissions resolve and for a non-holder; it is a
 * UX convenience, and the server is the gate (ADR-0075), so `/all` typed by hand reaches the
 * page, which the server then refuses.
 */
export default function HoursShell() {
  const { canReadAll } = useHoursAccess()

  return (
    <ToolLayout
      title={strings.common.title}
      testId="hours-shell"
      nav={
        canReadAll ? (
          <TabNav label={strings.common.nav.landmarkLabel}>
            <Link to="/" className={tabLinkClassName} activeOptions={{ exact: true }}>
              {strings.common.nav.myHours}
            </Link>
            <Link to="/all" className={tabLinkClassName} activeOptions={{ exact: true }}>
              {strings.common.nav.everyone}
            </Link>
          </TabNav>
        ) : undefined
      }
    >
      <Outlet />
    </ToolLayout>
  )
}
