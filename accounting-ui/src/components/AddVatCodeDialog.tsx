/**
 * AddVatCodeDialog — add one VAT code (specs/20261118-refund-accounting-export, design S6b, F3; AC-1.4, AC-1.5). Same shape
 * as `AddLedgerAccountDialog`: mounted beside the card, owns its fields and the `POST`, mirrors the server's checks
 * and leaves it the authority.
 *
 *   - Code: letters, digits, `-` and `_`, up to 16, saved in capitals (it is upper-cased when the field loses focus,
 *     and again on submit); compared with the loaded list on blur, case-insensitively.
 *   - Label: 1 to 80 characters.
 *   - Rate in percent: dot or comma, 0 to 100, up to 2 decimals. Parsed exactly (`parseDecimal`, never through a
 *     float) and sent as the canonical string the API expects (`8.1`, never `8,10`). The description states that the
 *     rate cannot be changed later: there is no edit anywhere (AC-1.5).
 */

import { useEffect, useRef, useState } from 'react'
import { Field, FormDialog, MoneyInput, parseDecimal } from '@operai/ui'
import { strings } from '../../strings'
import { createVatCode } from '../../lib/accountingApi'
import type { VatCode } from '../../lib/accountingApi'
import { ApiError } from '../../lib/refundApi'

const CODE_PATTERN = /^[A-Z0-9_-]{1,16}$/
const LABEL_MAX = 80
/** 100.00 % in hundredths of a percent. */
const RATE_MAX_HUNDREDTHS = 10000

/** Hundredths of a percent as the API's string: `810` → `8.1`, `800` → `8`, `5` → `0.05`. */
const rateString = (hundredths: number): string => {
  const whole = Math.floor(hundredths / 100)
  const fraction = String(hundredths % 100)
    .padStart(2, '0')
    .replace(/0+$/, '')
  return fraction === '' ? String(whole) : `${whole}.${fraction}`
}

export type AddVatCodeDialogProps = {
  /** The VAT codes the card has loaded, for the duplicate pre-check. */
  vatCodes: readonly VatCode[]
  onCancel: () => void
  onAdded: (vatCode: VatCode) => void
}

