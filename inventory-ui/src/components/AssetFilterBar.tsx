/**
 * AssetFilterBar — the Assets list's filter form (T29, specs/015-hardware-
 * inventory; design.md § T1, F7, § Accessibility "T1 list"; Resolutions Q5).
 *
 * Controlled and presentational: it renders `values` (which the page reads
 * from the URL search params) and reports every change as a patch through
 * `onChange`; it never fetches. A labelled `form role="search"`, every control
 * with a visible label. Tab order is the design's: the free-text search first
 * (AC-3.8), then Status, Category, Entity, Holder, "To verify" and the invoice
 * reference.
 *
 * Gating (absent from the DOM, never disabled):
 *   - Entity only with two or more `entities` in scope;
 *   - Holder only with `canFilterByHolder` (`asset:manage`, design Q6).
 *
 * The two text inputs (search, invoice reference) are debounced: they report
 * after a 300 ms pause, and the invoice reference also on Enter. The typed
 * text is local state so a keystroke is never lost to a slower URL update; it
 * re-syncs from `values` only when the value changes from OUTSIDE (Clear
 * filters, browser back) — an echo of what this field just committed is ignored.
 */

import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { strings } from '../strings'
import type { AssetCategory, AssetStatus, Entity } from '../lib/types'

export type AssetFilterValues = {
  status?: AssetStatus
  category?: AssetCategory
  entity?: Entity
  holderUserId?: string
  toVerify: boolean
  invoiceRef: string
  q: string
}

/** What one change reports. A cleared filter is its key with `undefined` (text fields: ''). */
export type AssetFilterPatch = Partial<{
  status: AssetStatus | undefined
  category: AssetCategory | undefined
  entity: Entity | undefined
  holderUserId: string | undefined
  toVerify: boolean
  invoiceRef: string
  q: string
}>

export type AssetFilterBarProps = {
  values: AssetFilterValues
  /** The entities in scope; the Entity filter shows only when there are two or more. */
  entities: readonly Entity[]
  canFilterByHolder: boolean
  holderOptions: readonly { id: string; label: string }[]
  holderLoading?: boolean
  onChange: (patch: AssetFilterPatch) => void
  /** Debounce of the text inputs in ms. */
  debounceMs?: number
}

const STATUSES = Object.keys(strings.badges.assetStatus) as AssetStatus[]
const CATEGORIES = Object.keys(strings.categories) as AssetCategory[]

const CONTROL_CLASS = 'rounded border px-2 py-1.5 text-sm'
const CONTROL_STYLE = { borderColor: 'var(--rule)', backgroundColor: 'var(--ink-soft)', color: 'var(--text)' }

function Field({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs font-medium" style={{ color: 'var(--soft)' }}>
        {label}
      </label>
      {children}
    </div>
  )
}

type SelectProps<V extends string> = {
  id: string
  label: string
  value: V | undefined
  options: readonly { value: V; label: string }[]
  anyLabel: string
  onChange: (value: V | undefined) => void
}

function SelectFilter<V extends string>({ id, label, value, options, anyLabel, onChange }: SelectProps<V>) {
  return (
    <Field id={id} label={label}>
      <select
        id={id}
        value={value ?? ''}
        onChange={(event) => onChange(event.target.value === '' ? undefined : (event.target.value as V))}
        className={CONTROL_CLASS}
        style={CONTROL_STYLE}
      >
        <option value="">{anyLabel}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </Field>
  )
}

type TextFilterProps = {
  id: string
  label: string
  value: string
  placeholder?: string
  debounceMs: number
  /** Also commit at once on Enter. */
  commitOnEnter?: boolean
  onCommit: (text: string) => void
}

