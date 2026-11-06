import { ConfirmDialog, formatDate } from '@operai/ui'
import { useState } from 'react'
import { ApiError } from '../../lib/api'
import { errorMessage } from '../../lib/errors'
import { deleteMeeting } from '../../lib/meetingsApi'
import type { Meeting } from '../../lib/types'
import { strings } from '../../strings'

export type DeleteMeetingDialogProps = {
  /**
   * What the dialog names: id, title, date and creator. A full `Meeting` fits, and so does a row of
   * the erase screen, which never has the content (AC-4.7).
   */
  meeting: Pick<Meeting, 'id' | 'title' | 'startsAt' | 'creator'>
  onClose: () => void
  /** The meeting is gone: the page leaves it for the list. */
  onDeleted: () => void
}

/**
 * DeleteMeetingDialog — the creator's Delete meeting and the erase screen's Delete (S3c, F14;
 * AC-4.6, AC-5.12). It names the meeting, lists everything that goes with it — including other
 * people's questions and the entry on the linked record — and needs an acknowledgement, because the
 * loss also hits other people's copies and cannot be undone. A storage failure (`503
 * storage_unavailable`) means nothing was deleted: the message shows inline and the dialog stays. A
 * meeting that is already gone (404) is a success: the goal, it not existing, is met.
 */
export default function DeleteMeetingDialog({ meeting, onClose, onDeleted }: DeleteMeetingDialogProps) {
  const t = strings.erase.delete
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const creator =
    meeting.creator.name ??
    (meeting.creator.status === 'deleted' ? strings.erase.deletedUser : strings.erase.unknownUser)

  const confirm = async () => {
    setBusy(true)
    setError(null)
    try {
      await deleteMeeting(meeting.id)
      onDeleted()
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 404) onDeleted()
      else setError(errorMessage(failure))
    } finally {
      setBusy(false)
    }
  }

  return (
    <ConfirmDialog
      tone="danger"
      title={t.title}
      confirmLabel={t.confirm}
      busyLabel={t.busy}
      cancelLabel={strings.common.cancel}
      closeLabel={strings.common.close}
      acknowledgeLabel={t.acknowledge}
      busy={busy}
      error={error}
      onConfirm={() => void confirm()}
      onCancel={onClose}
      testIdPrefix="meetings-delete-meeting"
    >
      <p className="font-medium">{t.facts(meeting.title, formatDate(meeting.startsAt), creator)}</p>
      <p className="mt-2">{t.willDelete}</p>
      <ul className="mt-1 list-disc pl-5">
        {t.items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      <p className="mt-2">{t.cannotUndo}</p>
    </ConfirmDialog>
  )
}
