import { Outlet } from '@tanstack/react-router'
import { ToolLayout } from '@operai/ui'
import { strings } from '../strings'

/**
 * MyMeetingsShell — `./MyMeetings`' root layout: the "My meetings" h1 and the routed page, with
 * no TabNav (the `MyDevices` precedent, ADR-0045). The entry is UNGATED: every signed-in user
 * reaches it, so it asks no capability hook and calls no scope route; each control is decided
 * by the meeting's own `can` flags.
 */
export default function MyMeetingsShell() {
  return (
    <ToolLayout title={strings.nav.myHeading} testId="my-meetings-shell">
      <Outlet />
    </ToolLayout>
  )
}