function TextFilter({ id, label, value, placeholder, debounceMs, commitOnEnter = false, onCommit }: TextFilterProps) {
  const [draft, setDraft] = useState(value)
  const [seenValue, setSeenValue] = useState(value)
  const [lastCommitted, setLastCommitted] = useState(value)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Adopt an external change of `value` (Clear filters, back) but not the echo of our own commit.
  if (value !== seenValue) {
    setSeenValue(value)
    if (value !== lastCommitted) {
      setDraft(value)
      setLastCommitted(value)
    }
  }

  const cancelTimer = () => {
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = null
  }
  useEffect(() => cancelTimer, [])

  const commit = (text: string) => {
    cancelTimer()
    const next = text.trim()
    if (next === lastCommitted) return
    setLastCommitted(next)
    onCommit(next)
  }

  return (
    <Field id={id} label={label}>
      <input
        id={id}
        type="text"
        value={draft}
        placeholder={placeholder}
        autoComplete="off"
        onChange={(event) => {
          const text = event.target.value
          setDraft(text)
          cancelTimer()
          timer.current = setTimeout(() => commit(text), debounceMs)
        }}
        onKeyDown={(event) => {
          if (commitOnEnter && event.key === 'Enter') {
            event.preventDefault()
            commit(draft)
          }
        }}
        className={CONTROL_CLASS}
        style={CONTROL_STYLE}
      />
    </Field>
  )
}

export default function AssetFilterBar({
  values,
  entities,
  canFilterByHolder,
  holderOptions,
  holderLoading = false,
  onChange,
  debounceMs = 300,
}: AssetFilterBarProps) {
  const t = strings.assets.filters
  const holderListed = holderOptions.some((option) => option.id === values.holderUserId)

  return (
    <form
      role="search"
      aria-label={t.landmarkLabel}
      onSubmit={(event) => event.preventDefault()}
      className="grid grid-cols-1 gap-3 sm:flex sm:flex-wrap sm:items-end"
      data-testid="asset-filter-bar"
    >
      <TextFilter
        id="asset-filter-q"
        label={t.search}
        value={values.q}
        placeholder={t.searchPlaceholder}
        debounceMs={debounceMs}
        onCommit={(q) => onChange({ q })}
      />

      <SelectFilter<AssetStatus>
        id="asset-filter-status"
        label={t.status}
        value={values.status}
        options={STATUSES.map((value) => ({ value, label: strings.badges.assetStatus[value] }))}
        anyLabel={t.any}
        onChange={(status) => onChange({ status })}
      />

      <SelectFilter<AssetCategory>
        id="asset-filter-category"
        label={t.category}
        value={values.category}
        options={CATEGORIES.map((value) => ({ value, label: strings.categories[value] }))}
        anyLabel={t.any}
        onChange={(category) => onChange({ category })}
      />

      {entities.length > 1 && (
        <SelectFilter<Entity>
          id="asset-filter-entity"
          label={t.entity}
          value={values.entity}
          options={entities.map((value) => ({ value, label: strings.common.entity[value] }))}
          anyLabel={t.any}
          onChange={(entity) => onChange({ entity })}
        />
      )}

      {canFilterByHolder && (
        <SelectFilter<string>
          id="asset-filter-holder"
          label={t.holder}
          value={values.holderUserId}
          options={[
            ...holderOptions.map((option) => ({ value: option.id, label: option.label })),
            ...(values.holderUserId !== undefined && !holderListed && !holderLoading
              ? [{ value: values.holderUserId, label: t.holderUnknown }]
              : []),
          ]}
          anyLabel={holderLoading ? t.holderLoading : t.holderAny}
          onChange={(holderUserId) => onChange({ holderUserId })}
        />
      )}

      <div className="flex items-center gap-2 pb-2">
        <input
          id="asset-filter-to-verify"
          type="checkbox"
          checked={values.toVerify}
          onChange={(event) => onChange({ toVerify: event.target.checked })}
        />
        <label htmlFor="asset-filter-to-verify" className="text-sm" style={{ color: 'var(--text)' }}>
          {t.toVerify}
        </label>
      </div>

      <TextFilter
        id="asset-filter-invoice-ref"
        label={t.invoiceRef}
        value={values.invoiceRef}
        debounceMs={debounceMs}
        commitOnEnter
        onCommit={(invoiceRef) => onChange({ invoiceRef })}
      />
    </form>
  )
}
