import { useState } from 'react'
import GuardrailDialog from './GuardrailDialog'
import IrreversibleActionDialog from './IrreversibleActionDialog'
import RollForwardStatement from './RollForwardStatement'
import { ApiError } from '../lib/api'
import { closeFiscalYear } from '../lib/fiscalYearsApi'
import { toInventoryError } from '../lib/types'
import type { Currency, Entity, FiscalYearView } from '../lib/types'
import { strings } from '../strings'
import { fillTemplate } from '../strings/errors'

/**
 * CloseYearDialog — "Close fiscal year {year}?" (T38, specs/015-hardware-inventory;
 * design.md F12, § Irreversible actions "Close year", § Error and conflict
 * catalogue; AC-8.4, AC-8.5, AC-8.7): an `IrreversibleActionDialog` whose
 * consequence shows the five roll-forward lines, then states that the year is
 * frozen, nothing dated in it (or earlier) can be changed afterwards and it can
 * NEVER be reopened. There is no form; Confirm needs the acknowledgement and
 * default focus is Cancel. Dismissal is blocked while the request is in flight
 * (the shell guarantees it).
 *
 * Owns the one POST. Outcomes:
 *   - 201 -> `onClosed(view)` (the closed `FiscalYearView`; the page re-renders it);
 *   - `previous_year_open` / `nothing_to_close` -> inline in the dialog, which stays open;
 *   - `already_closed` -> a conflict acknowledgement (`GuardrailDialog`) in place of
 *     the form, then `onStale()` so the page refetches;
 *   - 503 / network / anything else -> inline, dialog stays open, retry possible.
 * `previous_year_open` carries no year, the one to close first is `year - 1`.
 */

export type CloseYearDialogProps = {
  entity: Entity
  year: number
  currency: Currency
  rollForward: FiscalYearView['rollForward']
  onClosed: (view: FiscalYearView) => void
  /** The year was already closed by someone else: the page must refetch. */
  onStale: () => void
  onCancel: () => void
}

const unavailable = `${strings.common.authUnavailable.heading}. ${strings.common.authUnavailable.body}`

export default function CloseYearDialog({
  entity,
  year,
  currency,
  rollForward,
  onClosed,
  onStale,
  onCancel,
}: CloseYearDialogProps) {
  const t = strings.yearDetail.closeDialog
  const entityName = strings.common.entity[entity]
  const [submitting, setSubmitting] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [alreadyClosed, setAlreadyClosed] = useState(false)

  const fail = (error: unknown) => {
    const known = toInventoryError(error)
    if (known?.code === 'already_closed') return setAlreadyClosed(true)
    if (known?.code === 'previous_year_open') {
      return setErrorMessage(fillTemplate(strings.errors.previous_year_open, { year: year - 1 }))
    }
    if (known?.code === 'nothing_to_close') {
      return setErrorMessage(fillTemplate(strings.errors.nothing_to_close, { year }))
    }
    if (error instanceof ApiError) {
      return setErrorMessage(error.status === 503 ? unavailable : (error.detail ?? strings.errors.unknown))
    }
    return setErrorMessage(strings.errors.network)
  }

  const confirm = () => {
    if (submitting) return
    setSubmitting(true)
    setErrorMessage(null)
    closeFiscalYear(entity, year).then(
      (view) => onClosed(view),
      (error: unknown) => {
        setSubmitting(false)
        fail(error)
      },
    )
  }

  if (alreadyClosed) {
    return (
      <GuardrailDialog
        title={t.guardrailTitle}
        message={fillTemplate(strings.errors.already_closed, { year })}
        acknowledgeLabel={t.guardrailAcknowledge}
        onAcknowledge={onStale}
      />
    )
  }

  return (
    <IrreversibleActionDialog
      title={t.title(year)}
      consequence={
        <div className="flex flex-col gap-3">
          <RollForwardStatement rollForward={rollForward} currency={currency} entity={entity} year={year} />
          <p>{t.consequence(year, entityName)}</p>
        </div>
      }
      acknowledgeLabel={t.acknowledge}
      confirmLabel={t.confirm(year)}
      confirmingLabel={t.confirming}
      isConfirming={submitting}
      errorMessage={errorMessage}
      onConfirm={confirm}
      onCancel={onCancel}
      testIdPrefix="close-year-dialog"
    />
  )
}
