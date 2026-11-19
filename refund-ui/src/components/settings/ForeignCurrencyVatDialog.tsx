/**
 * ForeignCurrencyVatDialog — designate the VAT code that WellD CH lines in a currency other than CHF get by
 * default (specs/20261118-refund-accounting-export, design S6d, F4; AC-2.5, AC-2.6, AC-2.8). One `CatalogSelect` of
 * the ACTIVE VAT codes and "None designated". Same rules as `DefaultClassificationDialog` (T35, specs/20261119-accounting):
 * values are codes, Save is disabled until the choice differs from the designation, a deactivated or removed
 * designation starts on "Choose…", a 422 (the code was deactivated or removed while this was open) is a field error
 * with the options reloaded, and Accounting being unreadable shows the AC-6.10 message with no options.
 */

import { useEffect, useRef, useState } from 'react'
import { Banner, Button, Field, FormDialog } from '@operai/ui'
import { strings } from '../../strings'
import { entryIsUnusable, isAccountingUnavailable, putForeignCurrencyVatCode } from '../../lib/accountingApi'
import type { ForeignCurrencyVatCodeState } from '../../lib/accountingApi'
import { CATALOG_NONE, vatCodeText } from '../../lib/catalogLabels'
import { ApiError } from '../../lib/refundApi'
import CatalogSelect from '../CatalogSelect'
import ErrorBanner from '../ErrorBanner'
import { optionsUnavailable, useActiveCatalogOptions } from './useActiveCatalogOptions'

const t = strings.settings.defaults
const tc = strings.settings.catalog

export type ForeignCurrencyVatDialogProps = {
  state: ForeignCurrencyVatCodeState
  onCancel: () => void
  onSaved: (state: ForeignCurrencyVatCodeState) => void
}

export default function ForeignCurrencyVatDialog({ state, onCancel, onSaved }: ForeignCurrencyVatDialogProps) {
  const designation = state.foreignCurrencyVatCode
  const options = useActiveCatalogOptions()
  const [selected, setSelected] = useState(() =>
    designation === null ? CATALOG_NONE : entryIsUnusable(designation.state) ? '' : designation.code,
  )
  const [selectError, setSelectError] = useState<string | null>(null)
  const [generalError, setGeneralError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const selectRef = useRef<HTMLSelectElement>(null)
  const [focusRequest, setFocusRequest] = useState<object | null>(null)

  useEffect(() => {
    if (focusRequest) selectRef.current?.focus()
  }, [focusRequest])

  const loaded = options.status === 'loaded'
  const vatCodes = loaded ? options.data.vatCodes : []
  const value =
    loaded && selected !== '' && selected !== CATALOG_NONE && !vatCodes.some((code) => code.code === selected)
      ? ''
      : selected

  const saved = designation === null ? CATALOG_NONE : designation.code
  const canSave = loaded && value !== '' && value !== saved
  const unusableDesignation = designation !== null && entryIsUnusable(designation.state)
  const unavailable = optionsUnavailable(options)

  const handleSubmit = async () => {
    setGeneralError(null)
    setSelectError(null)
    setBusy(true)
    let result: ForeignCurrencyVatCodeState
    try {
      result = await putForeignCurrencyVatCode(value === CATALOG_NONE ? null : value)
    } catch (error) {
      setBusy(false)
      const code = error instanceof ApiError ? error.code : undefined
      if (code === 'vat_code_inactive' || code === 'vat_code_not_found') {
        setSelectError(code === 'vat_code_inactive' ? t.errors.vatInactive : t.errors.vatNotFound)
        setSelected('')
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
    onSaved(result)
  }

  return (
    <FormDialog
      title={t.foreign.dialogTitle}
      description={t.foreign.description}
      size="sm"
      submitLabel={t.dialog.save}
      busyLabel={t.dialog.busy}
      cancelLabel={tc.cancel}
      closeLabel={tc.cancel}
      busy={busy}
      canSubmit={canSave}
      error={generalError ?? (options.status === 'forbidden' ? tc.forbidden : null)}
      onSubmit={() => void handleSubmit()}
      onCancel={onCancel}
      testIdPrefix="foreign-currency-vat"
    >
      {unavailable && (
        <Banner
          tone="warning"
          actions={
            <Button size="sm" variant="ghost" onClick={options.reload} data-testid="foreign-currency-vat-try-again">
              {t.dialog.tryAgain}
            </Button>
          }
          data-testid="foreign-currency-vat-unavailable"
        >
          {strings.accountingUnavailable.options}
        </Banner>
      )}
      {options.status === 'error' && !unavailable && <ErrorBanner message={t.loadError} onRetry={options.reload} />}
      <Field
        label={t.foreign.term}
        hint={
          unusableDesignation && value === '' && designation
            ? designation.state === 'not_found'
              ? t.dialog.notFoundCurrent(vatCodeText(designation))
              : t.dialog.inactiveCurrent(vatCodeText(designation))
            : undefined
        }
        error={selectError && <span data-testid="foreign-currency-vat-error-field">{selectError}</span>}
        errorRole="alert"
        required
      >
        {(control) => (
          <CatalogSelect
            {...control}
            ref={selectRef}
            kind="vatCode"
            options={vatCodes}
            value={value}
            onChange={(next) => {
              setSelected(next)
              setSelectError(null)
            }}
            noneLabel={t.foreign.none}
            placeholder={value === '' ? t.dialog.chooseOption : undefined}
            disabled={!loaded}
            aria-busy={options.status === 'loading' || undefined}
            data-testid="foreign-currency-vat-select"
          />
        )}
      </Field>
    </FormDialog>
  )
}
