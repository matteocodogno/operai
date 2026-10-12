import { Link } from '@tanstack/react-router'
import { useId, useState } from 'react'
import type { ReactNode } from 'react'
import FormModal from './FormModal'
import SupplierField from './SupplierField'
import { ApiError } from '../lib/api'
import { updateAsset } from '../lib/assetsApi'
import { amountToCents, formatMoneyAmount } from '../lib/money'
import { toInventoryError, validationField } from '../lib/types'
import type { AssetCategory, AssetPatch, AssetView } from '../lib/types'
import type { InventoryCapabilities } from '../hooks/useInventoryCapabilities'
import { strings } from '../strings'
import { fillTemplate } from '../strings/errors'

/**
 * EditAssetDialog — "Edit details" (T32, specs/015-hardware-inventory;
 * design.md F6, § Dialogs, § Error and conflict catalogue; AC-1.9, AC-3.6,
 * AC-10.1).
 *
 * The FIELD SET depends on the capability and fields outside it are ABSENT, not
 * disabled: `asset:manage` gets category, description, serial number, purchase
 * date, purchase price, supplier, invoice reference and location/note; an
 * accountant ONLY gets supplier and invoice reference (the server answers 403
 * to any other field in a PATCH from an accountant-only caller). Only CHANGED
 * fields are sent, so an accountant's request can never carry a manager field.
 * Entity and currency are shown as read-only text and are never part of the form
 * (AC-1.9).
 *
 * Conflicts, per the catalogue: `serial_conflict` on the serial field (a link to
 * the conflicting asset when the server named it); `fiscal_year_closed` as a
 * banner at the top of the dialog that explains why price and purchase date
 * cannot change (the two fields stay visible and keep what was typed);
 * `asset_disposed` and a 404 are handed to the page (`onConflict`), which owns
 * the guardrail and the refetch. Changing the invoice reference while a file is
 * linked warns, before saving, that the file will be unlinked (design
 * Resolutions G6).
 */

export type EditAssetDialogProps = {
  asset: AssetView
  capabilities: InventoryCapabilities
  /** The saved asset, as the server returned it. The page closes the dialog. */
  onSaved: (updated: AssetView) => void
  onCancel: () => void
  /** The write met a state the dialog cannot resolve: the asset is disposed, or no longer there. */
  onConflict: (kind: 'asset_disposed' | 'not_found') => void
}

type FieldKey =
  | 'category'
  | 'description'
  | 'serialNumber'
  | 'purchaseDate'
  | 'purchasePrice'
  | 'supplier'
  | 'invoiceRef'
  | 'locationNote'

type FieldError = { message: string; linkAssetId?: string }
type FieldErrors = Partial<Record<FieldKey, FieldError>>

type Form = {
  category: AssetCategory
  description: string
  serialNumber: string
  purchaseDate: string
  purchasePrice: string
  supplier: string
  invoiceRef: string
  locationNote: string
}

/** A 422's `field` (an `AssetPatch` key) mapped to the form field that shows it. */
const FIELD_OF_PATCH_KEY: Record<string, FieldKey> = {
  category: 'category',
  description: 'description',
  serialNumber: 'serialNumber',
  locationNote: 'locationNote',
  supplier: 'supplier',
  invoiceRef: 'invoiceRef',
  purchaseDate: 'purchaseDate',
  purchasePriceCents: 'purchasePrice',
}

const initialForm = (asset: AssetView): Form => ({
  category: asset.category,
  description: asset.description,
  serialNumber: asset.serialNumber ?? '',
  purchaseDate: asset.purchaseDate,
  purchasePrice: formatMoneyAmount(asset.purchasePriceCents),
  supplier: asset.supplier ?? '',
  invoiceRef: asset.invoiceRef ?? '',
  locationNote: asset.locationNote ?? '',
})

/** Trimmed text, or null for an emptied optional field. */
const optional = (value: string): string | null => (value.trim() === '' ? null : value.trim())

