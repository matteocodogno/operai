import { Link, Outlet } from '@tanstack/react-router'
import { usePermissions } from 'shell/session'
import { TabNav, ToolLayout, tabLinkClassName } from '@operai/ui'
import { strings } from '../strings'

/**
 * MeetingsShell — `./App`'s root layout: the tool title (h1), its section tabs and the routed
 * page (ToolLayout `default` width, design.md § Conventions › Frame). No suite chrome and no
 * auth guard: the shell owns both and mounts this remote only for `meetings:access` holders
 * (ADR-0006, ADR-0007).
 *
 * Meetings and Templates are open to every holder; the Erase tab shows only for a
 * `meeting:erase` holder. That is a UI hint read from the shell's permission snapshot (plan G5):
 * the server decides, and the erase page itself renders PermissionDenied on a 403.
 */
export default function MeetingsShell() {
  const { permissions } = usePermissions()
  const canErase = permissions.some((permission) => permission.resource === 'meeting' && permission.action === 'erase')

  return (
    <ToolLayout
      title={strings.nav.heading}
      testId="meetings-shell"
      nav={
        <TabNav label={strings.nav.landmarkLabel}>
          <Link to="/" activeOptions={{ exact: true }} className={tabLinkClassName}>
            {strings.nav.tabs.meetings}
          </Link>
          <Link to="/templates" className={tabLinkClassName}>
            {strings.nav.tabs.templates}
          </Link>
          {canErase && (
            <Link to="/erase" className={tabLinkClassName} data-testid="meetings-nav-erase">
              {strings.nav.tabs.erase}
            </Link>
          )}
        </TabNav>
      }
    >
      <Outlet />
    </ToolLayout>
  )
}
