import { Link, useNavigate } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import ErrorBanner from '../components/ErrorBanner'
import PermissionDenied from '../components/PermissionDenied'
import SkeletonListRows from '../components/SkeletonListRows'
import SupplierField from '../components/SupplierField'
import { useInventoryCapabilities } from '../hooks/useInventoryCapabilities'
import { useScope } from '../hooks/useScope'
import { ApiError } from '../lib/api'
import { registerAssets } from '../lib/assetsApi'
import { amountToCents, formatMoney } from '../lib/money'
import { splitPrice } from '../lib/splitPrice'
import { toInventoryError, validationField } from '../lib/types'
import type { AssetCategory, Currency, Entity, RegisterAssetsInput } from '../lib/types'
import { strings } from '../strings'
import { fillTemplate } from '../strings/errors'

/**
 * RegisterAssetPage — T3, `/assets/new` (T30, specs/015-hardware-inventory;
 * design.md § T3, F1, § Error and conflict catalogue; AC-1.1 to AC-1.7).
 *
 * `asset:manage` only (UX gate; the server's 403 is the real one). The entity
 * select is limited to `GET /scope`'s `asset` list and is a fixed read-only
 * value when that list has one entry; the currency follows the entity and is
 * shown, never editable (AC-1.2). With a quantity above 1 the page shows the
 * per-unit breakdown from `splitPrice` — the backend's own rule, mirrored — and
 * the serial numbers are either none or exactly one per unit (design Resolutions
 * G7; a blank line is ignored, so a unit cannot be skipped).
 *
 * Failure handling follows the catalogue. The one subtle case is a network
 * failure (or a gateway timeout): the POST is not idempotent and may have
 * created the assets, so the form is kept and the message says to check the list
 * before trying again — never "try again".
 *
 * On success the page navigates with a history `state` the destination can
 * announce: `{ registeredCount }` to the new asset (N = 1) or to the list
 * filtered by invoice reference (N > 1); Cancel returns to the list with
 * `{ focusRegister: true }` so focus lands on the Register button.
 */

type FieldKey = 'entity' | 'category' | 'description' | 'purchaseDate' | 'price' | 'quantity' | 'serials'

type FieldIssue = { message: string; conflictAssetId?: string }
type FieldErrors = Partial<Record<FieldKey, FieldIssue>>

type Failure = { kind: 'text'; text: string } | { kind: 'unavailable' }

type FormValues = {
  entity: Entity | ''
  category: AssetCategory | ''
  description: string
  purchaseDate: string
  price: string
  quantity: string
  serials: string
  notReceived: boolean
  supplier: string
  invoiceRef: string
  locationNote: string
}

const EMPTY: FormValues = {
  entity: '',
  category: '',
  description: '',
  purchaseDate: '',
  price: '',
  quantity: '1',
  serials: '',
  notReceived: false,
  supplier: '',
  invoiceRef: '',
  locationNote: '',
}

const FIELD_IDS: Record<FieldKey, string> = {
  entity: 'register-entity',
  category: 'register-category',
  description: 'register-description',
  purchaseDate: 'register-purchase-date',
  price: 'register-price',
  quantity: 'register-quantity',
  serials: 'register-serials',
}

/** AC-1.2: CHF for `welld_ch`, EUR for `welld_it`. Display only; the server derives it. */
const CURRENCY_OF: Record<Entity, Currency> = { welld_ch: 'CHF', welld_it: 'EUR' }
const CATEGORIES = Object.keys(strings.categories) as AssetCategory[]
const MAX_QUANTITY = 200

/** Present in every state of the page (also the denied and loading ones), so the route can be told apart. */
const PAGE_TEST_ID = 'inventory-register-asset-page'

/** Server field names -> form fields. */
const SERVER_FIELDS: Record<string, FieldKey> = {
  entity: 'entity',
  category: 'category',
  description: 'description',
  purchaseDate: 'purchaseDate',
  totalPriceCents: 'price',
  quantity: 'quantity',
  serialNumbers: 'serials',
}

const ORDER: FieldKey[] = ['entity', 'category', 'description', 'purchaseDate', 'price', 'quantity', 'serials']

