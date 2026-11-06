import { useState } from 'react'
import { Button } from '@operai/ui'
import type { Project, Terms } from '../lib/types'
import { strings } from '../strings'
import EndTermsDialog from './EndTermsDialog'
import TermsDetails from './TermsDetails'
import TermsFormDialog from './TermsFormDialog'

/**
 * TermsBlock — the terms of a project and, for a holder of manage projects, what changes them: "Edit"
 * (the dates and the whole set of terms) and "Set end date" (only while the terms are open-ended; an
 * ended set is edited to change or clear its date). Used inside the purchase order card (terms always
 * come with a PO) and in the Terms card of a hand-made project, so both change terms the same way.
 *
 * A write tells the page (`onChanged`, with the confirmation), which reads the project again so
 * its dates and version are current; a stale write is the page's (`onStale`). `title`, when
 * given, heads the block (the purchase order card; the Terms card's own title does it there).
 */
export default function TermsBlock({
  project,
  terms,
  title,
  canManage,
  onChanged,
  onStale,
}: {
  project: Pick<Project, 'id' | 'type' | 'purchaseOrder'>
  terms: Terms
  title?: string
  canManage: boolean
  onChanged: (message: string) => void
  onStale: () => void
}) {
  const [dialog, setDialog] = useState<'edit' | 'end' | null>(null)
  const t = strings.terms

  const stale = () => {
    setDialog(null)
    onStale()
  }
  const written = (message: string) => {
    setDialog(null)
    onChanged(message)
  }

  return (
    <div className="flex flex-col gap-3" data-testid="terms-block">
      {(title || canManage) && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          {title && <h4 className="text-sm font-semibold text-text">{title}</h4>}
          {canManage && (
            <div className="flex gap-2">
              <Button size="sm" aria-haspopup="dialog" onClick={() => setDialog('edit')}>
                {t.edit}
              </Button>
              {terms.endDate === null && (
                <Button size="sm" aria-haspopup="dialog" onClick={() => setDialog('end')}>
                  {t.setEndDate}
                </Button>
              )}
            </div>
          )}
        </div>
      )}
      <TermsDetails terms={terms} />
      {dialog === 'edit' && (
        <TermsFormDialog
          project={project}
          terms={terms}
          onSaved={() => written(t.saved.updated)}
          onCancel={() => setDialog(null)}
          onStale={stale}
        />
      )}
      {dialog === 'end' && (
        <EndTermsDialog
          projectId={project.id}
          terms={terms}
          onEnded={() => written(t.saved.ended)}
          onCancel={() => setDialog(null)}
          onStale={stale}
        />
      )}
    </div>
  )
}
