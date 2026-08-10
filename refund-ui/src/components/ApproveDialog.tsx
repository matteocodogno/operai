/**
 * ApproveDialog — non-destructive confirm dialog for "Approve" (T18,
 * specs/007-refund-service/tasks.md, design.md F6 step 4; Component
 * inventory: "ApproveDialog — Reuse (ported, extended) — ConfirmDeleteModal's
 * shell, ported + a new non-destructive tone='positive' variant").
 *
 * Thin wrapper around `ConfirmDeleteModal` — reuses its focus-trap/Escape/
 * confirm contract wholesale (see that component's own T18 extension doc
 * comment), only supplying refund-specific copy, the `tone="positive"`
 * recolor (--grn instead of --red), and a distinct `testIdPrefix` so this
 * dialog's own tests read as "approve-dialog-*", never "confirm-delete-*".
 */

import { strings } from '../strings'
import ConfirmDeleteModal from './ConfirmDeleteModal'

export type ApproveDialogProps = {
  /** The owning employee's display name — interpolated into the title-adjacent body copy. */
  employeeName: string
  isDeciding: boolean
  errorMessage: string | null
  onConfirm: () => void
  onCancel: () => void
}

export default function ApproveDialog({
  employeeName,
  isDeciding,
  errorMessage,
  onConfirm,
  onCancel,
}: ApproveDialogProps) {
  const t = strings.pages.reviewDetail.approveDialog

  return (
    <ConfirmDeleteModal
      entityLabel=""
      itemName={employeeName}
      isDeleting={isDeciding}
      errorMessage={errorMessage}
      onConfirm={onConfirm}
      onCancel={onCancel}
      tone="positive"
      testIdPrefix="approve-dialog"
      title={t.title}
      confirmLabel={t.confirmLabel}
      confirmingLabel={t.confirmingLabel}
      body={<p>{t.body(employeeName)}</p>}
    />
  )
}