export default function AddVatCodeDialog({ vatCodes, onCancel, onAdded }: AddVatCodeDialogProps) {
  const t = strings.settings.vatCodes
  const tc = strings.settings.catalog
  const [code, setCode] = useState('')
  const [label, setLabel] = useState('')
  const [rate, setRate] = useState('')
  const [codeError, setCodeError] = useState<string | null>(null)
  const [labelError, setLabelError] = useState<string | null>(null)
  const [rateError, setRateError] = useState<string | null>(null)
  const [generalError, setGeneralError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const codeRef = useRef<HTMLInputElement>(null)
  const labelRef = useRef<HTMLInputElement>(null)
  const rateRef = useRef<HTMLInputElement>(null)
  // See AddLedgerAccountDialog: focus moves in an effect, once the fieldset is enabled again.
  const [focusRequest, setFocusRequest] = useState<{ field: 'code' | 'label' | 'rate' } | null>(null)

  useEffect(() => {
    if (focusRequest) ({ code: codeRef, label: labelRef, rate: rateRef })[focusRequest.field].current?.focus()
  }, [focusRequest])

  const duplicateMessage = (value: string): string | null => {
    const existing = vatCodes.find((vatCode) => vatCode.code.toUpperCase() === value)
    if (!existing) return null
    return existing.active ? t.errors.duplicate(value) : t.errors.duplicateInactive(value)
  }

  const checkCode = (raw: string): string | null => {
    const value = raw.trim().toUpperCase()
    if (!CODE_PATTERN.test(value)) return t.errors.codeInvalid
    return duplicateMessage(value)
  }

  const checkLabel = (raw: string): string | null => {
    const value = raw.trim()
    return value.length === 0 || value.length > LABEL_MAX ? t.errors.labelRequired : null
  }

  /** The rate in hundredths of a percent, or null when it is not a valid 0 to 100 percentage. */
  const parseRate = (raw: string): number | null => {
    const hundredths = parseDecimal(raw, 2)
    return hundredths !== null && hundredths <= RATE_MAX_HUNDREDTHS ? hundredths : null
  }

  const checkRate = (raw: string): string | null => (parseRate(raw) === null ? t.errors.rateInvalid : null)

  const handleSubmit = async () => {
    const nextCodeError = checkCode(code)
    const nextLabelError = checkLabel(label)
    const nextRateError = checkRate(rate)
    setCodeError(nextCodeError)
    setLabelError(nextLabelError)
    setRateError(nextRateError)
    setGeneralError(null)
    if (nextCodeError || nextLabelError || nextRateError) {
      setFocusRequest({ field: nextCodeError ? 'code' : nextLabelError ? 'label' : 'rate' })
      return
    }

    const hundredths = parseRate(rate)
    if (hundredths === null) return
    const normalized = code.trim().toUpperCase()
    setCode(normalized)
    setBusy(true)
    let created: VatCode
    try {
      created = await createVatCode({ code: normalized, label: label.trim(), ratePercent: rateString(hundredths) })
    } catch (error) {
      setBusy(false)
      if (error instanceof ApiError && error.code === 'vat_code_duplicate') {
        setCodeError(duplicateMessage(normalized) ?? t.errors.duplicate(normalized))
        setFocusRequest({ field: 'code' })
      } else if (error instanceof ApiError && error.code === 'invalid_vat_code') {
        setCodeError(t.errors.codeInvalid)
        setFocusRequest({ field: 'code' })
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
      canSubmit={code.trim() !== '' && label.trim() !== '' && rate.trim() !== ''}
      error={generalError}
      onSubmit={() => void handleSubmit()}
      onCancel={onCancel}
      testIdPrefix="add-vat-code"
    >
      <Field
        label={t.addDialog.code}
        hint={t.addDialog.codeHint}
        required
        error={codeError && <span data-testid="add-vat-code-code-error">{codeError}</span>}
        errorRole="alert"
      >
        {(control) => (
          <input
            {...control}
            ref={codeRef}
            type="text"
            autoComplete="off"
            className="input-figure"
            value={code}
            onChange={(event) => {
              setCode(event.target.value)
              setCodeError(null)
            }}
            onBlur={() => {
              if (code.trim() === '') return
              const upper = code.trim().toUpperCase()
              setCode(upper)
              setCodeError(checkCode(upper))
            }}
            data-testid="add-vat-code-code"
          />
        )}
      </Field>
      <Field
        label={t.addDialog.label}
        required
        error={labelError && <span data-testid="add-vat-code-label-error">{labelError}</span>}
        errorRole="alert"
      >
        {(control) => (
          <input
            {...control}
            ref={labelRef}
            type="text"
            autoComplete="off"
            value={label}
            onChange={(event) => {
              setLabel(event.target.value)
              setLabelError(null)
            }}
            onBlur={() => {
              if (label.trim() !== '') setLabelError(checkLabel(label))
            }}
            data-testid="add-vat-code-label"
          />
        )}
      </Field>
      <Field
        label={t.addDialog.rate}
        hint={t.addDialog.rateHint}
        required
        error={rateError && <span data-testid="add-vat-code-rate-error">{rateError}</span>}
        errorRole="alert"
      >
        {(control) => (
          <MoneyInput
            {...control}
            ref={rateRef}
            value={rate}
            onChange={(event) => {
              setRate(event.target.value)
              setRateError(null)
            }}
            onBlur={() => {
              if (rate.trim() !== '') setRateError(checkRate(rate))
            }}
            data-testid="add-vat-code-rate"
          />
        )}
      </Field>
    </FormDialog>
  )
}
