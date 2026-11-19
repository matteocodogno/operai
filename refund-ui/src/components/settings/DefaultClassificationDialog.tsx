/**
 * DefaultClassificationDialog — set the default account and VAT code of ONE expense type
 * (specs/20261118-refund-accounting-export, design S6c, F4, UX-2; AC-2.1, AC-2.2, AC-2.3, AC-2.4). A `FormDialog`
 * mounted beside the card, with two `CatalogSelect`s that offer only ACTIVE entries and an explicit
 * "None (no default)".
 *
 *   - Save is disabled while nothing differs from what is saved and while a half still reads "Choose…".
 *   - A saved half that points at a deactivated entry, or one no longer in Accounting, starts on "Choose…" (an
 *     invalid state) with a hint, so saving can never silently clear a default; "None" is a choice like any other.
 *   - A 422 `*_inactive` / `*_not_found` (someone deactivated or removed it while this was open) is a field error on
 *     that select, the options reload, and that half goes back to "Choose…".
 *   - The options come from Accounting through refund-api (T35, RS3): values are numbers and codes. When Accounting
 *     cannot be read the dialog says so with an alert and a "Try again", offers no options and cannot save (AC-6.9,
 *     AC-6.10); a save refused with 503 says nothing was saved and keeps the dialog open.
 *   - The description says approved lines keep what they have (AC-2.3): a default applies from now on.
 *
 * Saving appends a permanent history row, which is why this is a deliberate dialog and not twelve live
 * selects (UX-2). It owns its fields and the `PUT`.
 */

import { useEffect, useRef, useState } from 'react'
import { Banner, Button, Field, FormDialog } from '@operai/ui'
import { strings } from '../../strings'
import { entryIsUnusable, isAccountingUnavailable, putExpenseTypeDefault } from '../../lib/accountingApi'
import type { EntryState, ExpenseTypeDefault } from '../../lib/accountingApi'
import { CATALOG_NONE, accountText, vatCodeText } from '../../lib/catalogLabels'
import { ApiError } from '../../lib/refundApi'
import CatalogSelect from '../CatalogSelect'
import ErrorBanner from '../ErrorBanner'
import { optionsUnavailable, useActiveCatalogOptions } from './useActiveCatalogOptions'

const t = strings.settings.defaults
const tc = strings.settings.catalog

type SavedHalf = { value: string; state: EntryState } | null

/** The select value for a saved half: its number or code, or None; "Choose…" (`''`) when the entry is deactivated or gone. */
const initialValue = (saved: SavedHalf): string =>
  saved === null ? CATALOG_NONE : entryIsUnusable(saved.state) ? '' : saved.value

const savedValue = (saved: SavedHalf): string => (saved === null ? CATALOG_NONE : saved.value)

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
  const [account, setAccount] = useState(() =>
    initialValue(row.account && { value: row.account.number, state: row.account.state }),
  )
  const [vatCode, setVatCode] = useState(() =>
    initialValue(row.vatCode && { value: row.vatCode.code, state: row.vatCode.state }),
  )
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

  // A number or code that is no longer on offer (deactivated or removed since this dialog opened) is no choice at all.
  const effective = (value: string, offered: readonly string[]): string =>
    loaded && value !== '' && value !== CATALOG_NONE && !offered.includes(value) ? '' : value
  const accountValue = effective(
    account,
    accounts.map((entry) => entry.number),
  )
  const vatValue = effective(
    vatCode,
    vatCodes.map((entry) => entry.code),
  )

  const savedAccount: SavedHalf = row.account && { value: row.account.number, state: row.account.state }
  const savedVat: SavedHalf = row.vatCode && { value: row.vatCode.code, state: row.vatCode.state }
  const differs = accountValue !== savedValue(savedAccount) || vatValue !== savedValue(savedVat)
  const canSave = loaded && accountValue !== '' && vatValue !== '' && differs

  const accountUnusable = row.account !== null && entryIsUnusable(row.account.state)
  const vatUnusable = row.vatCode !== null && entryIsUnusable(row.vatCode.state)
  const unavailable = optionsUnavailable(options)

  const handleSubmit = async () => {
    setGeneralError(null)
    setAccountError(null)
    setVatError(null)
    setBusy(true)
    let saved: ExpenseTypeDefault
    try {
      saved = await putExpenseTypeDefault(row.type, {
        accountNumber: accountValue === CATALOG_NONE ? null : accountValue,
        vatCode: vatValue === CATALOG_NONE ? null : vatValue,
      })
    } catch (error) {
      setBusy(false)
      const code = error instanceof ApiError ? error.code : undefined
      if (code === 'ledger_account_inactive' || code === 'ledger_account_not_found') {
        setAccountError(code === 'ledger_account_inactive' ? t.errors.accountInactive : t.errors.accountNotFound)
        setAccount('')
        options.reload()
        setFocusRequest({ field: 'account' })
      } else if (code === 'vat_code_inactive' || code === 'vat_code_not_found') {
        setVatError(code === 'vat_code_inactive' ? t.errors.vatInactive : t.errors.vatNotFound)
        setVatCode('')
        options.reload()
        setFocusRequest({ field: 'vat' })
      } else if (isAccountingUnavailable(error)) {
        setGeneralError(strings.accountingUnavailable.save)
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
      {(accountUnusable || vatUnusable) && (
        <p className="text-sm text-soft" data-testid="default-classification-inactive-note">
          {t.dialog.inactiveSentence}
        </p>
      )}
      {unavailable && (
        <Banner
          tone="warning"
          actions={
            <Button size="sm" variant="ghost" onClick={options.reload} data-testid="default-classification-try-again">
              {t.dialog.tryAgain}
            </Button>
          }
          data-testid="default-classification-unavailable"
        >
          {strings.accountingUnavailable.options}
        </Banner>
      )}
      {options.status === 'error' && !unavailable && <ErrorBanner message={t.loadError} onRetry={options.reload} />}

      <Field
        label={t.dialog.account}
        hint={
          accountUnusable && accountValue === '' && row.account
            ? row.account.state === 'not_found'
              ? t.dialog.notFoundCurrent(accountText(row.account))
              : t.dialog.inactiveCurrent(accountText(row.account))
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
          vatUnusable && vatValue === '' && row.vatCode
            ? row.vatCode.state === 'not_found'
              ? t.dialog.notFoundCurrent(vatCodeText(row.vatCode))
              : t.dialog.inactiveCurrent(vatCodeText(row.vatCode))
            : undefined
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
