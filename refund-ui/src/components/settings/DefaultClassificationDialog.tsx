/**
 * DefaultClassificationDialog — set the default ACCOUNT of ONE expense type
 * (specs/20261118-refund-accounting-export, design S6c, F4, UX-2; AC-2.1, AC-2.2, AC-2.3, AC-2.4). A `FormDialog`
 * mounted beside the card, with one `CatalogSelect` that offers only ACTIVE accounts and an explicit
 * "None (no default)".
 *
 * Accounting sign-off (T69, specs/20261118 SO-16, 2026-11-19): the account is the whole default. There is no VAT
 * select (a VAT code is never pre-set, AC-3.13) and the request body carries `accountNumber` and nothing else.
 *
 *   - Save is disabled while nothing differs from what is saved and while the select still reads "Choose…".
 *   - A saved account that is deactivated, or no longer in Accounting, starts on "Choose…" (an invalid state) with a
 *     hint, so saving can never silently clear a default; "None" is a choice like any other.
 *   - A 422 `ledger_account_inactive` / `ledger_account_not_found` (someone deactivated or removed it while this was
 *     open) is a field error on the select, the options reload, and the select goes back to "Choose…".
 *   - The options come from Accounting through refund-api (T35, RS3): values are numbers. When Accounting cannot be
 *     read the dialog says so with an alert and a "Try again", offers no options and cannot save (AC-6.9, AC-6.10); a
 *     save refused with 503 says nothing was saved and keeps the dialog open.
 *   - The description says approved lines keep what they have (AC-2.3): a default applies from now on.
 *
 * Saving appends a permanent history row, which is why this is a deliberate dialog and not a live select per type
 * (UX-2). It owns its field and the `PUT`.
 */

import { useEffect, useRef, useState } from 'react'
import { Banner, Button, Field, FormDialog } from '@operai/ui'
import { strings } from '../../strings'
import { entryIsUnusable, isAccountingUnavailable, putExpenseTypeDefault } from '../../lib/accountingApi'
import type { EntryState, ExpenseTypeDefault } from '../../lib/accountingApi'
import { CATALOG_NONE, accountText } from '../../lib/catalogLabels'
import { ApiError } from '../../lib/refundApi'
import CatalogSelect from '../CatalogSelect'
import ErrorBanner from '../ErrorBanner'
import { optionsUnavailable, useActiveCatalogOptions } from './useActiveCatalogOptions'

const t = strings.settings.defaults
const tc = strings.settings.catalog

type SavedAccount = { value: string; state: EntryState } | null

/** The select value for the saved account: its number, or None; "Choose…" (`''`) when it is deactivated or gone. */
const initialValue = (saved: SavedAccount): string =>
  saved === null ? CATALOG_NONE : entryIsUnusable(saved.state) ? '' : saved.value

const savedValue = (saved: SavedAccount): string => (saved === null ? CATALOG_NONE : saved.value)

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
  const [accountError, setAccountError] = useState<string | null>(null)
  const [generalError, setGeneralError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const accountRef = useRef<HTMLSelectElement>(null)
  // A new object per request, so the select can be asked for twice; focus moves in an effect, once the
  // fieldset is enabled again (a select of a busy dialog is disabled and cannot take it).
  const [focusRequest, setFocusRequest] = useState<object | null>(null)

  useEffect(() => {
    if (focusRequest) accountRef.current?.focus()
  }, [focusRequest])

  const loaded = options.status === 'loaded'
  const accounts = loaded ? options.data.ledgerAccounts : []

  // A number that is no longer on offer (deactivated or removed since this dialog opened) is no choice at all.
  const effective = (value: string, offered: readonly string[]): string =>
    loaded && value !== '' && value !== CATALOG_NONE && !offered.includes(value) ? '' : value
  const accountValue = effective(
    account,
    accounts.map((entry) => entry.number),
  )

  const savedAccount: SavedAccount = row.account && { value: row.account.number, state: row.account.state }
  const differs = accountValue !== savedValue(savedAccount)
  const canSave = loaded && accountValue !== '' && differs

  const accountUnusable = row.account !== null && entryIsUnusable(row.account.state)
  const unavailable = optionsUnavailable(options)

  const handleSubmit = async () => {
    setGeneralError(null)
    setAccountError(null)
    setBusy(true)
    let saved: ExpenseTypeDefault
    try {
      saved = await putExpenseTypeDefault(row.type, {
        accountNumber: accountValue === CATALOG_NONE ? null : accountValue,
      })
    } catch (error) {
      setBusy(false)
      const code = error instanceof ApiError ? error.code : undefined
      if (code === 'ledger_account_inactive' || code === 'ledger_account_not_found') {
        setAccountError(code === 'ledger_account_inactive' ? t.errors.accountInactive : t.errors.accountNotFound)
        setAccount('')
        options.reload()
        setFocusRequest({})
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
      {accountUnusable && (
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
    </FormDialog>
  )
}
