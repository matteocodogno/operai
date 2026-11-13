import type { ReactNode } from 'react'
import { StatePanel } from '@operai/ui'
import { strings } from '../strings'

export type PermissionDeniedProps = {
  /** The heading; defaults to the generic "You do not have access to this". */
  title?: string
  /** The body; defaults to the generic line. */
  message?: string
  /** One way forward (a link back to My hours), at most. */
  action?: ReactNode
  /** 2 when it replaces a whole page (no PageHeader above it), 3 under a page's own header. */
  headingLevel?: 2 | 3
}

/**
 * PermissionDenied — the in-place authorization-failure state: a `StatePanel` that is an alert and
 * takes focus on its heading (INC-30), so assistive technology announces why the page's content
 * is not there. Replaces the content of the screen that detected the refusal; the frame (title,
 * tabs) stays. No retry: a refusal is not transient. Used by Everyone's hours for a person who does
 * not hold `time-entry:read-all` (a typed URL, a grant revoked meanwhile; AC-4.2) with its own
 * words and a link back to My hours.
 */
export default function PermissionDenied({ title, message, action, headingLevel = 2 }: PermissionDeniedProps = {}) {
  return (
    <StatePanel
      role="alert"
      focusOnMount
      headingLevel={headingLevel}
      title={title ?? strings.common.permissionDenied.heading}
      action={action}
      testId="hours-permission-denied"
      headingTestId="hours-permission-denied-heading"
    >
      {message ?? strings.common.permissionDenied.body}
    </StatePanel>
  )
}
