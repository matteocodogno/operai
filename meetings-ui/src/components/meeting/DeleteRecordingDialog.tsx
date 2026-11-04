import { ConfirmDialog } from '@operai/ui'
import { useState } from 'react'
import { errorMessage } from '../../lib/errors'
import { deleteAudio } from '../../lib/meetingsApi'
import type { Meeting } from '../../lib/types'
import { strings } from '../../strings'

export type DeleteRecordingDialogProps = {
  meeting: Meeting
  onClose: () => void
  onChanged: (meeting: Meeting) => void
}

/** Delete recording (AC-4.5): the audio goes now; transcript and summaries stay. A failure keeps the dialog open. */
export default function DeleteRecordingDialog({ meeting, onClose, onChanged }: DeleteRecordingDialogProps) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const confirm = async () => {
    setError(null)
    setBusy(true)
    try {
      onChanged(await deleteAudio(meeting.id))
      onClose()
    } catch (failure) {
      setBusy(false)
      setError(errorMessage(failure))
    }
  }

  return (
    <ConfirmDialog
      title={strings.audio.deleteRecording.title}
      confirmLabel={strings.audio.deleteRecording.confirm}
      busyLabel={strings.audio.deleteRecording.busy}
      cancelLabel={strings.common.cancel}
      closeLabel={strings.common.close}
      busy={busy}
      error={error}
      onConfirm={() => void confirm()}
      onCancel={onClose}
      testIdPrefix="meetings-delete-recording"
    >
      {strings.audio.deleteRecording.body}
    </ConfirmDialog>
  )
}
