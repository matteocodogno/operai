import { Banner, Button } from '@operai/ui'
import { useState } from 'react'
import { hostNoticeFailed } from '../../lib/hostLinks'
import { errorMessage } from '../../lib/errors'
import { retryHostNotice } from '../../lib/meetingsApi'
import type { HostInfo, Meeting } from '../../lib/types'
import { strings } from '../../strings'

export type HostNoticeBannerProps = {
  meeting: Meeting
  /** The host's registration: its `labels.<lang>.noticeFailed` sentence is the banner text (plan G7). */
  hostInfo: HostInfo | null
  onChanged: (meeting: Meeting) => void
}

/**
 * HostNoticeBanner — the host did not accept the last notice about this meeting (F11; AC-11.9,
 * AC-14.8). Creator only, never blocking: a warning at the top of the page, not dismissible, that
 * stays until a retry gets through. For a failed `linked` notice the text is the host's own
 * sentence, whole, in the UI language, so no host wording lives in meetings-ui (plan G7); any other
 * event, or a host whose registration could not be read, gets the generic sentence. Try again
 * (`POST host-notice/retry`) is offered only while `can.retryHostNotice`, so a frozen meeting says
 * what failed but cannot retry (AC-14.10). The page owns the confirmation: the answer goes to
 * `onChanged`, and a delivered notice arrives with `hostNotice: null`.
 */
export default function HostNoticeBanner({ meeting, hostInfo, onChanged }: HostNoticeBannerProps) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const notice = meeting.hostNotice
  if (notice === null) return null

  const sentence =
    (notice.event === 'linked' && hostInfo !== null
      ? hostNoticeFailed([hostInfo], hostInfo.app, hostInfo.entityType)
      : null) ?? strings.meeting.hostNotice.changedFailed

  const retry = async () => {
    setBusy(true)
    setError(null)
    try {
      onChanged(await retryHostNotice(meeting.id))
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Banner
      tone="warning"
      dismissible={false}
      data-testid="meetings-host-notice"
      actions={
        meeting.can.retryHostNotice ? (
          <Button
            size="sm"
            variant="secondary"
            busy={busy}
            onClick={() => void retry()}
            data-testid="meetings-host-notice-retry"
          >
            {strings.meeting.hostNotice.retry}
          </Button>
        ) : undefined
      }
    >
      <p>{sentence}</p>
      {error !== null && <p className="mt-1">{error}</p>}
    </Banner>
  )
}
