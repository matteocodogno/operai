/**
 * AddLedgerAccountDialog — add one account to an entity's chart of accounts (moved from refund-ui; specs/20261119-accounting,
 * design FA3, AS6a, UX-3, UX-6; AC-1.1, AC-1.2, AC-1.3, AC-8.4). Mounted BESIDE the card, never inside a `<form>` (ADR
 * 20261118 dialog-beside-form); it is a `FormDialog`, which holds its own form.
 *
 * Owns its fields and the `POST`. The title names the entity ("Add ledger account — WellD CH"), so a manager who switched
 * entity sees which books it goes to. The client checks are `lib/limits.ts` (the server's limits: digits separated by single
 * dots up to 20 characters, a name of 1 to 120; blanks around a value are removed first, AC-1.2), one sentence per reason, and
 * the number is also compared with THIS entity's loaded list on blur and on submit, so a duplicate is named before a round
 * trip (the same number in another entity is allowed, AC-1.3). The server stays the authority: its 409 is shown the same way
 * (`reactivate` says whether the existing one is deactivated, G9) and its 422 `fields[]` is mapped to the same sentences. A 409
 * `catalog_full` (the entity holds the most accounts it may, T53) is the dialog's own alert naming the limit; no field is at fault.
 *
 * No `ErrorSummary` (UX-6): focus goes to the first refused field, whose own `role="alert"` error carries the sentence, so it
 * is announced once. A failed save keeps every typed value. Success reports the server's account to the card (`onAdded`),
 * which closes the dialog and confirms.
 */

import { useEffect, useRef, useState } from 'react'
import { Field, FormDialog } from '@operai/ui'
import { ApiError } from '../lib/api'
import { catalogFullLimit, createLedgerAccount, duplicateIsDeactivated, refusedFields } from '../lib/catalogApi'
import type { LedgerAccount } from '../lib/catalogApi'
import { CATALOG_CAPS, checkLedgerName, checkLedgerNumber } from '../lib/limits'
import type { LimitReason } from '../lib/limits'
import type { EntityId } from '../lib/meApi'
import { strings } from '../strings'

const t = strings.accounts

const numberMessage = (reason: LimitReason): string =>
  reason === 'empty' ? t.errors.numberEmpty : reason === 'too_long' ? t.errors.numberTooLong : t.errors.numberFormat

const nameMessage = (reason: LimitReason): string =>
  reason === 'too_long' ? t.errors.nameTooLong : reason === 'format' ? t.errors.nameFormat : t.errors.nameEmpty

export type AddLedgerAccountDialogProps = {
  entity: EntityId
  /** The accounts the card has loaded (this entity's), for the duplicate pre-check. */
  accounts: readonly LedgerAccount[]
  onCancel: () => void
  onAdded: (account: LedgerAccount) => void
  /** The server named a duplicate: the list the card holds may be stale, so it loads it again. */
  onStale: () => void
  /** A write answered 403: the frame re-reads `/v1/me` (UX-15). */
  onForbidden: () => void
  /** A write answered 404: the entity is not covered any more (UX-12). */
  onGone: () => void
}

