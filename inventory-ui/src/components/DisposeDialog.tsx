import { useId, useState } from 'react'
import IrreversibleActionDialog from './IrreversibleActionDialog'
import { ApiError } from '../lib/api'
import { formatDate, todayIsoDate } from '../lib/dates'
import { disposeAsset } from '../lib/ledgerApi'
import { amountToCents, formatMoney } from '../lib/money'
import { toInventoryError } from '../lib/types'
import type { AssetView, DisposalReason, DisposeInput, Identity } from '../lib/types'
import { strings } from '../strings'
import { fillTemplate } from '../strings/errors'

/**
 * DisposeDialog — "Dispose..." (T34, specs/015-hardware-inventory; design.md
 * F10, § Irreversible actions, § Error and conflict catalogue; AC-7.1, AC-7.3,
 * AC-7.4, AC-7.5): an `IrreversibleActionDialog` whose form holds the disposal
 * date (default today, not before the purchase date), the reason (the five of
 * the fixed list, a radio group) and, ONLY for `sold` and `ceded_to_employee`,
 * an optional sale price. The price is never sent for any other reason, so
 * `sale_price_not_allowed` is prevented rather than handled; it is still shown
 * if the server returns it.
 *
 * The shared dialog cannot disable Confirm for an invalid form, so the form is
 * validated on Confirm, with errors on the fields and nothing sent. A date
 * before the purchase date is stopped earlier still, by the date input's own
 * `min` (the browser's native validation), and by the server's
 * `disposed_before_purchase` if it ever gets through. Server
 * errors: `fiscal_year_closed` and `disposed_before_purchase` on the date field;
 * `assignment_pending` inline (and the page is told to refresh, since it did
 * not know of the assignment); `asset_disposed` and a 404 are handed to the
 * page, which owns the guardrail; 503 and network failures stay in the dialog
 * with every typed value.
 */

export type DisposeDialogProps = {
  asset: AssetView
  /** The disposed asset. The caller closes the dialog. */
  onDisposed: (updated: AssetView) => void
  onCancel: () => void
  /** The write met a stale asset. `assignment_pending` leaves the dialog open (its message is inline). */
  onConflict: (kind: 'asset_disposed' | 'not_found' | 'assignment_pending') => void
}

type FieldErrors = Partial<Record<'date' | 'reason' | 'salePrice', string>>

const REASONS: readonly DisposalReason[] = ['sold', 'ceded_to_employee', 'scrapped', 'returned_to_vendor', 'lost']
const REASONS_WITH_PRICE: readonly DisposalReason[] = ['sold', 'ceded_to_employee']

const identityLabel = (identity: Identity): string => {
  if (identity.status === 'system') return strings.assets.holderSystem
  if (identity.status === 'deleted') return strings.assets.holderDeleted
  return identity.name ?? strings.assets.holderUnknown
}

const unavailable = `${strings.common.authUnavailable.heading}. ${strings.common.authUnavailable.body}`