const parseQuantity = (raw: string): number | null => {
  if (!/^\d+$/.test(raw.trim())) return null
  const quantity = Number(raw.trim())
  return quantity >= 1 && quantity <= MAX_QUANTITY ? quantity : null
}

const parsePrice = (raw: string): number | null => {
  const cents = amountToCents(raw)
  return cents !== null && cents > 0 ? cents : null
}

/** Non-blank trimmed lines. */
const serialLines = (raw: string): string[] =>
  raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')

const optional = (raw: string): string | undefined => {
  const text = raw.trim()
  return text === '' ? undefined : text
}

const inputClass = 'w-full rounded border px-2 py-1.5 text-sm'
const inputStyle = { borderColor: 'var(--rule)', backgroundColor: 'var(--ink-soft)', color: 'var(--text)' }

function Label({ htmlFor, text, required }: { htmlFor: string; text: string; required?: boolean }) {
  return (
    <label htmlFor={htmlFor} className="text-xs font-medium" style={{ color: 'var(--soft)' }}>
      {text} ({required ? strings.register.required : strings.register.optional})
    </label>
  )
}

function FieldError({ field, error }: { field: FieldKey; error: FieldIssue | undefined }): ReactNode {
  if (error === undefined) return null
  return (
    <p
      id={`${FIELD_IDS[field]}-error`}
      data-testid={`register-error-${field}`}
      className="text-xs"
      style={{ color: 'var(--org)' }}
    >
      {error.message}
      {error.conflictAssetId !== undefined && (
        <>
          {' '}
          <Link to="/assets/$id" params={{ id: error.conflictAssetId }} className="underline">
            {strings.register.validation.conflictLink}
          </Link>
        </>
      )}
    </p>
  )
}

