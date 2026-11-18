/**
 * RateCorrectionDialog — correct ONE monthly exchange rate, or enter one the source never published
 * (specs/20261118-refund-accounting-export, design S6f, F8; AC-5.3, AC-5.7). A `FormDialog` mounted beside the card, never
 * inside a `<form>` (ADR 20261118 dialog-beside-form). It owns its field and the `PUT`.
 *
 *   - The rate is CHF per 1 unit of the currency, up to 6 decimals, dot or comma. It is parsed exactly
 *     (`parseDecimal`, never through a float) and sent as the canonical string the API expects (`0.9246`, never
 *     `0,9246`). The bound is the server's: greater than 0 and below 1000 (plan IS-6), so `999.999999` is
 *     accepted and `1000` is not. The server stays the authority.
 *   - The hint names the rate in effect and where it came from; the description says the previous value stays in
 *     the history and that a batch exported before the correction exports differently if exported again.
 *   - Save is disabled while the field is empty or still equals the rate in effect (a no-op would only write
 *     a confirmation for nothing).
 *   - 422 `invalid_rate` is a field error; `month_not_completed` is a general error (no field can fix it);
 *     403 reads as a permission problem. Every typed value is kept on failure.
 */

import { useEffect, useRef, useState } from 'react'
import { Field, FormDialog, MoneyInput, parseDecimal } from '@operai/ui'
import { strings } from '../../strings'
import { putExchangeRate } from '../../lib/exchangeRatesApi'
import type { ExchangeRateMonth, Rate, RateCurrency } from '../../lib/exchangeRatesApi'
import { monthLabel } from '../../lib/monthLabel'
import { ApiError } from '../../lib/refundApi'

const t = strings.settings.fx
const tc = strings.settings.catalog

/** The rate must be below 1000 (a Postgres INTEGER of micros overflows above 2147.483647; plan IS-6). */
const RATE_MAX_MICROS = 1_000_000_000

/** Millionths of CHF as the API's string: `924600` → `0.9246`, `1000000` → `1`, `1` → `0.000001`. */
const rateString = (micros: number): string => {
  const whole = Math.floor(micros / 1_000_000)
  const fraction = String(micros % 1_000_000)
    .padStart(6, '0')
    .replace(/0+$/, '')
  return fraction === '' ? String(whole) : `${whole}.${fraction}`
}

/** The typed rate in millionths, or `null` when it is not a rate the server would accept. */
const parseRate = (raw: string): number | null => {
  const micros = parseDecimal(raw, 6)
  return micros !== null && micros > 0 && micros < RATE_MAX_MICROS ? micros : null
}

export type RateCorrectionDialogProps = {
  month: string
  currency: RateCurrency
  /** The rate in effect (or `missing`), for the hint and for the no-op check. */
  rate: Rate
  onCancel: () => void
  /** The month's whole row, as the server answers. */
  onSaved: (row: ExchangeRateMonth) => void
}

export default function RateCorrectionDialog({ month, currency, rate, onCancel, onSaved }: RateCorrectionDialogProps) {
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
  const typed = parseRate(value)
  const unchanged = recorded !== null && typed === recorded.rateMicros
  const canSubmit = value.trim() !== '' && !unchanged

  const handleSubmit = async () => {
    setGeneralError(null)
    const micros = parseRate(value)
    if (micros === null) {
      setFieldError(t.correction.rateInvalid)
      setFocusRequest({})
      return
    }
    setFieldError(null)
    setBusy(true)
    let row: ExchangeRateMonth
    try {
      row = await putExchangeRate(month, currency, rateString(micros))
    } catch (error) {
      setBusy(false)
      const code = error instanceof ApiError ? error.code : undefined
      if (code === 'invalid_rate') {
        setFieldError(t.correction.rateInvalid)
        setFocusRequest({})
      } else if (code === 'month_not_completed') {
        setGeneralError(t.correction.monthNotCompleted)
      } else if (error instanceof ApiError && error.status === 403) {
        setGeneralError(tc.forbidden)
      } else {
        setGeneralError(tc.genericError)
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
      cancelLabel={tc.cancel}
      closeLabel={tc.cancel}
      busy={busy}
      canSubmit={canSubmit}
      error={generalError}
      onSubmit={() => void handleSubmit()}
      onCancel={onCancel}
      testIdPrefix="rate-correction"
    >
      <Field
        label={t.correction.rate(currency)}
        hint={recorded ? t.correction.inEffect(recorded.rate, t.origin[recorded.status]) : undefined}
        required
        error={fieldError && <span data-testid="rate-correction-value-error">{fieldError}</span>}
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
              if (value.trim() !== '' && parseRate(value) === null) setFieldError(t.correction.rateInvalid)
            }}
            data-testid="rate-correction-value"
          />
        )}
      </Field>
    </FormDialog>
  )
}
