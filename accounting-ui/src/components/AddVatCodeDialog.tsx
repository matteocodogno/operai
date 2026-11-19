/**
 * AddVatCodeDialog — add one VAT code to an entity (moved from refund-ui; specs/20261119-accounting, design FA4, AS6b, UX-3,
 * UX-6; AC-1.5, AC-1.6, AC-1.7, AC-8.4). Same shape as `AddLedgerAccountDialog`: mounted beside the card, owns its fields and the
 * `POST`, names the entity in its title, checks with `lib/limits.ts` (the server's limits) and leaves the server the authority.
 *
 *   - Code: capital letters, digits, `-` and `_`, 1 to 16, saved in capitals (it is upper-cased when the field loses focus and
 *     again on submit, AC-1.5); compared with the loaded list on blur, case-insensitively (`imp81` when `IMP81` exists).
 *   - Label: 1 to 80 characters.
 *   - Rate in percent: dot or comma, 0 to 100, at most 2 decimals. Validated as text (`checkVatRatePercent`, no float) and sent
 *     as the canonical string the API expects (`8.1`, never `8,10`). The description states that the rate cannot be changed
 *     later: there is no edit anywhere (AC-1.7).
 *
 * A duplicate names the code and points to Reactivate only when the existing one is deactivated: the server's `reactivate` flag
 * decides (G9), the loaded list is the fallback (AC-1.6). A 422's `fields[]` gives the same sentences as the client check. No
 * `ErrorSummary` (UX-6): focus goes to the first refused field, whose own `role="alert"` error carries the sentence. A 409
 * `catalog_full` (the entity holds the most codes it may, T53) is the dialog's own alert naming the limit; no field is at fault.
 */

import { useEffect, useRef, useState } from 'react'
import { Field, FormDialog, MoneyInput } from '@operai/ui'
import { ApiError } from '../lib/api'
import { catalogFullLimit, createVatCode, duplicateIsDeactivated, refusedFields } from '../lib/catalogApi'
import type { VatCode } from '../lib/catalogApi'
import { CATALOG_CAPS, checkVatCode, checkVatLabel, checkVatRatePercent } from '../lib/limits'
import type { LimitReason } from '../lib/limits'
import type { EntityId } from '../lib/meApi'
import { strings } from '../strings'

const t = strings.vatCodes

const codeMessage = (reason: LimitReason): string =>
  reason === 'empty' ? t.errors.codeEmpty : reason === 'too_long' ? t.errors.codeTooLong : t.errors.codeFormat

const labelMessage = (reason: LimitReason): string =>
  reason === 'too_long' ? t.errors.labelTooLong : reason === 'format' ? t.errors.labelFormat : t.errors.labelEmpty

/** Dot or comma is typed; the request carries a dot. */
const dotted = (raw: string): string => raw.trim().replace(',', '.')

/** `8.10` → `8.1`, `8.00` → `8`, `0.05` stays: the canonical string of an already validated rate, by text only. */
const canonicalRate = (validated: string): string => {
  const [whole = '0', fraction = ''] = validated.split('.')
  const trimmed = fraction.replace(/0+$/, '')
  return trimmed === '' ? String(Number(whole)) : `${Number(whole)}.${trimmed}`
}

export type AddVatCodeDialogProps = {
  entity: EntityId
  /** The VAT codes the card has loaded (this entity's), for the duplicate pre-check. */
  vatCodes: readonly VatCode[]
  onCancel: () => void
  onAdded: (vatCode: VatCode) => void
  /** The server named a duplicate: the list the card holds may be stale, so it loads it again. */
  onStale: () => void
  /** A write answered 403: the frame re-reads `/v1/me` (UX-15). */
  onForbidden: () => void
  /** A write answered 404: the entity is not covered any more (UX-12). */
  onGone: () => void
}