export default function RegisterAssetPage() {
  const { canManageAssets } = useInventoryCapabilities()
  const scope = useScope(canManageAssets)
  const navigate = useNavigate()

  const [values, setValues] = useState<FormValues>(EMPTY)
  const [errors, setErrors] = useState<FieldErrors>({})
  const [failure, setFailure] = useState<Failure | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [summaryFocus, setSummaryFocus] = useState(0)
  const inFlight = useRef(false)
  const summaryRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (summaryFocus > 0) summaryRef.current?.focus()
  }, [summaryFocus])

  if (!canManageAssets) {
    return (
      <div data-testid={PAGE_TEST_ID}>
        <PermissionDenied />
      </div>
    )
  }

  if (scope.status !== 'ready') {
    const unavailable = scope.error instanceof ApiError && scope.error.status === 503
    const scopeMessage =
      scope.error instanceof ApiError ? (scope.error.detail ?? strings.errors.unknown) : strings.errors.network
    return (
      <div data-testid={PAGE_TEST_ID}>
        {scope.status === 'error' ? (
          unavailable ? (
            <ErrorBanner variant="authUnavailable" onRetry={scope.retry} />
          ) : (
            <ErrorBanner message={scopeMessage} onRetry={scope.retry} />
          )
        ) : (
          <>
            <p role="status" aria-live="polite" className="sr-only">
              {strings.register.loadingScope}
            </p>
            <SkeletonListRows />
          </>
        )}
      </div>
    )
  }

  const entities = scope.scope?.asset ?? []
  if (entities.length === 0) {
    return (
      <section aria-labelledby="register-heading" data-testid={PAGE_TEST_ID}>
        <h2 id="register-heading" className="text-lg font-semibold" style={{ fontFamily: 'var(--disp)' }}>
          {strings.register.heading}
        </h2>
        <p className="mt-2 text-sm" style={{ color: 'var(--soft)' }}>
          {strings.register.noEntity}
        </p>
      </section>
    )
  }

  const entity: Entity | '' = entities.length === 1 ? entities[0] : values.entity
  const currency = entity === '' ? null : CURRENCY_OF[entity]
  const quantity = parseQuantity(values.quantity)
  const priceCents = parsePrice(values.price)

  const set = <K extends keyof FormValues>(key: K, value: FormValues[K], clears?: FieldKey) => {
    setValues((previous) => ({ ...previous, [key]: value }))
    if (clears !== undefined && errors[clears] !== undefined) {
      setErrors((previous) => {
        const next = { ...previous }
        delete next[clears]
        return next
      })
    }
  }

  const breakdown = ((): string | null => {
    if (quantity === null || quantity < 2 || priceCents === null || currency === null) return null
    const prices = splitPrice(priceCents, quantity)
    const each = prices[0]
    const last = prices[prices.length - 1]
    return strings.register.breakdown(
      quantity,
      formatMoney(each, currency),
      last === each ? null : formatMoney(last, currency),
    )
  })()

  const labels: Record<FieldKey, string> = {
    entity: strings.register.fields.entity,
    category: strings.register.fields.category,
    description: strings.register.fields.description,
    purchaseDate: strings.register.fields.purchaseDate,
    price: currency === null ? strings.register.fields.totalPrice : strings.register.fields.totalPriceIn(currency),
    quantity: strings.register.fields.quantity,
    serials: quantity === 1 || quantity === null ? strings.register.fields.serial : strings.register.fields.serials,
  }

  /** Validates the form; returns the request or the field errors. */
  const validate = (): { input: RegisterAssetsInput } | { errors: FieldErrors } => {
    const v = strings.register.validation
    const found: FieldErrors = {}
    if (entity === '') found.entity = { message: v.entityRequired }
    if (values.category === '') found.category = { message: v.categoryRequired }
    if (values.description.trim() === '') found.description = { message: v.required }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(values.purchaseDate)) found.purchaseDate = { message: v.dateInvalid }
    if (priceCents === null) found.price = { message: v.priceInvalid }
    if (quantity === null) found.quantity = { message: v.quantityInvalid }

    const lines = serialLines(values.serials)
    if (quantity !== null && lines.length > 0 && lines.length !== quantity) {
      found.serials = { message: v.serialCount(quantity) }
    } else if (new Set(lines).size !== lines.length) {
      found.serials = { message: v.serialDuplicate }
    }

    if (
      Object.keys(found).length > 0 ||
      entity === '' ||
      values.category === '' ||
      priceCents === null ||
      quantity === null
    ) {
      return { errors: found }
    }

    const input: RegisterAssetsInput = {
      entity,
      category: values.category,
      description: values.description.trim(),
      purchaseDate: values.purchaseDate,
      totalPriceCents: priceCents,
      quantity,
    }
    if (lines.length > 0) input.serialNumbers = lines
    if (values.notReceived) input.received = false
    const supplier = optional(values.supplier)
    const invoiceRef = optional(values.invoiceRef)
    const locationNote = optional(values.locationNote)
    if (supplier) input.supplier = supplier
    if (invoiceRef) input.invoiceRef = invoiceRef
    if (locationNote) input.locationNote = locationNote
    return { input }
  }

  /** Maps a failed POST onto the form (design.md § Error and conflict catalogue). */
  const explain = (error: unknown, sentEntity: Entity): { fields: FieldErrors; failure: Failure | null } => {
    const known = toInventoryError(error)
    if (known?.code === 'serial_conflict') {
      const { serialNumber, assetId } = known.extras
      return {
        fields: {
          serials: {
            message:
              serialNumber === undefined
                ? strings.register.validation.serialConflictNoSerial
                : fillTemplate(strings.errors.serial_conflict, { serialNumber }),
            conflictAssetId: assetId,
          },
        },
        failure: null,
      }
    }
    if (known?.code === 'serial_count_mismatch') {
      return { fields: { serials: { message: strings.errors.serial_count_mismatch } }, failure: null }
    }
    if (known?.code === 'fiscal_year_closed') {
      const { year } = known.extras
      return {
        fields: {
          purchaseDate: {
            message:
              year === undefined
                ? strings.register.validation.yearClosedNoYear
                : fillTemplate(strings.errors.fiscal_year_closed, { year, entity: strings.common.entity[sentEntity] }),
          },
        },
        failure: null,
      }
    }
    if (error instanceof ApiError) {
      if (error.status === 422) {
        const named = validationField(error)
        const target = named === undefined ? undefined : SERVER_FIELDS[named]
        const message = error.detail ?? strings.errors.validation
        if (target !== undefined) return { fields: { [target]: { message } }, failure: null }
        return { fields: {}, failure: { kind: 'text', text: message } }
      }
      if (error.status === 403) {
        return { fields: {}, failure: { kind: 'text', text: strings.register.failure.entityForbidden } }
      }
      if (error.status === 503) return { fields: {}, failure: { kind: 'unavailable' } }
      if (error.status < 500) {
        return { fields: {}, failure: { kind: 'text', text: error.detail ?? strings.errors.unknown } }
      }
    }
    // A network failure, a gateway timeout or a 5xx: the assets may exist already.
    return { fields: {}, failure: { kind: 'text', text: strings.register.failure.unconfirmed } }
  }

  const submit = async () => {
    if (inFlight.current) return
    const result = validate()
    if ('errors' in result) {
      setErrors(result.errors)
      setFailure(null)
      setSummaryFocus((n) => n + 1)
      return
    }
    inFlight.current = true
    setSubmitting(true)
    setErrors({})
    setFailure(null)
    try {
      const { assets } = await registerAssets(result.input)
      const registeredCount = assets.length
      if (registeredCount === 1) {
        await navigate({ to: '/assets/$id', params: { id: assets[0].id }, state: { registeredCount } as never })
      } else {
        await navigate({
          to: '/assets',
          search: (result.input.invoiceRef ? { invoiceRef: result.input.invoiceRef } : {}) as never,
          state: { registeredCount } as never,
        })
      }
    } catch (error) {
      const explained = explain(error, result.input.entity)
      setErrors(explained.fields)
      setFailure(explained.failure)
      if (Object.keys(explained.fields).length > 0) setSummaryFocus((n) => n + 1)
    } finally {
      inFlight.current = false
      setSubmitting(false)
    }
  }

  const onSubmit = (event: FormEvent) => {
    event.preventDefault()
    void submit()
  }

  const summaryItems = ORDER.filter((key) => errors[key] !== undefined).map((key) => ({
    key,
    label: labels[key],
    message: errors[key]!.message,
  }))

  const jump = (key: FieldKey) => document.getElementById(FIELD_IDS[key])?.focus()

  const describedBy = (key: FieldKey, hasHint = false): string | undefined => {
    const ids = [errors[key] ? `${FIELD_IDS[key]}-error` : null, hasHint ? `${FIELD_IDS[key]}-hint` : null].filter(
      (id): id is string => id !== null,
    )
    return ids.length > 0 ? ids.join(' ') : undefined
  }

  const aria = (key: FieldKey, hasHint = false) => ({
    'aria-invalid': errors[key] ? (true as const) : undefined,
    'aria-describedby': describedBy(key, hasHint),
  })

  const received = strings.register.fields

  return (
    <section aria-labelledby="register-heading" data-testid={PAGE_TEST_ID} className="max-w-2xl">
      <h2 id="register-heading" className="text-lg font-semibold" style={{ fontFamily: 'var(--disp)' }}>
        {strings.register.heading}
      </h2>

      <form onSubmit={onSubmit} noValidate className="mt-4 flex flex-col gap-4">
        {summaryItems.length > 0 && (
          <div
            ref={summaryRef}
            role="alert"
            tabIndex={-1}
            data-testid="register-summary"
            className="rounded-md border px-4 py-3 text-sm focus:outline-none focus-visible:ring-2"
            style={{
              borderColor: 'var(--org)',
              backgroundColor: 'color-mix(in srgb, var(--org) 10%, transparent)',
              color: 'var(--org)',
            }}
          >
            <p className="mb-2 font-medium">{strings.register.validation.summaryHeading}</p>
            <ul className="flex flex-col gap-1">
              {summaryItems.map((item) => (
                <li key={item.key}>
                  <a
                    href={`#${FIELD_IDS[item.key]}`}
                    onClick={(event) => {
                      event.preventDefault()
                      jump(item.key)
                    }}
                    className="underline underline-offset-2"
                  >
                    {item.label}
                  </a>
                  {': '}
                  <span>{item.message}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {failure?.kind === 'text' && (
          <p
            role="alert"
            data-testid="register-form-error"
            className="rounded-md border px-4 py-3 text-sm"
            style={{
              borderColor: 'var(--org)',
              backgroundColor: 'color-mix(in srgb, var(--org) 10%, transparent)',
              color: 'var(--org)',
            }}
          >
            {failure.text}
          </p>
        )}
        {failure?.kind === 'unavailable' && <ErrorBanner variant="authUnavailable" onRetry={() => void submit()} />}

        <fieldset disabled={submitting} className="flex min-w-0 flex-col gap-4 border-0 p-0">
          <div className="flex flex-col gap-1">
            {entities.length === 1 ? (
              <>
                <span className="text-xs font-medium" style={{ color: 'var(--soft)' }}>
                  {received.entity}
                </span>
                <p data-testid="register-entity-fixed" className="text-sm" style={{ color: 'var(--text)' }}>
                  {strings.common.entity[entities[0]]}
                </p>
                <p className="text-xs" style={{ color: 'var(--soft)' }}>
                  {strings.register.entityReadOnly}
                </p>
              </>
            ) : (
              <>
                <Label htmlFor={FIELD_IDS.entity} text={received.entity} required />
                <select
                  id={FIELD_IDS.entity}
                  value={values.entity}
                  onChange={(event) => set('entity', event.target.value as Entity | '', 'entity')}
                  className={inputClass}
                  style={inputStyle}
                  {...aria('entity')}
                >
                  <option value="">{received.entityPlaceholder}</option>
                  {entities.map((value) => (
                    <option key={value} value={value}>
                      {strings.common.entity[value]}
                    </option>
                  ))}
                </select>
                <FieldError field="entity" error={errors.entity} />
              </>
            )}
          </div>

          <div className="flex flex-col gap-1">
            <Label htmlFor={FIELD_IDS.category} text={received.category} required />
            <select
              id={FIELD_IDS.category}
              value={values.category}
              onChange={(event) => set('category', event.target.value as AssetCategory | '', 'category')}
              className={inputClass}
              style={inputStyle}
              {...aria('category')}
            >
              <option value="">{received.categoryPlaceholder}</option>
              {CATEGORIES.map((value) => (
                <option key={value} value={value}>
                  {strings.categories[value]}
                </option>
              ))}
            </select>
            <FieldError field="category" error={errors.category} />
          </div>

          <div className="flex flex-col gap-1">
            <Label htmlFor={FIELD_IDS.description} text={received.description} required />
            <input
              id={FIELD_IDS.description}
              type="text"
              value={values.description}
              onChange={(event) => set('description', event.target.value, 'description')}
              className={inputClass}
              style={inputStyle}
              {...aria('description')}
            />
            <FieldError field="description" error={errors.description} />
          </div>

          <div className="flex flex-col gap-1">
            <Label htmlFor={FIELD_IDS.purchaseDate} text={received.purchaseDate} required />
            <input
              id={FIELD_IDS.purchaseDate}
              type="date"
              value={values.purchaseDate}
              onChange={(event) => set('purchaseDate', event.target.value, 'purchaseDate')}
              className={inputClass}
              style={inputStyle}
              {...aria('purchaseDate')}
            />
            <FieldError field="purchaseDate" error={errors.purchaseDate} />
          </div>

          <div className="flex flex-col gap-1">
            <Label htmlFor={FIELD_IDS.price} text={labels.price} required />
            <div className="flex items-center gap-2">
              <input
                id={FIELD_IDS.price}
                type="text"
                inputMode="decimal"
                value={values.price}
                onChange={(event) => set('price', event.target.value, 'price')}
                className={inputClass}
                style={{ ...inputStyle, fontFamily: 'var(--mono)' }}
                {...aria('price')}
              />
              {currency !== null && (
                <span aria-hidden="true" className="text-sm" style={{ color: 'var(--soft)' }}>
                  {currency}
                </span>
              )}
            </div>
            <FieldError field="price" error={errors.price} />
          </div>

          <div className="flex flex-col gap-1">
            <Label htmlFor={FIELD_IDS.quantity} text={received.quantity} required />
            <input
              id={FIELD_IDS.quantity}
              type="number"
              min={1}
              max={MAX_QUANTITY}
              step={1}
              value={values.quantity}
              onChange={(event) => set('quantity', event.target.value, 'quantity')}
              className={inputClass}
              style={inputStyle}
              {...aria('quantity', true)}
            />
            <p id={`${FIELD_IDS.quantity}-hint`} className="text-xs" style={{ color: 'var(--soft)' }}>
              {received.quantityHint}
            </p>
            <FieldError field="quantity" error={errors.quantity} />
            <p
              aria-live="polite"
              data-testid="register-breakdown"
              className="text-sm"
              style={{ color: 'var(--text)', fontFamily: 'var(--mono)' }}
            >
              {breakdown ?? ''}
            </p>
          </div>

          <div className="flex flex-col gap-1">
            <Label htmlFor={FIELD_IDS.serials} text={labels.serials} />
            {quantity !== null && quantity > 1 ? (
              <>
                <textarea
                  id={FIELD_IDS.serials}
                  rows={Math.min(quantity, 8)}
                  value={values.serials}
                  onChange={(event) => set('serials', event.target.value, 'serials')}
                  className={inputClass}
                  style={{ ...inputStyle, fontFamily: 'var(--mono)' }}
                  {...aria('serials', true)}
                />
                <p id={`${FIELD_IDS.serials}-hint`} className="text-xs" style={{ color: 'var(--soft)' }}>
                  {received.serialsHint(quantity)}
                </p>
              </>
            ) : (
              <input
                id={FIELD_IDS.serials}
                type="text"
                value={values.serials}
                onChange={(event) => set('serials', event.target.value, 'serials')}
                className={inputClass}
                style={inputStyle}
                {...aria('serials')}
              />
            )}
            <FieldError field="serials" error={errors.serials} />
          </div>

          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <input
                id="register-received"
                type="checkbox"
                checked={values.notReceived}
                onChange={(event) => set('notReceived', event.target.checked)}
                aria-describedby="register-received-hint"
              />
              <label htmlFor="register-received" className="text-sm" style={{ color: 'var(--text)' }}>
                {received.notReceived}
              </label>
            </div>
            <p id="register-received-hint" className="text-xs" style={{ color: 'var(--soft)' }}>
              {received.notReceivedHint}
            </p>
          </div>

          <div className="flex flex-col gap-1">
            <Label htmlFor="register-supplier" text={received.supplier} />
            <SupplierField
              id="register-supplier"
              value={values.supplier}
              onChange={(value) => set('supplier', value)}
              inputClassName={inputClass}
              inputStyle={inputStyle}
            />
          </div>

          <div className="flex flex-col gap-1">
            <Label htmlFor="register-invoice-ref" text={received.invoiceRef} />
            <input
              id="register-invoice-ref"
              type="text"
              value={values.invoiceRef}
              onChange={(event) => set('invoiceRef', event.target.value)}
              className={inputClass}
              style={inputStyle}
            />
          </div>

          <div className="flex flex-col gap-1">
            <Label htmlFor="register-location-note" text={received.locationNote} />
            <input
              id="register-location-note"
              type="text"
              value={values.locationNote}
              onChange={(event) => set('locationNote', event.target.value)}
              className={inputClass}
              style={inputStyle}
            />
          </div>
        </fieldset>

        <div className="flex items-center gap-3">
          <button
            type="submit"
            aria-busy={submitting || undefined}
            aria-disabled={submitting || undefined}
            className="btn btn-primary"
          >
            {submitting
              ? strings.register.submitting
              : quantity !== null && quantity > 1
                ? strings.register.submitMany(quantity)
                : strings.register.submit}
          </button>
          <button
            type="button"
            onClick={() => void navigate({ to: '/assets', state: { focusRegister: true } as never })}
            className="btn btn-ghost"
          >
            {strings.register.cancel}
          </button>
        </div>
      </form>
    </section>
  )
}