export default function AddLedgerAccountDialog({
  entity,
  accounts,
  onCancel,
  onAdded,
  onStale,
  onForbidden,
  onGone,
}: AddLedgerAccountDialogProps) {
  const [number, setNumber] = useState('')
  const [name, setName] = useState('')
  const [numberError, setNumberError] = useState<string | null>(null)
  const [nameError, setNameError] = useState<string | null>(null)
  const [generalError, setGeneralError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const numberRef = useRef<HTMLInputElement>(null)
  const nameRef = useRef<HTMLInputElement>(null)
  // A new object per request, so the same field can be asked for twice. Focus moves in an effect, after the
  // fieldset is enabled again: a field of a busy dialog is disabled and cannot take it.
  const [focusRequest, setFocusRequest] = useState<{ field: 'number' | 'name' } | null>(null)

  useEffect(() => {
    if (focusRequest) (focusRequest.field === 'number' ? numberRef : nameRef).current?.focus()
  }, [focusRequest])

  /** The duplicate sentence: the server's `reactivate` flag when it sent one, else what the loaded list says. */
  const duplicateText = (value: string, deactivated: boolean | null): string => {
    const inactive = deactivated ?? accounts.find((account) => account.number === value)?.active === false
    return inactive ? t.errors.duplicateInactive(value) : t.errors.duplicate(value, strings.entity[entity])
  }

  const checkNumber = (raw: string): string | null => {
    const checked = checkLedgerNumber(raw)
    if (!checked.ok) return numberMessage(checked.reason)
    return accounts.some((account) => account.number === checked.value) ? duplicateText(checked.value, null) : null
  }

  const checkName = (raw: string): string | null => {
    const checked = checkLedgerName(raw)
    return checked.ok ? null : nameMessage(checked.reason)
  }

  const handleSubmit = async () => {
    const nextNumberError = checkNumber(number)
    const nextNameError = checkName(name)
    setNumberError(nextNumberError)
    setNameError(nextNameError)
    setGeneralError(null)
    if (nextNumberError || nextNameError) {
      setFocusRequest({ field: nextNumberError ? 'number' : 'name' })
      return
    }

    setBusy(true)
    let created: LedgerAccount
    try {
      created = await createLedgerAccount(entity, { number: number.trim(), name: name.trim() })
    } catch (error) {
      setBusy(false)
      if (error instanceof ApiError && error.code === 'ledger_account_duplicate') {
        const named = typeof error.extras.number === 'string' ? error.extras.number : number.trim()
        setNumberError(duplicateText(named, duplicateIsDeactivated(error)))
        setFocusRequest({ field: 'number' })
        onStale()
      } else if (error instanceof ApiError && error.code === 'catalog_full') {
        // Nothing a field can fix (T53, F-01): the entity holds the most accounts it may, deactivated ones included. The
        // sentence names the limit and that nothing was added; it is the dialog's own alert (announced once), the typed
        // values stay, and focus stays in the dialog (the library returns it to Cancel when the busy Save is disabled).
        setGeneralError(
          t.errors.catalogFull(catalogFullLimit(error, CATALOG_CAPS.ledgerAccountsPerEntity), strings.entity[entity]),
        )
      } else if (error instanceof ApiError && error.code === 'invalid_ledger_account') {
        // The client check passed but the server refused: the same sentences, from its `fields[]`.
        const fields = refusedFields(error)
        const refusedNumber = fields.find((field) => field.field === 'number')
        const refusedName = fields.find((field) => field.field === 'name')
        if (refusedNumber) setNumberError(numberMessage(refusedNumber.reason))
        if (refusedName) setNameError(nameMessage(refusedName.reason))
        if (refusedNumber || refusedName) setFocusRequest({ field: refusedNumber ? 'number' : 'name' })
        else setGeneralError(strings.common.genericError)
      } else if (error instanceof ApiError && error.status === 403) {
        setGeneralError(strings.common.forbidden)
        onForbidden()
      } else if (error instanceof ApiError && error.status === 404) {
        setGeneralError(strings.common.genericError)
        onGone()
      } else {
        setGeneralError(strings.common.genericError)
      }
      return
    }
    onAdded(created)
  }

  return (
    <FormDialog
      title={t.addDialog.title(strings.entity[entity])}
      description={t.addDialog.description}
      size="sm"
      submitLabel={t.add}
      busyLabel={t.addDialog.busy}
      cancelLabel={strings.common.cancel}
      closeLabel={strings.common.close}
      busy={busy}
      canSubmit={number.trim() !== '' && name.trim() !== ''}
      error={generalError}
      onSubmit={() => void handleSubmit()}
      onCancel={onCancel}
      testIdPrefix="accounting-ledger-dialog"
    >
      <Field
        label={t.addDialog.number}
        hint={t.addDialog.numberHint}
        required
        error={numberError && <span data-testid="accounting-ledger-number-error">{numberError}</span>}
        errorRole="alert"
      >
        {(control) => (
          <input
            {...control}
            ref={numberRef}
            type="text"
            inputMode="decimal"
            autoComplete="off"
            className="input-figure"
            value={number}
            onChange={(event) => {
              setNumber(event.target.value)
              setNumberError(null)
            }}
            onBlur={() => {
              if (number.trim() !== '') setNumberError(checkNumber(number))
            }}
            data-testid="accounting-ledger-number"
          />
        )}
      </Field>
      <Field
        label={t.addDialog.name}
        required
        error={nameError && <span data-testid="accounting-ledger-name-error">{nameError}</span>}
        errorRole="alert"
      >
        {(control) => (
          <input
            {...control}
            ref={nameRef}
            type="text"
            autoComplete="off"
            value={name}
            onChange={(event) => {
              setName(event.target.value)
              setNameError(null)
            }}
            onBlur={() => {
              if (name.trim() !== '') setNameError(checkName(name))
            }}
            data-testid="accounting-ledger-name"
          />
        )}
      </Field>
    </FormDialog>
  )
}
