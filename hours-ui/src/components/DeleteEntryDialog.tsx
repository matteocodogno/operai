import { useState } from 'react'
import { ConfirmDialog, formatDate, formatDuration } from '@operai/ui'
import type { EntryOn, TimeEntryView } from '../lib/hoursApi.types'
import { strings } from '../strings'

export type DeleteEntryDialogProps = {
  /** The entry to delete: only its duration, name and day are read, to say what is about to go. */
  entry: TimeEntryView
  /**
   * Deletes it. Resolves when deleted (the page then closes the dialog and no state is set here); rejects with
   * what went wrong, which the dialog words as "not deleted" and keeps itself open. A 404 is "already gone": the
   * page treats it as a success of its own and never rejects with it.
   */
  onConfirm: () => Promise<void>
  onCancel: () => void
}

/**
 * How the entry is named in the sentence: the name when the person may read it, else the kind of record and why
 * the name is withheld (AC-4.10) — never an id, never the server's label for a withheld name.
 */
const named = (on: EntryOn): string => {
  if (on.type === 'none') return strings.entries.onPhrase.none(on.category.name)
  const t = strings.entry.delete.on[on.type]
  if (on.visibility === 'hidden') return t.hidden
  if (on.visibility === 'unavailable' || on.label === null) return t.unavailable
  return on.label
}

/**
 * DeleteEntryDialog — the confirmation before an entry is deleted (specs/029-time-tracking T28; design S3, F3;
 * AC-1.5). A `ConfirmDialog tone="danger"`: focus on Cancel, "<duration> on <name>, <date>. This can't be
 * undone.", Confirm busy and the dialog locked while the request runs, and a failure shown inline with the
 * dialog open so Delete can be pressed again. Deleting needs no bookability check (plan), so it works for an
 * entry on a project the person has left or cannot read.
 */
export default function DeleteEntryDialog({ entry, onConfirm, onCancel }: DeleteEntryDialogProps) {
  const t = strings.entry.delete
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const confirm = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await onConfirm()
    } catch {
      setError(t.error)
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
      busy={busy}
      error={error}
      onConfirm={() => void confirm()}
      onCancel={onCancel}
      testIdPrefix="hours-entry-delete-dialog"
    >
      {t.body(formatDuration(entry.minutes * 60_000, { style: 'short' }), named(entry.on), formatDate(entry.day))}
    </ConfirmDialog>
  )
}
