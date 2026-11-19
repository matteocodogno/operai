/**
 * RateCorrectionDialog — correct ONE monthly exchange rate, or enter one the source never published (moved from refund-ui;
 * specs/20261119-accounting, design FA8, AS6c, UX-6, UX-10; AC-2.4, AC-2.5, AC-8.4). A `FormDialog` mounted beside the card,
 * never inside a `<form>` (ADR 20261118 dialog-beside-form). It owns its field and the `PUT`.
 *
 *   - The rate is the entity's own currency per 1 unit of the foreign one, up to 6 decimals, dot or comma. It is checked as text
 *     (`checkFxRate`, no float) and sent as the canonical string the API expects (`0.93`, never `0,9300`). The limit is AC-2.5's
 *     and the server's: greater than 0 and below 1000, so `999.999999` is accepted and `1000` is not (UX-10; the 20261118
 *     check accepted up to 9999). The server stays the authority.
 *   - The description is UX-10's: anything booked from now on uses this rate, what was already booked keeps its own, and the
 *     previous value stays in the audit trail. The 20261118 sentence about re-exporting was false after AC-5.3 and is gone.
 *   - The hint states the limit and names the rate in effect and where it came from (never prefilled: typing over a value
 *     invites a stray digit). Save is disabled while the field is empty or still equals the rate in effect.
 *   - 422 `invalid_rate` is a field error; `month_not_completed` and `currency_not_convertible` are general errors (no field can
 *     fix them); 403 reads as a permission problem and tells the frame; 404 tells the frame the entity is gone. Every typed value
 *     is kept on failure. No `ErrorSummary` (UX-6): focus goes to the field, whose own alert carries the sentence.
 */

import { useEffect, useRef, useState } from 'react'
import { Field, FormDialog, MoneyInput, parseDecimal } from '@operai/ui'
import { ApiError } from '../lib/api'
import { putExchangeRate } from '../lib/exchangeRatesApi'
import type { ExchangeRateMonth, Rate, RateCurrency } from '../lib/exchangeRatesApi'
import { checkFxRate } from '../lib/limits'
import type { EntityId } from '../lib/meApi'
import { monthLabel } from '../lib/monthLabel'
import { strings } from '../strings'

const t = strings.fx

/** Dot or comma is typed; the request carries a dot. */
const dotted = (raw: string): string => raw.trim().replace(',', '.')

/** `0.9300` → `0.93`, `1.000000` → `1`: the canonical string of an already validated rate, by text only. */
const canonicalRate = (validated: string): string => {
  const [whole = '0', fraction = ''] = validated.split('.')
  const trimmed = fraction.replace(/0+$/, '')
  return trimmed === '' ? String(Number(whole)) : `${Number(whole)}.${trimmed}`
}

export type RateCorrectionDialogProps = {
  entity: EntityId
  /** The entity's own currency, the unit of the rate. */
  ownCurrency: string
  /** The entity's rate currencies, to read the month row the server answers with. */
  currencies: readonly RateCurrency[]
  month: string
  currency: RateCurrency
  /** The rate in effect (or `missing`), for the hint and for the no-op check. */
  rate: Rate
  onCancel: () => void
  /** The month's whole row, as the server answers; `null` when it recorded nothing (the rate is the one in effect). */
  onSaved: (row: ExchangeRateMonth | null) => void
  /** A write answered 403: the frame re-reads `/v1/me` (UX-15). */
  onForbidden: () => void
  /** A write answered 404: the entity is not covered any more (UX-12). */
  onGone: () => void
}

export default function RateCorrectionDialog({
  entity,
  ownCurrency,
  currencies,
  month,
  currency,
  rate,
  onCancel,
  onSaved,
  onForbidden,
  onGone,
}: RateCorrectionDialogProps) {
  const [value, setValue] = useState('')
  const [fieldError, setFieldError] = useState<string | null>(null)
  const [generalError, setGeneralError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  // A new object per request, so the field can be asked for twice; focus moves in an effect, once the fieldset is
  // enabled again (a field of a busy dialog is disabled and cannot take it).
  const [focusRequest, setFocusRequest] = useState<object | null>(null)

  useEffect(() => {
    if (focusRequest) inputRef.current?.focus()
  }, [focusRequest])

  const recorded = rate.status === 'missing' ? null : rate
  // Exactly equal to the rate in effect, compared as integer micros (an exact parse, never a float): a no-op would only
  // write a confirmation for nothing.
  const typedMicros = checkFxRate(dotted(value)).ok ? parseDecimal(value, 6) : null
  const unchanged = recorded !== null && typedMicros === recorded.rateMicros
  const canSubmit = value.trim() !== '' && !unchanged

  const handleSubmit = async () => {
    setGeneralError(null)
    const checked = checkFxRate(dotted(value))
    if (!checked.ok) {
      setFieldError(t.correction.rateInvalid)
      setFocusRequest({})
      return
    }
    setFieldError(null)
    setBusy(true)
    let row: ExchangeRateMonth | null
    try {
      row = await putExchangeRate(entity, month, currency, canonicalRate(checked.value), currencies)
    } catch (error) {
      setBusy(false)
      const code = error instanceof ApiError ? error.code : undefined
      if (code === 'invalid_rate') {
        setFieldError(t.correction.rateInvalid)
        setFocusRequest({})
      } else if (code === 'month_not_completed') {
        setGeneralError(t.correction.monthNotCompleted)
      } else if (code === 'currency_not_convertible') {
        setGeneralError(t.correction.notConvertible)
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
    onSaved(row)
  }

  return (
    <FormDialog
      title={t.correction.title(currency, monthLabel(month))}
      description={t.correction.description}
      size="sm"
      submitLabel={t.correction.save}
      busyLabel={t.correction.busy}
      cancelLabel={strings.common.cancel}
      closeLabel={strings.common.close}
      busy={busy}
      canSubmit={canSubmit}
      error={generalError}
      onSubmit={() => void handleSubmit()}
      onCancel={onCancel}
      testIdPrefix="accounting-fx-correction"
    >
      <Field
        label={t.correction.rate(currency, ownCurrency)}
        hint={
          recorded ? (
            <>
              {t.correction.hint} {t.correction.inEffect(recorded.rate, t.origin[recorded.status])}
            </>
          ) : (
            t.correction.hint
          )
        }
        required
        error={fieldError && <span data-testid="accounting-fx-correction-value-error">{fieldError}</span>}
        errorRole="alert"
      >
        {(control) => (
          <MoneyInput
            {...control}
            ref={inputRef}
            value={value}
            onChange={(event) => {
              setValue(event.target.value)
              setFieldError(null)
            }}
            onBlur={() => {
              if (value.trim() !== '' && !checkFxRate(dotted(value)).ok) setFieldError(t.correction.rateInvalid)
            }}
            data-testid="accounting-fx-correction-value"
          />
        )}
      </Field>
    </FormDialog>
  )
}
