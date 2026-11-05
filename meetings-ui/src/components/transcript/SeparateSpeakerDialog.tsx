import { ConfirmDialog } from '@operai/ui'
import { useState } from 'react'
import { ApiError } from '../../lib/api'
import { errorMessage } from '../../lib/errors'
import { separateSpeaker } from '../../lib/meetingsApi'
import type { Speaker } from '../../lib/types'
import { strings } from '../../strings'

export type SeparateSpeakerDialogProps = {
  meetingId: string
  speaker: Speaker
  /** What the speaker is called now. */
  name: string
  /** The server separated the label: the transcript's whole speaker list now. */
  onSeparated: (speakers: Speaker[]) => void
  /** The label was already separate, or the transcript is no longer ready: the page is out of date. */
  onStale: () => void
  onClose: () => void
}

/**
 * "Separate by part" (AC-6.16): each part's speech of a label matched automatically gets its own label,
 * which keeps the name until it is renamed. Irreversible, so it is a confirmation (primary: it is not
 * destructive). A failure keeps the dialog open with its message; 409 `not_joined` means the page is out
 * of date, so the dialog closes and the page offers to reload.
 */
export function SeparateSpeakerDialog({
  meetingId,
  speaker,
  name,
  onSeparated,
  onStale,
  onClose,
}: SeparateSpeakerDialogProps) {
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  const confirm = async () => {
    setFailure(null)
    setBusy(true)
    try {
      onSeparated((await separateSpeaker(meetingId, speaker.key)).speakers)
    } catch (error) {
      setBusy(false)
      if (
        error instanceof ApiError &&
        error.status === 409 &&
        (error.code === 'not_joined' || error.code === 'not_ready')
      ) {
        onStale()
        return
      }
      setFailure(errorMessage(error))
    }
  }

  return (
    <ConfirmDialog
      title={strings.transcript.separate.title}
      tone="primary"
      confirmLabel={strings.transcript.separate.confirm}
      busyLabel={strings.transcript.separate.busy}
      cancelLabel={strings.common.cancel}
      closeLabel={strings.common.close}
      busy={busy}
      error={failure}
      onConfirm={() => void confirm()}
      onCancel={onClose}
      testIdPrefix="meetings-separate-speaker"
    >
      {strings.transcript.separate.body(name)}
    </ConfirmDialog>
  )
}
