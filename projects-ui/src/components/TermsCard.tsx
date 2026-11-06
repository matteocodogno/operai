import { useState } from 'react'
import { Button, Card, ConfirmDialog } from '@operai/ui'
import { isStaleWrite } from '../lib/api'
import { errorMessage, termsRefusalOf } from '../lib/errors'
import { deleteTerms } from '../lib/projectsApi'
import type { Project, Terms } from '../lib/types'
import { strings } from '../strings'
import TermsBlock from './TermsBlock'
import TermsFormDialog from './TermsFormDialog'

/**
 * TermsCard — the terms of a hand-made project (specs/022 AC-5.3, AC-5.4, S5): its dates and the terms of
 * its type, or none when it has none (they are optional as a whole). There is nothing of a purchase
 * order here — no deal, estimate, Bexio order id, referent or ops-manager — because a hand-made project
 * never has one (AC-5.2); a project made from a deal shows its terms inside its purchase order card.
 *
 * A holder of manage projects adds terms (not on an `internal` project, which has none, and not on a
 * closed or cancelled one, whose existing terms stay editable), edits or ends them (`TermsBlock`), and
 * removes them as a whole (S5): "Remove terms" asks for confirmation in a dialog of the page, then
 * `DELETE …/terms` with the terms' version. A project with a purchase order never offers it — its terms
 * stay with the PO — and the server's `409 terms_required` is worded anyway. Every write tells the page
 * (`onChanged`), which reads the project again; a stale one is the page's (`onStale`).
 */
export default function TermsCard({
  project,
  canManage,
  onChanged,
  onStale,
}: {
  project: Project
  canManage: boolean
  onChanged: (message: string) => void
  onStale: () => void
}) {
  const t = strings.terms
  const [adding, setAdding] = useState(false)
  const open = project.state !== 'closed' && project.state !== 'cancelled'
  const canAdd = canManage && project.type !== 'internal' && open && project.terms === null
  const canRemove = canManage && project.purchaseOrder === null && project.terms !== null

  return (
    <Card
      title={t.title}
      data-testid="project-terms"
      action={
        <>
          {canAdd && (
            <Button size="sm" aria-haspopup="dialog" onClick={() => setAdding(true)} data-testid="project-terms-add">
              {t.add}
            </Button>
          )}
          {canRemove && project.terms !== null && (
            <RemoveTerms projectId={project.id} terms={project.terms} onRemoved={onChanged} onStale={onStale} />
          )}
        </>
      }
    >
      {project.type === 'internal' ? (
        <p className="text-sm text-soft">{t.internal}</p>
      ) : project.terms === null ? (
        <>
          {canManage && !open && <p className="text-sm text-soft">{t.notOpen}</p>}
          <p className="text-sm text-soft">{t.empty}</p>
        </>
      ) : (
        <TermsBlock
          project={project}
          terms={project.terms}
          canManage={canManage}
          onChanged={onChanged}
          onStale={onStale}
        />
      )}
      {adding && (
        <TermsFormDialog
          project={project}
          onSaved={() => {
            setAdding(false)
            onChanged(t.saved.created)
          }}
          onCancel={() => setAdding(false)}
          onStale={() => {
            setAdding(false)
            onStale()
          }}
        />
      )}
    </Card>
  )
}

/**
 * "Remove terms" and its confirmation (S5): the dialog says what happens and stays open, with the
 * refusal in its own words, when the server refuses — `terms_required` (a PO project), `terms_not_found`,
 * `project_not_open`, `out_of_scope` — or fails; a stale remove closes it and is the page's.
 */
function RemoveTerms({
  projectId,
  terms,
  onRemoved,
  onStale,
}: {
  projectId: string
  terms: Terms
  onRemoved: (message: string) => void
  onStale: () => void
}) {
  const t = strings.terms
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const close = () => {
    setConfirming(false)
    setError(null)
  }

  const remove = () => {
    setBusy(true)
    setError(null)
    deleteTerms(projectId, terms.version).then(
      () => {
        setBusy(false)
        setConfirming(false)
        onRemoved(t.saved.removed)
      },
      (failure: unknown) => {
        setBusy(false)
        if (isStaleWrite(failure)) {
          close()
          return onStale()
        }
        const refusal = termsRefusalOf(failure)
        setError(refusal ? t.refusals[refusal] : errorMessage(failure))
      },
    )
  }

  return (
    <>
      <Button size="sm" aria-haspopup="dialog" onClick={() => setConfirming(true)} data-testid="project-terms-remove">
        {t.remove}
      </Button>
      {confirming && (
        <ConfirmDialog
          title={t.removeDialog.title}
          confirmLabel={t.removeDialog.confirm}
          busyLabel={t.removeDialog.busy}
          cancelLabel={t.removeDialog.keep}
          closeLabel={strings.common.close}
          busy={busy}
          error={error}
          onConfirm={remove}
          onCancel={close}
          testIdPrefix="terms-remove"
        >
          {t.removeDialog.body}
        </ConfirmDialog>
      )}
    </>
  )
}
