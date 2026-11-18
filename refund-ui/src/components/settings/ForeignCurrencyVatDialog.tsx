/**
 * ForeignCurrencyVatDialog — designate the VAT code that WellD CH lines in a currency other than CHF get by
 * default (specs/20261118-refund-accounting-export, design S6d, F4; AC-2.5, AC-2.6, AC-2.8). One `CatalogSelect` of
 * the ACTIVE VAT codes and "None designated". Same rules as `DefaultClassificationDialog`: Save is disabled until the
 * choice differs from the designation, a deactivated designation starts on "Choose…", and a 422 (the code was
 * deactivated while this was open) is a field error with the options reloaded.
 */

import { useEffect, useRef, useState } from 'react'
import { Field, FormDialog } from '@operai/ui'
import { strings } from '../../strings'
import { putForeignCurrencyVatCode } from '../../lib/accountingApi'
import type { ForeignCurrencyVatCodeState } from '../../lib/accountingApi'
import { CATALOG_NONE, vatCodeText } from '../../lib/catalogLabels'
import { ApiError } from '../../lib/refundApi'
import CatalogSelect from '../CatalogSelect'
import ErrorBanner from '../ErrorBanner'
import { useActiveCatalogOptions } from './useActiveCatalogOptions'

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
    designation === null ? CATALOG_NONE : designation.active ? designation.id : '',
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
    loaded && selected !== '' && selected !== CATALOG_NONE && !vatCodes.some((code) => code.id === selected)
      ? ''
      : selected

  const saved = designation === null ? CATALOG_NONE : designation.id
  const canSave = loaded && value !== '' && value !== saved
  const inactiveDesignation = designation !== null && !designation.active

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
      if (code === 'vat_code_inactive' || code === 'unknown_vat_code') {
        setSelectError(t.errors.vatInactive)
        setSelected('')
        options.reload()
        setFocusRequest({})
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
      {options.status === 'error' && <ErrorBanner message={t.loadError} onRetry={options.reload} />}
      <Field
        label={t.foreign.term}
        hint={
          inactiveDesignation && value === '' && designation
            ? t.dialog.inactiveCurrent(vatCodeText(designation))
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