export default function DisposeDialog({ asset, onDisposed, onCancel, onConflict }: DisposeDialogProps) {
  const t = strings.ledger.dispose.dialog
  const baseId = useId()
  const [date, setDate] = useState(todayIsoDate())
  const [reason, setReason] = useState<DisposalReason | ''>('')
  const [salePrice, setSalePrice] = useState('')
  const [errors, setErrors] = useState<FieldErrors>({})
  const [generalError, setGeneralError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const takesPrice = reason !== '' && REASONS_WITH_PRICE.includes(reason)
  const clear = (key: keyof FieldErrors) =>
    setErrors((previous) => {
      if (previous[key] === undefined) return previous
      const next = { ...previous }
      delete next[key]
      return next
    })

  const beforePurchase = () =>
    fillTemplate(strings.errors.disposed_before_purchase, { date: formatDate(asset.purchaseDate) })

  const validate = (): FieldErrors => {
    const found: FieldErrors = {}
    if (date === '') found.date = t.errors.dateRequired
    if (reason === '') found.reason = t.errors.reasonRequired
    if (takesPrice && salePrice.trim() !== '' && amountToCents(salePrice) === null) {
      found.salePrice = t.errors.salePriceInvalid
    }
    return found
  }

  const fail = (error: unknown) => {
    const known = toInventoryError(error)
    if (known?.code === 'asset_disposed') return onConflict('asset_disposed')
    if (error instanceof ApiError && error.status === 404) return onConflict('not_found')
    if (known?.code === 'assignment_pending') {
      const name = asset.pendingAssignment === null ? null : identityLabel(asset.pendingAssignment.assignee)
      setGeneralError(
        fillTemplate(strings.errors.assignment_pending, { name: name ?? strings.ledger.dispose.assigneeFallback }),
      )
      return onConflict('assignment_pending')
    }
    if (known?.code === 'fiscal_year_closed') {
      const year = known.extras.year
      return setErrors({
        date:
          year === undefined
            ? t.errors.yearClosedNoYear
            : fillTemplate(strings.errors.fiscal_year_closed, { year, entity: strings.common.entity[asset.entity] }),
      })
    }
    if (known?.code === 'disposed_before_purchase') return setErrors({ date: beforePurchase() })
    if (known?.code === 'sale_price_not_allowed') return setGeneralError(strings.errors.sale_price_not_allowed)
    if (error instanceof ApiError) {
      if (error.status === 422) return setGeneralError(strings.errors.validation)
      if (error.status === 503) return setGeneralError(unavailable)
      return setGeneralError(error.detail ?? strings.errors.unknown)
    }
    return setGeneralError(strings.errors.network)
  }

  const submit = async () => {
    const found = validate()
    setGeneralError(null)
    setErrors(found)
    if (Object.keys(found).length > 0 || reason === '') return

    const input: DisposeInput = { disposedOn: date, reason }
    if (takesPrice && salePrice.trim() !== '') input.salePriceCents = amountToCents(salePrice) ?? undefined
    setSubmitting(true)
    try {
      onDisposed(await disposeAsset(asset.id, input))
    } catch (error) {
      fail(error)
    } finally {
      setSubmitting(false)
    }
  }

  const entity = strings.common.entity[asset.entity]
  const when = date === '' ? t.dateUnset : formatDate(date)
  const bookValue = formatMoney(0, asset.currency)
  const consequence =
    asset.holder === null
      ? t.consequence(asset.description, entity, when, bookValue)
      : t.consequenceWithHolder(asset.description, entity, when, bookValue, identityLabel(asset.holder))

  const dateId = `${baseId}-date`
  const reasonId = `${baseId}-reason`
  const priceId = `${baseId}-price`
  const inputClass = 'border px-2 py-1.5 text-sm w-full'
  const inputStyle = { borderColor: 'var(--rule)', backgroundColor: 'var(--ink)', color: 'var(--text)' }
  const errorText = (id: string, message: string | undefined) =>
    message === undefined ? null : (
      <p id={`${id}-error`} className="text-xs" style={{ color: 'var(--red)' }}>
        {message}
      </p>
    )

  return (
    <IrreversibleActionDialog
      title={t.title(asset.description)}
      consequence={consequence}
      acknowledgeLabel={t.acknowledge}
      confirmLabel={t.confirm}
      confirmingLabel={t.confirming}
      isConfirming={submitting}
      errorMessage={generalError}
      onConfirm={() => void submit()}
      onCancel={onCancel}
      testIdPrefix="dispose-asset"
    >
      <div className="flex flex-col gap-1">
        <label htmlFor={dateId} className="text-xs" style={{ color: 'var(--soft)' }}>
          {t.fields.date}
        </label>
        <input
          id={dateId}
          type="date"
          min={asset.purchaseDate}
          value={date}
          aria-required="true"
          aria-invalid={errors.date !== undefined ? true : undefined}
          aria-describedby={errors.date !== undefined ? `${dateId}-error` : undefined}
          onChange={(event) => {
            setDate(event.target.value)
            clear('date')
          }}
          className={inputClass}
          style={inputStyle}
        />
        {errorText(dateId, errors.date)}
      </div>

      <div
        role="radiogroup"
        aria-labelledby={`${reasonId}-label`}
        aria-describedby={errors.reason !== undefined ? `${reasonId}-error` : undefined}
        className="flex flex-col gap-1"
      >
        <span id={`${reasonId}-label`} className="text-xs" style={{ color: 'var(--soft)' }}>
          {t.fields.reason}
        </span>
        {REASONS.map((value) => (
          <label key={value} className="flex items-center gap-2 text-sm" style={{ color: 'var(--text)' }}>
            <input
              type="radio"
              name={`${baseId}-reason`}
              value={value}
              checked={reason === value}
              onChange={() => {
                setReason(value)
                clear('reason')
                clear('salePrice')
              }}
            />
            {strings.disposalReasons[value]}
          </label>
        ))}
        {errorText(reasonId, errors.reason)}
      </div>

      {takesPrice && (
        <div className="flex flex-col gap-1">
          <label htmlFor={priceId} className="text-xs" style={{ color: 'var(--soft)' }}>
            {t.fields.salePriceIn(strings.common.currency[asset.currency])} ({t.fields.optional})
          </label>
          <input
            id={priceId}
            inputMode="decimal"
            value={salePrice}
            aria-invalid={errors.salePrice !== undefined ? true : undefined}
            aria-describedby={errors.salePrice !== undefined ? `${priceId}-error` : undefined}
            onChange={(event) => {
              setSalePrice(event.target.value)
              clear('salePrice')
            }}
            className={inputClass}
            style={inputStyle}
          />
          {errorText(priceId, errors.salePrice)}
        </div>
      )}
    </IrreversibleActionDialog>
  )
}
