import { Banner, Button, Card, Spinner, StatePanel } from '@operai/ui'
import { useState } from 'react'
import { hasActiveRecordingSession } from '../../capture/session'
import { errorMessage } from '../../lib/errors'
import { retryProcessing } from '../../lib/meetingsApi'
import type { Meeting } from '../../lib/types'
import { strings } from '../../strings'
import ConsentCard from './ConsentCard'
import InterruptedPanel from './InterruptedPanel'
import RecordingPanel from './RecordingPanel'
import TextCard from './TextCard'
import UploadCard from './UploadCard'

export type StatusPanelsProps = {
  meeting: Meeting
  /** The server's fresh view after a write, so the page replaces its copy. */
  onChanged: (meeting: Meeting) => void
  /** Reads the meeting again (after a refusal that says the state moved on). */
  onRefresh: () => void
}

function Processing({ meeting }: { meeting: Meeting }) {
  const t = strings.meeting.panels.processing
  const stage = meeting.stage === null ? t.stages.queued : t.stages[meeting.stage]
  return (
    <Card title={t.title} data-testid="meetings-processing-panel">
      <div role="status" className="flex items-center gap-3 text-sm">
        <Spinner />
        <span>{stage}</span>
      </div>
      <p className="mt-3 text-sm text-soft">{t.leaveNote}</p>
    </Card>
  )
}

type Reason = keyof typeof strings.meeting.panels.failed.reasons

const isKnownReason = (code: string): code is Reason =>
  Object.prototype.hasOwnProperty.call(strings.meeting.panels.failed.reasons, code)

/** Failed (F9): the plain reason, and Try again while `can.retryProcessing`; after audio deletion nothing can be retried and the page says why. */
function Failed({ meeting, onChanged, onRefresh }: StatusPanelsProps) {
  const t = strings.meeting.panels.failed
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const code = meeting.failure?.code
  const reason = code !== undefined && isKnownReason(code) ? t.reasons[code] : t.unknownReason

  const retry = async () => {
    setBusy(true)
    setError(null)
    try {
      onChanged(await retryProcessing(meeting.id))
    } catch (failure) {
      setError(errorMessage(failure))
      // 409 not_failed / audio_deleted: the state moved on, so catch the page's flags up.
      onRefresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Banner
      tone="danger"
      title={t.title}
      data-testid="meetings-failed-panel"
      actions={
        meeting.can.retryProcessing ? (
          <Button
            size="sm"
            variant="primary"
            busy={busy}
            onClick={() => void retry()}
            data-testid="meetings-failed-retry"
          >
            {t.retry}
          </Button>
        ) : undefined
      }
    >
      <p>{reason}</p>
      {meeting.audio.state === 'deleted' && <p className="mt-1">{t.audioDeleted}</p>}
      {error !== null && (
        <p role="alert" className="form-error mt-1">
          {error}
        </p>
      )}
    </Banner>
  )
}

/**
 * StatusPanels — the ONE panel the derived status calls for (S3a); nothing for `ready`, whose
 * content is the tabs. What the caller may do comes from the meeting's `can` flags, never from a
 * role check: a participant, a frozen meeting or an unresolved capability all arrive with
 * `can.*` false and get the read-only panel. Capture controls (the recording panel, the upload
 * and text cards) appear only once the consent card has been satisfied (AC-2.1).
 */
export default function StatusPanels({ meeting, onChanged, onRefresh }: StatusPanelsProps) {
  const controls = meeting.can.capture || meeting.can.edit

  // While THIS tab captures or is still saving the meeting, the recording panel stays up whatever the
  // server derives: after a long offline spell it says `interrupted`, and swapping the panel out would
  // unmount it and cut a recording that is still running.
  if (hasActiveRecordingSession(meeting.id)) {
    return <RecordingPanel meeting={meeting} onChanged={onChanged} />
  }

  switch (meeting.status) {
    case 'draft': {
      if (!meeting.can.capture) {
        return (
          <StatePanel title={strings.meeting.panels.draftEmpty.title} testId="meetings-draft-empty">
            {strings.meeting.panels.draftEmpty.body}
          </StatePanel>
        )
      }
      if (meeting.source === 'text') return <TextCard meeting={meeting} onChanged={onChanged} />
      const attested = meeting.consent !== null
      return (
        <>
          <ConsentCard meeting={meeting} onChanged={onChanged} />
          {attested && meeting.source === 'recorded' && <RecordingPanel meeting={meeting} onChanged={onChanged} />}
          {attested && meeting.source === 'uploaded' && <UploadCard meeting={meeting} onChanged={onChanged} />}
        </>
      )
    }
    case 'recording':
      return controls ? (
        <RecordingPanel meeting={meeting} onChanged={onChanged} />
      ) : (
        <StatePanel
          title={strings.meeting.panels.recordingInProgress.title}
          role="status"
          testId="meetings-recording-in-progress"
        >
          {strings.meeting.panels.recordingInProgress.body}
        </StatePanel>
      )
    case 'interrupted':
      return <InterruptedPanel meeting={meeting} onChanged={onChanged} />
    case 'processing':
      return <Processing meeting={meeting} />
    case 'failed':
      return <Failed meeting={meeting} onChanged={onChanged} onRefresh={onRefresh} />
    case 'ready':
      return null
  }
}