export default function AddVatCodeDialog({
  entity,
  vatCodes,
  onCancel,
  onAdded,
  onStale,
  onForbidden,
  onGone,
}: AddVatCodeDialogProps) {
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

  /** The duplicate sentence: the server's `reactivate` flag when it sent one, else what the loaded list says. */
  const duplicateText = (value: string, deactivated: boolean | null): string => {
    const inactive =
      deactivated ?? vatCodes.find((vatCode) => vatCode.code.toUpperCase() === value.toUpperCase())?.active === false
    return inactive ? t.errors.duplicateInactive(value) : t.errors.duplicate(value, strings.entity[entity])
  }

  const checkCode = (raw: string): string | null => {
    const checked = checkVatCode(raw)
    if (!checked.ok) return codeMessage(checked.reason)
    return vatCodes.some((vatCode) => vatCode.code.toUpperCase() === checked.value)
      ? duplicateText(checked.value, null)
      : null
  }

  const checkLabel = (raw: string): string | null => {
    const checked = checkVatLabel(raw)
    return checked.ok ? null : labelMessage(checked.reason)
  }

  const checkRate = (raw: string): string | null => (checkVatRatePercent(dotted(raw)).ok ? null : t.errors.rateInvalid)

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

    const checkedCode = checkVatCode(code)
    const checkedRate = checkVatRatePercent(dotted(rate))
    if (!checkedCode.ok || !checkedRate.ok) return
    setCode(checkedCode.value)
    setBusy(true)
    let created: VatCode
    try {
      created = await createVatCode(entity, {
        code: checkedCode.value,
        label: label.trim(),
        ratePercent: canonicalRate(checkedRate.value),
      })
    } catch (error) {
      setBusy(false)
      if (error instanceof ApiError && error.code === 'vat_code_duplicate') {
        const named = typeof error.extras.vatCode === 'string' ? error.extras.vatCode : checkedCode.value
        setCodeError(duplicateText(named, duplicateIsDeactivated(error)))
        setFocusRequest({ field: 'code' })
        onStale()
      } else if (error instanceof ApiError && error.code === 'catalog_full') {
        // See AddLedgerAccountDialog: no field is at fault; the dialog's own alert names the limit and that nothing was added.
        setGeneralError(t.errors.catalogFull(catalogFullLimit(error, CATALOG_CAPS.vatCodesPerEntity), strings.entity[entity]))
      } else if (error instanceof ApiError && error.code === 'invalid_vat_code') {
        // The client check passed but the server refused: the same sentences, from its `fields[]`.
        const fields = refusedFields(error)
        const refusedCode = fields.find((field) => field.field === 'code')
        const refusedLabel = fields.find((field) => field.field === 'label')
        const refusedRate = fields.find((field) => field.field === 'ratePercent')
        if (refusedCode) setCodeError(codeMessage(refusedCode.reason))
        if (refusedLabel) setLabelError(labelMessage(refusedLabel.reason))
        if (refusedRate) setRateError(t.errors.rateInvalid)
        if (refusedCode || refusedLabel || refusedRate) {
          setFocusRequest({ field: refusedCode ? 'code' : refusedLabel ? 'label' : 'rate' })
        } else {
          setGeneralError(strings.common.genericError)
        }
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
      canSubmit={code.trim() !== '' && label.trim() !== '' && rate.trim() !== ''}
      error={generalError}
      onSubmit={() => void handleSubmit()}
      onCancel={onCancel}
      testIdPrefix="accounting-vat-dialog"
    >
      <Field
        label={t.addDialog.code}
        hint={t.addDialog.codeHint}
        required
        error={codeError && <span data-testid="accounting-vat-code-error">{codeError}</span>}
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
            data-testid="accounting-vat-code"
          />
        )}
      </Field>
      <Field
        label={t.addDialog.label}
        required
        error={labelError && <span data-testid="accounting-vat-label-error">{labelError}</span>}
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
            data-testid="accounting-vat-label"
          />
        )}
      </Field>
      <Field
        label={t.addDialog.rate}
        hint={t.addDialog.rateHint}
        required
        error={rateError && <span data-testid="accounting-vat-rate-error">{rateError}</span>}
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
            data-testid="accounting-vat-rate"
          />
        )}
      </Field>
    </FormDialog>
  )
}
