import { StatePanel } from '@operai/ui'
import { strings } from '../strings'

/** The 403 state: replaces the page, takes focus, offers no retry (not transient). */
export default function PermissionDenied() {
  return (
    <StatePanel
      role="alert"
      focusOnMount
      headingLevel={2}
      title={strings.common.permissionDenied.heading}
      testId="meetings-permission-denied"
      headingTestId="meetings-permission-denied-heading"
    >
      {strings.common.permissionDenied.body}
    </StatePanel>
  )
}
