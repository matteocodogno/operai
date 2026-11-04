import { ConfirmDialog } from '@operai/ui'
import { useState } from 'react'
import { errorMessage } from '../../lib/errors'
import { deleteSummary } from '../../lib/meetingsApi'
import type { Summary } from '../../lib/types'
import { strings } from '../../strings'

export type DeleteSummaryDialogProps = {
  meetingId: string
  summary: Summary
  onDeleted: () => void
  onCancel: () => void
}

/** Delete a summary after confirming (AC-7.8); a failure keeps the dialog open. */
export function DeleteSummaryDialog({ meetingId, summary, onDeleted, onCancel }: DeleteSummaryDialogProps) {
  const t = strings.summaries.deleteDialog
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const confirm = async () => {
    setError(null)
    setBusy(true)
    try {
      await deleteSummary(meetingId, summary.id)
      onDeleted()
    } catch (failure) {
      setBusy(false)
      setError(errorMessage(failure))
    }
  }

  return (
    <ConfirmDialog
      title={t.title}
      confirmLabel={t.confirm}
      busyLabel={t.busy}
      cancelLabel={strings.common.cancel}
      closeLabel={strings.common.close}
      busy={busy}
      error={error}
      onConfirm={() => void confirm()}
      onCancel={onCancel}
      testIdPrefix="meetings-delete-summary"
    >
      {t.body(summary.template.name)}
    </ConfirmDialog>
  )
}