export default function EditAssetDialog({ asset, capabilities, onSaved, onCancel, onConflict }: EditAssetDialogProps) {
  const t = strings.assetDetail.edit
  const baseId = useId()
  const manager = capabilities.canManageAssets
  const original = initialForm(asset)

  const [form, setForm] = useState<Form>(original)
  const [errors, setErrors] = useState<FieldErrors>({})
  const [yearClosed, setYearClosed] = useState<{ year: number | undefined } | null>(null)
  const [generalError, setGeneralError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const set = (key: FieldKey, value: string) => {
    setForm((previous) => ({ ...previous, [key]: value }))
    setErrors((previous) => {
      if (previous[key] === undefined) return previous
      const next = { ...previous }
      delete next[key]
      return next
    })
  }

  const invoiceRefChanged = optional(form.invoiceRef) !== optional(original.invoiceRef)
  const showUnlinkWarning = invoiceRefChanged && asset.invoiceFile !== null
  const unlinkId = `${baseId}-unlink`
  const yearClosedId = `${baseId}-year-closed`

  /** The fields that differ from what the asset has, and the changed fields that fail client validation. */
  const buildPatch = (): { patch: AssetPatch; invalid: FieldErrors } => {
    const patch: AssetPatch = {}
    const invalid: FieldErrors = {}

    if (manager) {
      if (form.category !== original.category) patch.category = form.category
      if (form.description !== original.description) {
        if (form.description.trim() === '') invalid.description = { message: t.required }
        else patch.description = form.description.trim()
      }
      if (optional(form.serialNumber) !== optional(original.serialNumber))
        patch.serialNumber = optional(form.serialNumber)
      if (form.purchaseDate !== original.purchaseDate) {
        if (form.purchaseDate === '') invalid.purchaseDate = { message: t.dateInvalid }
        else patch.purchaseDate = form.purchaseDate
      }
      if (form.purchasePrice !== original.purchasePrice) {
        const cents = amountToCents(form.purchasePrice)
        if (cents === null || cents <= 0) invalid.purchasePrice = { message: t.priceInvalid }
        else if (cents !== asset.purchasePriceCents) patch.purchasePriceCents = cents
      }
      if (optional(form.locationNote) !== optional(original.locationNote))
        patch.locationNote = optional(form.locationNote)
    }
    if (optional(form.supplier) !== optional(original.supplier)) patch.supplier = optional(form.supplier)
    if (invoiceRefChanged) patch.invoiceRef = optional(form.invoiceRef)

    return { patch, invalid }
  }

  const pending = buildPatch()
  /** Something changed: either a valid change to send, or an invalid one the submit will point at. */
  const canSubmit = Object.keys(pending.patch).length > 0 || Object.keys(pending.invalid).length > 0

  const handleFailure = (error: unknown) => {
    const known = toInventoryError(error)
    if (known?.code === 'asset_disposed') return onConflict('asset_disposed')
    if (error instanceof ApiError && error.status === 404) return onConflict('not_found')

    if (known?.code === 'serial_conflict') {
      const { serialNumber, assetId } = known.extras
      const message =
        serialNumber === undefined
          ? strings.register.validation.serialConflictNoSerial
          : fillTemplate(strings.errors.serial_conflict, { serialNumber })
      return setErrors({ serialNumber: { message, linkAssetId: assetId } })
    }
    if (known?.code === 'fiscal_year_closed') return setYearClosed({ year: known.extras.year })

    const field = validationField(error)
    const key = field === undefined ? undefined : FIELD_OF_PATCH_KEY[field]
    if (key !== undefined) return setErrors({ [key]: { message: strings.errors.validation } })

    if (error instanceof ApiError) {
      if (error.status === 422) return setGeneralError(strings.errors.validation)
      if (error.status === 403) return setGeneralError(t.forbidden)
      if (error.status === 503) {
        return setGeneralError(`${strings.common.authUnavailable.heading}. ${strings.common.authUnavailable.body}`)
      }
      return setGeneralError(error.detail ?? strings.errors.unknown)
    }
    return setGeneralError(strings.errors.network)
  }

  const submit = async () => {
    const { patch, invalid } = buildPatch()
    setGeneralError(null)
    setYearClosed(null)
    if (Object.keys(invalid).length > 0) {
      setErrors(invalid)
      return
    }
    setErrors({})
    setSubmitting(true)
    try {
      onSaved(await updateAsset(asset.id, patch))
    } catch (error) {
      handleFailure(error)
    } finally {
      setSubmitting(false)
    }
  }

  const fieldId = (key: FieldKey) => `${baseId}-${key}`
  const describedBy = (key: FieldKey, extra: (string | false)[] = []) => {
    const ids = [errors[key] !== undefined && `${fieldId(key)}-error`, ...extra].filter(Boolean)
    return ids.length > 0 ? ids.join(' ') : undefined
  }

  const renderError = (key: FieldKey): ReactNode => {
    const error = errors[key]
    if (error === undefined) return null
    return (
      <p id={`${fieldId(key)}-error`} className="text-xs" style={{ color: 'var(--red)' }}>
        {error.message}
        {error.linkAssetId !== undefined && (
          <>
            {' '}
            <Link to="/assets/$id" params={{ id: error.linkAssetId }} className="underline">
              {t.conflictLink}
            </Link>
          </>
        )}
      </p>
    )
  }

  const inputProps = (key: FieldKey, extra: (string | false)[] = []) => ({
    id: fieldId(key),
    'aria-invalid': errors[key] !== undefined ? (true as const) : undefined,
    'aria-describedby': describedBy(key, extra),
    className: 'border px-2 py-1.5 text-sm w-full',
    style: { borderColor: 'var(--rule)', backgroundColor: 'var(--ink)', color: 'var(--text)' },
  })

  const labelClass = 'flex flex-col gap-1 text-xs'
  const labelStyle = { color: 'var(--soft)' }
  const yearClosedRef = yearClosed !== null && yearClosedId

  return (
    <FormModal
      title={manager ? t.title : t.titleInvoice}
      submitLabel={t.submit}
      submittingLabel={t.submitting}
      submitting={submitting}
      canSubmit={canSubmit}
      generalError={generalError}
      onSubmit={() => void submit()}
      onCancel={onCancel}
      testIdPrefix="edit-asset"
    >
      {yearClosed !== null && (
        <p
          id={yearClosedId}
          role="alert"
          data-testid="edit-year-closed"
          className="text-xs"
          style={{ color: 'var(--org)' }}
        >
          {yearClosed.year === undefined
            ? t.yearClosedEditNoYear
            : fillTemplate(strings.errors.fiscal_year_closed_edit, { year: yearClosed.year })}
        </p>
      )}

      {manager && (
        <p className="flex flex-wrap items-center gap-2 text-xs" style={labelStyle}>
          <span>{strings.common.entity[asset.entity]}</span>
          <span aria-hidden="true">·</span>
          <span>{strings.common.currency[asset.currency]}</span>
          <span className="w-full">{t.entityNote}</span>
        </p>
      )}

      {manager && (
        <>
          <label className={labelClass} style={labelStyle}>
            {t.fields.category}
            <select {...inputProps('category')} value={form.category} onChange={(e) => set('category', e.target.value)}>
              {(Object.keys(strings.categories) as AssetCategory[]).map((category) => (
                <option key={category} value={category}>
                  {strings.categories[category]}
                </option>
              ))}
            </select>
          </label>

          <label className={labelClass} style={labelStyle}>
            {t.fields.description}
            <input
              {...inputProps('description')}
              aria-required="true"
              value={form.description}
              onChange={(e) => set('description', e.target.value)}
            />
          </label>
          {renderError('description')}

          <label className={labelClass} style={labelStyle}>
            {t.fields.serial}
            <input
              {...inputProps('serialNumber')}
              value={form.serialNumber}
              onChange={(e) => set('serialNumber', e.target.value)}
            />
          </label>
          {renderError('serialNumber')}

          <label className={labelClass} style={labelStyle}>
            {t.fields.purchaseDate}
            <input
              {...inputProps('purchaseDate', [yearClosedRef])}
              type="date"
              aria-required="true"
              value={form.purchaseDate}
              onChange={(e) => set('purchaseDate', e.target.value)}
            />
          </label>
          {renderError('purchaseDate')}

          <label className={labelClass} style={labelStyle}>
            {t.fields.purchasePriceIn(strings.common.currency[asset.currency])}
            <input
              {...inputProps('purchasePrice', [yearClosedRef])}
              inputMode="decimal"
              aria-required="true"
              value={form.purchasePrice}
              onChange={(e) => set('purchasePrice', e.target.value)}
            />
          </label>
          {renderError('purchasePrice')}
        </>
      )}

      {/* Not wrapped in the <label> like its siblings: the suggestion list would become part of the field's name. */}
      <div className={labelClass} style={labelStyle}>
        <label htmlFor={fieldId('supplier')}>{t.fields.supplier}</label>
        <SupplierField
          id={fieldId('supplier')}
          value={form.supplier}
          onChange={(value) => set('supplier', value)}
          ariaInvalid={errors.supplier !== undefined}
          ariaDescribedBy={describedBy('supplier', [])}
          inputClassName={inputProps('supplier').className}
          inputStyle={inputProps('supplier').style}
        />
      </div>
      {renderError('supplier')}

      <label className={labelClass} style={labelStyle}>
        {t.fields.invoiceRef}
        <input
          {...inputProps('invoiceRef', [showUnlinkWarning && unlinkId])}
          value={form.invoiceRef}
          onChange={(e) => set('invoiceRef', e.target.value)}
        />
      </label>
      {renderError('invoiceRef')}
      {showUnlinkWarning && asset.invoiceFile !== null && (
        <p id={unlinkId} data-testid="edit-unlink-warning" className="text-xs" style={{ color: 'var(--org)' }}>
          {t.unlinkWarning(asset.invoiceFile.fileName)}
        </p>
      )}

      {manager && (
        <>
          <label className={labelClass} style={labelStyle}>
            {t.fields.location}
            <input
              {...inputProps('locationNote')}
              value={form.locationNote}
              onChange={(e) => set('locationNote', e.target.value)}
            />
          </label>
          {renderError('locationNote')}
        </>
      )}
    </FormModal>
  )
}
