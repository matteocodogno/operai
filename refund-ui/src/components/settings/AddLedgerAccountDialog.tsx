/**
 * AddLedgerAccountDialog — add one account to the WellD CH chart of accounts (specs/20261118-refund-accounting-export,
 * design S6a, F1; AC-1.1, AC-1.2). Mounted BESIDE the card, never inside a `<form>` (ADR 20261118
 * dialog-beside-form); it is a `FormDialog`, which holds its own form.
 *
 * Owns its fields and the `POST`. The client checks mirror the server (`^[0-9]{3,6}(\.[0-9]{1,3})?$`, a name of
 * 1 to 120 characters) and the number is also compared with the loaded list on blur, so a duplicate is
 * named before a round trip; the server stays the authority (a 409 is shown the same way, and the
 * "deactivated: reactivate it" variant is chosen from the list, because the 409 does not say which).
 * A failed save keeps every typed value; a field error moves focus to its field. Success reports the
 * server's account to the card (`onAdded`), which closes the dialog and confirms.
 */

import { useEffect, useRef, useState } from 'react'
import { Field, FormDialog } from '@operai/ui'
import { strings } from '../../strings'
import { createLedgerAccount } from '../../lib/accountingApi'
import type { LedgerAccount } from '../../lib/accountingApi'
import { ApiError } from '../../lib/refundApi'

const NUMBER_PATTERN = /^[0-9]{3,6}(\.[0-9]{1,3})?$/
const NAME_MAX = 120

export type AddLedgerAccountDialogProps = {
  /** The accounts the card has loaded, for the duplicate pre-check. */
  accounts: readonly LedgerAccount[]
  onCancel: () => void
  onAdded: (account: LedgerAccount) => void
}

export default function AddLedgerAccountDialog({ accounts, onCancel, onAdded }: AddLedgerAccountDialogProps) {
  const t = strings.settings.accounts
  const tc = strings.settings.catalog
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

  const duplicateMessage = (value: string): string | null => {
    const existing = accounts.find((account) => account.number === value)
    if (!existing) return null
    return existing.active ? t.errors.duplicate(value) : t.errors.duplicateInactive(value)
  }

  const checkNumber = (raw: string): string | null => {
    const value = raw.trim()
    if (!NUMBER_PATTERN.test(value)) return t.errors.numberInvalid
    return duplicateMessage(value)
  }

  const checkName = (raw: string): string | null => {
    const value = raw.trim()
    return value.length === 0 || value.length > NAME_MAX ? t.errors.nameRequired : null
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
      created = await createLedgerAccount({ number: number.trim(), name: name.trim() })
    } catch (error) {
      setBusy(false)
      if (error instanceof ApiError && error.code === 'ledger_account_duplicate') {
        setNumberError(duplicateMessage(number.trim()) ?? t.errors.duplicate(number.trim()))
        setFocusRequest({ field: 'number' })
      } else if (error instanceof ApiError && error.code === 'invalid_ledger_account') {
        setNumberError(t.errors.numberInvalid)
        setFocusRequest({ field: 'number' })
      } else if (error instanceof ApiError && error.status === 403) {
        setGeneralError(tc.forbidden)
      } else {
        setGeneralError(tc.genericError)
      }
      return
    }
    onAdded(created)
  }

  return (
    <FormDialog
      title={t.addDialog.title}
      description={t.addDialog.description}
      size="sm"
      submitLabel={t.add}
      busyLabel={t.addDialog.busy}
      cancelLabel={tc.cancel}
      closeLabel={tc.cancel}
      busy={busy}
      canSubmit={number.trim() !== '' && name.trim() !== ''}
      error={generalError}
      onSubmit={() => void handleSubmit()}
      onCancel={onCancel}
      testIdPrefix="add-ledger-account"
    >
      <Field
        label={t.addDialog.number}
        hint={t.addDialog.numberHint}
        required
        error={numberError && <span data-testid="add-ledger-account-number-error">{numberError}</span>}
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
            data-testid="add-ledger-account-number"
          />
        )}
      </Field>
      <Field
        label={t.addDialog.name}
        required
        error={nameError && <span data-testid="add-ledger-account-name-error">{nameError}</span>}
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
            data-testid="add-ledger-account-name"
          />
        )}
      </Field>
    </FormDialog>
  )
}
