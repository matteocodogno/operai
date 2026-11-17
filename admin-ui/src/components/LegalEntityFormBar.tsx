/**
 * LegalEntityFormBar — the sticky bar under the entity form (T37, design S2 "Save bar"; the letterheads `SaveBar`
 * pattern): what the form is (changed or not) and **Save as version n+1**. Save is `aria-disabled`, never
 * `disabled`, while there is nothing to save, a newer version is waiting or a save is running: it stays in the tab
 * order and its reason is a hidden description. A save in flight shows "Saving…" and a spinner and ignores clicks.
 * Before a save the page asks the read-only check (T60, design S12): Save is busy and says "Checking…" (the bar too)
 * until the answer; no live region, the dialog or the outcome banner that follows is what is announced.
 * The status is words with an icon, not a live region: the outcomes of a save have their own banners (`notice`).
 */
import { useId } from 'react'
import type { ReactNode, Ref } from 'react'
import { Button, Icon, VisuallyHidden } from '@operai/ui'
import { saveBlockedReason } from './LegalEntityFormModel'
import { strings } from '../strings'

const t = strings.legalEntities.bar

export type LegalEntityFormBarProps = {
  /** The form differs from the version it was loaded from. */
  dirty: boolean
  /** The version the save would make ("Save as version {n}"). */
  nextVersion: number
  saving: boolean
  /** The check that decides whether to ask for a confirmation is running. */
  checking?: boolean
  /** A newer version exists: Save waits until the person chooses how to continue. */
  conflict: boolean
  /** The outcome shown where the person is looking: saved, nothing changed, could not save. */
  notice?: ReactNode
  /** The Save button, for the form to move focus to when a conflict has been settled and there is nothing to review. */
  saveRef?: Ref<HTMLButtonElement>
}

export default function LegalEntityFormBar({
  dirty,
  nextVersion,
  saving,
  checking = false,
  conflict,
  notice,
  saveRef,
}: LegalEntityFormBarProps) {
  const reasonId = useId()
  const reason = saveBlockedReason(dirty, conflict)
  const busy = saving || checking
  const blocked = reason !== null || busy
  return (
    <div
      className="sticky bottom-0 z-10 flex flex-col gap-2 border-t border-rule bg-ink py-3"
      data-testid="admin-legal-bar"
    >
      {notice}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="m-0 flex items-center gap-2 text-sm text-soft" data-testid="admin-legal-status">
          {busy ? (
            checking ? (
              strings.legalEntities.protected.checking
            ) : (
              t.saving
            )
          ) : (
            <>
              <Icon name={dirty ? 'alert' : 'check'} />
              {dirty ? t.dirty : t.clean}
            </>
          )}
        </p>
        <Button
          ref={saveRef}
          type="submit"
          variant="primary"
          busy={busy}
          aria-disabled={blocked || undefined}
          aria-describedby={reason !== null ? reasonId : undefined}
          data-testid="admin-legal-save"
        >
          {checking ? strings.legalEntities.protected.checking : saving ? t.saving : t.save(nextVersion)}
        </Button>
        {reason !== null && <VisuallyHidden id={reasonId}>{reason}</VisuallyHidden>}
      </div>
    </div>
  )
}
