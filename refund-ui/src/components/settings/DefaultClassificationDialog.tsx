/**
 * DefaultClassificationDialog — set the default account and VAT code of ONE expense type
 * (specs/20261118-refund-accounting-export, design S6c, F4, UX-2; AC-2.1, AC-2.2, AC-2.3, AC-2.4). A `FormDialog`
 * mounted beside the card, with two `CatalogSelect`s that offer only ACTIVE entries and an explicit
 * "None (no default)".
 *
 *   - Save is disabled while nothing differs from what is saved and while a half still reads "Choose…".
 *   - A saved half that points at a deactivated entry starts on "Choose…" (an invalid state) with a hint, so
 *     saving can never silently clear a default; "None" is a choice like any other.
 *   - A 422 `*_inactive` / `unknown_*` (someone deactivated it while this was open) is a field error on that
 *     select, the options reload, and that half goes back to "Choose…".
 *   - The description says approved lines keep what they have (AC-2.3): a default applies from now on.
 *
 * Saving appends a permanent history row, which is why this is a deliberate dialog and not twelve live
 * selects (UX-2). It owns its fields and the `PUT`.
 */

import { useEffect, useRef, useState } from 'react'
import { Field, FormDialog } from '@operai/ui'
import { strings } from '../../strings'
import { putExpenseTypeDefault } from '../../lib/accountingApi'
import type { ExpenseTypeDefault } from '../../lib/accountingApi'
import { CATALOG_NONE, accountText, vatCodeText } from '../../lib/catalogLabels'
import { ApiError } from '../../lib/refundApi'
import CatalogSelect from '../CatalogSelect'
import ErrorBanner from '../ErrorBanner'
import { useActiveCatalogOptions } from './useActiveCatalogOptions'

const t = strings.settings.defaults
const tc = strings.settings.catalog

/** The select value for a saved half: its id, or None; "Choose…" (`''`) when the saved entry is deactivated. */
const initialValue = (saved: { id: string; active: boolean } | null): string =>
  saved === null ? CATALOG_NONE : saved.active ? saved.id : ''

const savedValue = (saved: { id: string } | null): string => (saved === null ? CATALOG_NONE : saved.id)

export type DefaultClassificationDialogProps = {
  row: ExpenseTypeDefault
  /** The expense type in words ("Travel — train"). */
  typeLabel: string
  onCancel: () => void
  onSaved: (row: ExpenseTypeDefault) => void
}

