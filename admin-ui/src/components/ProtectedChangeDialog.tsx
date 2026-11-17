/**
 * ProtectedChangeDialog — "Save these changes to {entity}?" (T60, specs/20261117-legal-entities, design S12, flow F15;
 * AC-9.1, AC-9.2, AC-9.3, AC-9.6).
 *
 * The library's `ConfirmDialog tone="primary"`: the action is the one the person meant to take, so a red button would
 * only suggest data loss; the safeguard is the content and the focus. NO acknowledge checkbox (a field in the dialog
 * would take the first focus off Cancel, and AC-9.1 puts it there). The content is the intro, the whole
 * `ProtectedChangeList` and the "the others are told" note, all inside the dialog's described content, so the
 * entity, the labels "Old" and "New" and every value are read when it opens.
 *
 * Cancel, Escape and the close control are one thing, `onCancel`: nothing is sent. After Confirm the caller sets
 * `busy`: both buttons are disabled, Escape and the close control are ignored, and the dialog stays until the answer
 * (the caller then unmounts it and the form shows the outcome by its own states). The dialog owns no request.
 *
 * The values are those auth's check route answered, as they would be stored: the page does not mirror the
 * normalisation (plan decision 10).
 */
import { ConfirmDialog } from '@operai/ui'
import ProtectedChangeList from './ProtectedChangeList'
import type { ProtectedChange } from '../lib/legalEntitiesApi'
import { strings } from '../strings'

const t = strings.legalEntities

export type ProtectedChangeDialogProps = {
  /** The entity's name as the page says it ("WellD CH"). */
  entityName: string
  changes: readonly ProtectedChange[]
  /** The version the save makes ("Save as version n"). */
  nextVersion: number
  /** The save is in flight. */
  busy: boolean
  onConfirm: () => void
  onCancel: () => void
}

export default function ProtectedChangeDialog({
  entityName,
  changes,
  nextVersion,
  busy,
  onConfirm,
  onCancel,
}: ProtectedChangeDialogProps) {
  return (
    <ConfirmDialog
      tone="primary"
      title={t.protected.title(entityName)}
      confirmLabel={t.protected.confirm(nextVersion)}
      busyLabel={t.bar.saving}
      cancelLabel={t.protected.cancel}
      closeLabel={t.protected.cancel}
      busy={busy}
      error={null}
      onConfirm={onConfirm}
      onCancel={onCancel}
      testIdPrefix="admin-legal-protected"
    >
      <p className="m-0">{t.protected.intro}</p>
      <ProtectedChangeList changes={changes} />
      <p className="m-0 text-sm text-soft">{t.protected.told(entityName)}</p>
    </ConfirmDialog>
  )
}