export default function DefaultClassificationDialog({
  row,
  typeLabel,
  onCancel,
  onSaved,
}: DefaultClassificationDialogProps) {
  const options = useActiveCatalogOptions()
  const [account, setAccount] = useState(() => initialValue(row.account))
  const [vatCode, setVatCode] = useState(() => initialValue(row.vatCode))
  const [accountError, setAccountError] = useState<string | null>(null)
  const [vatError, setVatError] = useState<string | null>(null)
  const [generalError, setGeneralError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const accountRef = useRef<HTMLSelectElement>(null)
  const vatRef = useRef<HTMLSelectElement>(null)
  // A new object per request, so the same select can be asked for twice; focus moves in an effect, once the
  // fieldset is enabled again (a select of a busy dialog is disabled and cannot take it).
  const [focusRequest, setFocusRequest] = useState<{ field: 'account' | 'vat' } | null>(null)

  useEffect(() => {
    if (focusRequest) (focusRequest.field === 'account' ? accountRef : vatRef).current?.focus()
  }, [focusRequest])

  const loaded = options.status === 'loaded'
  const accounts = loaded ? options.data.ledgerAccounts : []
  const vatCodes = loaded ? options.data.vatCodes : []

  // An id that is no longer on offer (deactivated since this dialog opened) is no choice at all.
  const effective = (value: string, offered: readonly { id: string }[]): string =>
    loaded && value !== '' && value !== CATALOG_NONE && !offered.some((entry) => entry.id === value) ? '' : value
  const accountValue = effective(account, accounts)
  const vatValue = effective(vatCode, vatCodes)

  const differs = accountValue !== savedValue(row.account) || vatValue !== savedValue(row.vatCode)
  const canSave = loaded && accountValue !== '' && vatValue !== '' && differs

  const accountInactive = row.account !== null && !row.account.active
  const vatInactive = row.vatCode !== null && !row.vatCode.active

  const handleSubmit = async () => {
    setGeneralError(null)
    setAccountError(null)
    setVatError(null)
    setBusy(true)
    let saved: ExpenseTypeDefault
    try {
      saved = await putExpenseTypeDefault(row.type, {
        ledgerAccountId: accountValue === CATALOG_NONE ? null : accountValue,
        vatCodeId: vatValue === CATALOG_NONE ? null : vatValue,
      })
    } catch (error) {
      setBusy(false)
      const code = error instanceof ApiError ? error.code : undefined
      if (code === 'ledger_account_inactive' || code === 'unknown_ledger_account') {
        setAccountError(t.errors.accountInactive)
        setAccount('')
        options.reload()
        setFocusRequest({ field: 'account' })
      } else if (code === 'vat_code_inactive' || code === 'unknown_vat_code') {
        setVatError(t.errors.vatInactive)
        setVatCode('')
        options.reload()
        setFocusRequest({ field: 'vat' })
      } else if (error instanceof ApiError && error.status === 403) {
        setGeneralError(tc.forbidden)
      } else {
        setGeneralError(tc.genericError)
      }
      return
    }
    onSaved(saved)
  }

  const dialogError = generalError ?? (options.status === 'forbidden' ? tc.forbidden : null)

  return (
    <FormDialog
      title={t.dialog.title(typeLabel)}
      description={t.dialog.description}
      size="sm"
      submitLabel={t.dialog.save}
      busyLabel={t.dialog.busy}
      cancelLabel={tc.cancel}
      closeLabel={tc.cancel}
      busy={busy}
      canSubmit={canSave}
      error={dialogError}
      onSubmit={() => void handleSubmit()}
      onCancel={onCancel}
      testIdPrefix="default-classification"
    >
      {(accountInactive || vatInactive) && (
        <p className="text-sm text-soft" data-testid="default-classification-inactive-note">
          {t.dialog.inactiveSentence}
        </p>
      )}
      {options.status === 'error' && <ErrorBanner message={t.loadError} onRetry={options.reload} />}

      <Field
        label={t.dialog.account}
        hint={
          accountInactive && accountValue === '' && row.account
            ? t.dialog.inactiveCurrent(accountText(row.account))
            : undefined
        }
        error={accountError && <span data-testid="default-classification-account-error">{accountError}</span>}
        errorRole="alert"
        required
      >
        {(control) => (
          <CatalogSelect
            {...control}
            ref={accountRef}
            kind="account"
            options={accounts}
            value={accountValue}
            onChange={(value) => {
              setAccount(value)
              setAccountError(null)
            }}
            noneLabel={t.dialog.noneOption}
            placeholder={accountValue === '' ? t.dialog.chooseOption : undefined}
            disabled={!loaded}
            aria-busy={options.status === 'loading' || undefined}
            data-testid="default-classification-account"
          />
        )}
      </Field>
      <Field
        label={t.dialog.vatCode}
        hint={
          vatInactive && vatValue === '' && row.vatCode ? t.dialog.inactiveCurrent(vatCodeText(row.vatCode)) : undefined
        }
        error={vatError && <span data-testid="default-classification-vat-error">{vatError}</span>}
        errorRole="alert"
        required
      >
        {(control) => (
          <CatalogSelect
            {...control}
            ref={vatRef}
            kind="vatCode"
            options={vatCodes}
            value={vatValue}
            onChange={(value) => {
              setVatCode(value)
              setVatError(null)
            }}
            noneLabel={t.dialog.noneOption}
            placeholder={vatValue === '' ? t.dialog.chooseOption : undefined}
            disabled={!loaded}
            aria-busy={options.status === 'loading' || undefined}
            data-testid="default-classification-vat-code"
          />
        )}
      </Field>
    </FormDialog>
  )
}
