/**
 * AddressSection — the admin-facing address editor, its states, and the
 * per-employee change-history panel (T11, specs/012-employee-address/tasks.md,
 * refs AC-1.1, AC-1.3, AC-2.2, AC-2.3, AC-2.6, AC-3.1, AC-3.2, AC-3.3, AC-5.3;
 * design.md "Screen C2 extension — AddressSection").
 *
 * Mounted into `UserDetail.tsx` (T12) BEHIND a capability check — this
 * component itself does no `roles` gating (AC-4.2 is the mounting caller's
 * job, per tasks.md T12; UserDetail hides this component entirely for a
 * non-admin rather than this component rendering a disabled/forbidden
 * variant of itself).
 *
 * Structural decision (design.md): NO view/edit toggle. A short read line
 * ("Current address: …" / "No address on file") sits above an
 * ALWAYS-EDITABLE form, pre-filled from the same value — the exact same
 * pattern this page's existing Attributes/Roles/Departments sections already
 * use. The read line updates only on a successful save, never as the admin
 * types.
 *
 * Two consumers of the T10 `Combobox` primitive (design.md "Country control"):
 *   - Street: async, Google-backed, debounced (`../lib/googlePlaces.ts`, T7).
 *   - Country: sync, local filter over the bundled ISO 3166-1 list
 *     (`../lib/addressCopy.ts`, T13), labels via `Intl.DisplayNames`.
 *
 * Coordinate handling (AC-2.5/AC-2.6): `coords` holds whatever a selection
 * last captured; `snapshot` holds the six structured values AS OF that
 * capture. `coordinatesForSave` (T8, a pure function) is the SINGLE decision
 * point — computed fresh from current `fields`/`snapshot`/`coords` at both
 * render time (the visible status line) and submit time (what's actually
 * sent) — so there is no separate "eagerly clear on edit" state to keep in
 * sync; the pure function IS the source of truth both times.
 *
 * AC-3.2 — this component does no failure-mode branching of its own for a
 * degraded suggestion service: `createAddressSuggester` (T7) already never
 * surfaces an error through its callbacks (`onDegraded` fires instead of
 * `onResults`, and is handled here by rendering nothing — no caption, no
 * spinner, no `role="alert"`), so there is nothing here that can leave the
 * field stuck or the save blocked.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import * as addressApi from '../lib/addressApi'
import { ApiError } from '../lib/addressApi'
import type { AddressHistoryEntry, AdminAddressView } from '../lib/addressApi'
import { createAddressSuggester } from '../lib/googlePlaces'
import type { AddressComponents, AddressSuggester, PlaceSuggestion } from '../lib/googlePlaces'
import { coordinatesForSave } from '../lib/addressCoordinates'
import type { LatLng } from '../lib/addressCoordinates'
import {
  GOOGLE_ATTRIBUTION_TEXT,
  ISO_3166_1_ALPHA2_CODES,
  countryDisplayName,
  resolveAddressLocale,
  t,
} from '../lib/addressCopy'
import Combobox from './Combobox'
import type { ComboboxOption } from './Combobox'
import SkeletonListRows from './SkeletonListRows'
import ErrorBanner from './ErrorBanner'

export type AddressSectionProps = {
  userId: string
}

type FormFields = AddressComponents

const EMPTY_FIELDS: FormFields = {
  countryCode: '',
  city: '',
  street: '',
  houseNumber: '',
  postalCode: '',
  region: '',
}

type LoadState =
  | { status: 'loading' }
  | { status: 'loaded'; address: AdminAddressView | null }
  | { status: 'error'; message: string }

type HistoryState =
  | { status: 'loading' }
  | { status: 'loaded'; entries: AddressHistoryEntry[] }
  | { status: 'error'; message: string }

type PreClearSnapshot = {
  fields: FormFields
  snapshot: FormFields | null
  coords: LatLng | null
  countryFilterText: string
}

/** AC-1.4's four required structured components — the only keys `missingFields` can ever name. */
type RequiredFieldKey = 'countryCode' | 'city' | 'street' | 'houseNumber'

/**
 * Fallback message for the address/history GET fetch paths (F1/F5). An
 * `ApiError` always wins (it carries a real server-supplied message);
 * otherwise falls back to the localized `address.loadError` copy key (QE
 * fix — was a hardcoded, always-English literal that ALSO leaked into the
 * unrelated save-failure path below; see `saveErrorMessageFor`).
 */
const loadErrorMessageFor = (error: unknown, locale: ReturnType<typeof resolveAddressLocale>): string => {
  if (error instanceof ApiError) {
    return error.detail ?? error.title
  }
  return t('address.loadError', undefined, locale)
}

/**
 * Fallback message for the `PUT` save path (F2 step 7's "Unexpected
 * failure"). Deliberately a SEPARATE function from `loadErrorMessageFor` (QE
 * fix) — the two states are wired to different `addressCopy.ts` keys
 * (`address.saveError` vs `address.loadError`) because "could not load"
 * copy is simply wrong when what actually failed was a save.
 */
const saveErrorMessageFor = (error: unknown, locale: ReturnType<typeof resolveAddressLocale>): string => {
  if (error instanceof ApiError) {
    return error.detail ?? error.title
  }
  return t('address.saveError', undefined, locale)
}

const fieldsFromAddress = (address: AdminAddressView): FormFields => ({
  countryCode: address.countryCode,
  city: address.city,
  street: address.street,
  houseNumber: address.houseNumber,
  postalCode: address.postalCode ?? '',
  region: address.region ?? '',
})

/** Renders an audit `data.before`/`data.after` side — an address-shaped object with `formatted`, or `null`/absent for "no address on file". */
const formatHistorySide = (value: unknown, locale: ReturnType<typeof resolveAddressLocale>): string => {
  if (value && typeof value === 'object' && 'formatted' in value) {
    const formatted = (value as { formatted?: unknown }).formatted
    if (typeof formatted === 'string' && formatted.length > 0) return formatted
  }
  return t('address.none', undefined, locale)
}

const formatHistoryActor = (actorUserId: string | null, locale: ReturnType<typeof resolveAddressLocale>): string =>
  actorUserId ?? t('address.history.deletedUser', undefined, locale)

const formatHistoryTimestamp = (iso: string): string => {
  try {
    return new Date(iso).toLocaleString(undefined, {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return iso
  }
}

const inputStyle = (invalid: boolean) => ({
  borderColor: invalid ? 'var(--red)' : 'var(--rule)',
  backgroundColor: 'var(--ink-mid)',
  color: 'var(--text)',
})

export default function AddressSection({ userId }: AddressSectionProps) {
  const locale = resolveAddressLocale()
  const reactId = useId()

  const [loadState, setLoadState] = useState<LoadState>({ status: 'loading' })
  const [reloadToken, setReloadToken] = useState(0)

  const [fields, setFields] = useState<FormFields>(EMPTY_FIELDS)
  const [snapshot, setSnapshot] = useState<FormFields | null>(null)
  const [coords, setCoords] = useState<LatLng | null>(null)
  const [countryFilterText, setCountryFilterText] = useState('')

  const [streetSuggestions, setStreetSuggestions] = useState<PlaceSuggestion[]>([])
  const [streetPopupOpen, setStreetPopupOpen] = useState(false)
  const [streetCaption, setStreetCaption] = useState<'searching' | 'no-results' | null>(null)
  const [countryPopupOpen, setCountryPopupOpen] = useState(false)

  const [missingFields, setMissingFields] = useState<ReadonlySet<string>>(new Set())
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const [pendingClear, setPendingClear] = useState(false)
  const preClearRef = useRef<PreClearSnapshot | null>(null)

  const [historyState, setHistoryState] = useState<HistoryState>({ status: 'loading' })
  const [historyReloadToken, setHistoryReloadToken] = useState(0)

  const houseNumberInputRef = useRef<HTMLInputElement | null>(null)

  // -------------------------------------------------------------------------
  // The Google Places suggester (T7) — created once. Its callbacks only ever
  // call stable setState functions, so no dependency array is needed and no
  // stale-closure risk exists (React setState setters have a stable identity
  // across renders).
  // -------------------------------------------------------------------------
  const [suggester] = useState<AddressSuggester>(() =>
    createAddressSuggester({
      language: locale,
      onSearchStart: () => {
        setStreetCaption('searching')
      },
      onResults: (suggestions) => {
        setStreetSuggestions(suggestions)
        setStreetPopupOpen(suggestions.length > 0)
        setStreetCaption(suggestions.length === 0 ? 'no-results' : null) // AC-3.1 — a GENUINE, completed zero-result search
      },
      onDegraded: () => {
        // AC-3.2 — deliberately nothing: no caption, no popup, no error, no
        // spinner. The field is left exactly as an ordinary text input.
        setStreetSuggestions([])
        setStreetPopupOpen(false)
        setStreetCaption(null)
      },
      onBelowThreshold: () => {
        setStreetSuggestions([])
        setStreetPopupOpen(false)
        setStreetCaption(null)
      },
    }),
  )

  useEffect(() => () => suggester.dispose(), [suggester])

  // -------------------------------------------------------------------------
  // Fetch — GET /admin/users/:id/address (F1). Promise-chain-in-effect
  // (mirrors UserDetail.tsx/AuditPage.tsx's documented
  // react-hooks/set-state-in-effect rationale).
  // -------------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false

    Promise.resolve()
      .then(() => {
        if (!cancelled) setLoadState({ status: 'loading' })
      })
      .then(() => addressApi.getAddress(userId))
      .then((response) => {
        if (cancelled) return
        setLoadState({ status: 'loaded', address: response.address })
        if (response.address) {
          const loadedFields = fieldsFromAddress(response.address)
          setFields(loadedFields)
          setCountryFilterText(loadedFields.countryCode ? countryDisplayName(loadedFields.countryCode, locale) : '')
          if (response.address.latitude != null && response.address.longitude != null) {
            setSnapshot(loadedFields)
            setCoords({ lat: response.address.latitude, lng: response.address.longitude })
          } else {
            setSnapshot(null)
            setCoords(null)
          }
        } else {
          setFields(EMPTY_FIELDS)
          setCountryFilterText('')
          setSnapshot(null)
          setCoords(null)
        }
        setMissingFields(new Set())
        setPendingClear(false)
        preClearRef.current = null
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadState({ status: 'error', message: loadErrorMessageFor(error, locale) })
      })

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, reloadToken])

  // -------------------------------------------------------------------------
  // History — GET /admin/audit?targetType=user&targetId=…&action=user.address.set (F5, AC-5.3).
  // Independent fetch: a slow/failed history load must never block the form above it.
  // -------------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false

    Promise.resolve()
      .then(() => {
        if (!cancelled) setHistoryState({ status: 'loading' })
      })
      .then(() => addressApi.listAddressHistory(userId))
      .then((page) => {
        if (!cancelled) setHistoryState({ status: 'loaded', entries: page.items })
      })
      .catch((error: unknown) => {
        if (!cancelled) setHistoryState({ status: 'error', message: loadErrorMessageFor(error, locale) })
      })

    return () => {
      cancelled = true
    }
  }, [userId, historyReloadToken, locale])

  const handleRetry = useCallback(() => setReloadToken((n) => n + 1), [])
  const handleHistoryRetry = useCallback(() => setHistoryReloadToken((n) => n + 1), [])

  // -------------------------------------------------------------------------
  // Street combobox wiring (AC-2.1, AC-2.2, AC-2.4, AC-2.5)
  // -------------------------------------------------------------------------

  const handleStreetValueChange = useCallback(
    (value: string) => {
      setFields((prev) => ({ ...prev, street: value }))
      suggester.search(value)
    },
    [suggester],
  )

  const streetOptions: ComboboxOption[] = useMemo(
    () => streetSuggestions.map((s) => ({ id: s.id, label: s.mainText, secondaryLabel: s.secondaryText })),
    [streetSuggestions],
  )

  const handleStreetSelect = useCallback(
    (option: ComboboxOption) => {
      void (async () => {
        const details = await suggester.selectSuggestion(option.id)
        if (!details) return // AC-3.2 — details fetch failed; leave the field exactly as typed, no error
        setFields((prev) => ({ ...prev, ...details.components }))
        setSnapshot({ ...details.components })
        setCoords(
          details.latitude !== null && details.longitude !== null
            ? { lat: details.latitude, lng: details.longitude }
            : null,
        )
        setCountryFilterText(
          details.components.countryCode ? countryDisplayName(details.components.countryCode, locale) : '',
        )
        setStreetSuggestions([])
        setStreetPopupOpen(false)
        setStreetCaption(null)
        // R9 — a route-level prediction often carries no house number; move
        // focus there so the admin's next keystroke fills the one thing
        // still missing. Otherwise focus already stayed on Street (Combobox's
        // own behavior) — nothing further to do.
        if (!details.components.houseNumber) {
          houseNumberInputRef.current?.focus()
        }
      })()
    },
    [locale, suggester],
  )

  const streetLiveRegionText = useMemo(() => {
    if (streetCaption === 'no-results') return t('address.suggest.noResultsAnnounce', undefined, locale)
    if (streetSuggestions.length > 0) return t('address.suggest.resultCount', { n: streetSuggestions.length }, locale)
    return ''
  }, [streetCaption, streetSuggestions.length, locale])

  // -------------------------------------------------------------------------
  // Country combobox wiring — sync, local, never Google-backed (design.md
  // "Country control")
  // -------------------------------------------------------------------------

  const countryOptions: ComboboxOption[] = useMemo(() => {
    const query = countryFilterText.trim().toLowerCase()
    const withLabels = ISO_3166_1_ALPHA2_CODES.map((code) => ({ id: code, label: countryDisplayName(code, locale) }))
    if (query === '') return withLabels
    return withLabels.filter((option) => option.label.toLowerCase().includes(query))
  }, [countryFilterText, locale])

  const handleCountrySelect = useCallback((option: ComboboxOption) => {
    setFields((prev) => ({ ...prev, countryCode: option.id }))
    setCountryFilterText(option.label)
    setCountryPopupOpen(false)
  }, [])

  const handleCountryBlur = useCallback(() => {
    setCountryPopupOpen(false)
    setCountryFilterText(fields.countryCode ? countryDisplayName(fields.countryCode, locale) : '')
  }, [fields.countryCode, locale])

  const countryLiveRegionText = useMemo(() => {
    if (!countryPopupOpen) return ''
    return countryOptions.length > 0
      ? t('address.country.resultCount', { n: countryOptions.length }, locale)
      : t('address.country.noMatch', undefined, locale)
  }, [countryPopupOpen, countryOptions.length, locale])

  // -------------------------------------------------------------------------
  // Plain field handlers (AC-2.3 — hand-edits after a selection persist)
  // -------------------------------------------------------------------------

  const handleFieldChange = useCallback(
    (key: keyof FormFields) => (e: React.ChangeEvent<HTMLInputElement>) => {
      const { value } = e.target
      setFields((prev) => ({ ...prev, [key]: value }))
    },
    [],
  )

  // -------------------------------------------------------------------------
  // Coordinate-staleness status (AC-2.6) — a pure derivation, recomputed
  // every render from fields/snapshot/coords; no separate state to drift.
  // -------------------------------------------------------------------------

  const coordsForSave = coordinatesForSave(fields, snapshot, coords)
  const coordStatus: 'captured' | 'cleared' | 'none' =
    coordsForSave.latitude !== null ? 'captured' : snapshot !== null && coords !== null ? 'cleared' : 'none'

  // -------------------------------------------------------------------------
  // Save / Clear (F2 step 7, F3)
  // -------------------------------------------------------------------------

  const hasAnyFieldContent = Object.values(fields).some((v) => v.trim() !== '')
  const canSave = !saving && (pendingClear || hasAnyFieldContent)
  const hasStoredAddress = loadState.status === 'loaded' && loadState.address !== null

  const handleClearRequest = useCallback(() => {
    preClearRef.current = { fields, snapshot, coords, countryFilterText }
    setPendingClear(true)
  }, [fields, snapshot, coords, countryFilterText])

  const handleUndoClear = useCallback(() => {
    const pre = preClearRef.current
    if (!pre) return
    setFields(pre.fields)
    setSnapshot(pre.snapshot)
    setCoords(pre.coords)
    setCountryFilterText(pre.countryFilterText)
    setPendingClear(false)
    preClearRef.current = null
  }, [])

  const handleSave = useCallback(() => {
    setSaving(true)
    setSaveError(null)

    const input = pendingClear
      ? null
      : {
          countryCode: fields.countryCode.trim().toUpperCase(),
          city: fields.city.trim(),
          street: fields.street.trim(),
          houseNumber: fields.houseNumber.trim(),
          postalCode: fields.postalCode.trim() === '' ? null : fields.postalCode.trim(),
          region: fields.region.trim() === '' ? null : fields.region.trim(),
          latitude: coordsForSave.latitude,
          longitude: coordsForSave.longitude,
        }

    addressApi
      .putAddress(userId, input)
      .then((response) => {
        setSaving(false)
        setMissingFields(new Set())
        setLoadState({ status: 'loaded', address: response.address })
        if (response.address) {
          const loadedFields = fieldsFromAddress(response.address)
          setFields(loadedFields)
          setCountryFilterText(loadedFields.countryCode ? countryDisplayName(loadedFields.countryCode, locale) : '')
          if (response.address.latitude != null && response.address.longitude != null) {
            setSnapshot(loadedFields)
            setCoords({ lat: response.address.latitude, lng: response.address.longitude })
          } else {
            setSnapshot(null)
            setCoords(null)
          }
        } else {
          setFields(EMPTY_FIELDS)
          setCountryFilterText('')
          setSnapshot(null)
          setCoords(null)
        }
        setPendingClear(false)
        preClearRef.current = null
        setHistoryReloadToken((n) => n + 1) // AC-5.3 — the history panel gains a new row
      })
      .catch((error: unknown) => {
        setSaving(false)
        if (error instanceof ApiError && error.status === 422 && error.code === 'address_incomplete') {
          setMissingFields(new Set(error.missingFields ?? []))
          return
        }
        setSaveError(saveErrorMessageFor(error, locale))
      })
  }, [userId, fields, pendingClear, coordsForSave, locale])

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  const streetInputId = `address-street-${reactId}`
  const countryInputId = `address-country-${reactId}`
  const cityInputId = `address-city-${reactId}`
  const houseNumberInputId = `address-housenumber-${reactId}`
  const postalCodeInputId = `address-postalcode-${reactId}`
  const regionInputId = `address-region-${reactId}`

  const requiredMark = (
    <>
      {' '}
      <span aria-hidden="true" style={{ color: 'var(--red)' }}>
        *
      </span>
      <span className="sr-only">{t('address.field.requiredMark', undefined, locale)}</span>
    </>
  )

  const fieldError = (key: RequiredFieldKey, describedById: string) =>
    missingFields.has(key) ? (
      <p id={describedById} role="alert" data-testid={`address-error-${key}`} className="text-xs mt-1" style={{ color: 'var(--red)' }}>
        {t('address.field.requiredError', undefined, locale)}
      </p>
    ) : null

  return (
    <div className="border-t pt-4" style={{ borderColor: 'var(--rule)' }} data-testid="address-section">
      <h3 className="text-sm font-semibold mb-3" style={{ color: 'var(--text)' }}>
        {t('address.sectionTitle', undefined, locale)}
      </h3>

      {loadState.status === 'loading' && (
        <>
          <p className="sr-only" aria-live="polite">
            {t('address.loading', undefined, locale)}
          </p>
          <SkeletonListRows rows={2} />
        </>
      )}

      {loadState.status === 'error' && <ErrorBanner message={loadState.message} onRetry={handleRetry} />}

      {loadState.status === 'loaded' && (
        <div className="flex flex-col gap-3 max-w-md">
          <p className="text-sm" data-testid="address-current-line" style={{ color: 'var(--soft)' }}>
            {loadState.address
              ? t('address.currentLabel', { formatted: loadState.address.formatted }, locale)
              : t('address.none', undefined, locale)}
          </p>

          {/* Street — the Google-backed combobox */}
          <div>
            <label htmlFor={streetInputId} className="block text-xs font-medium mb-1" style={{ color: 'var(--soft)' }}>
              {t('address.field.street', undefined, locale)}
              {requiredMark}
            </label>
            <Combobox
              id={streetInputId}
              value={fields.street}
              onValueChange={handleStreetValueChange}
              options={streetOptions}
              onSelect={handleStreetSelect}
              isOpen={streetPopupOpen}
              onOpenChange={setStreetPopupOpen}
              disabled={pendingClear}
              ariaInvalid={missingFields.has('street')}
              ariaDescribedBy={missingFields.has('street') ? `${streetInputId}-error` : undefined}
              liveRegionText={streetLiveRegionText}
              testId="address-street-combobox"
              footer={
                streetPopupOpen && streetOptions.length > 0 ? (
                  <li aria-hidden="true" className="px-3 py-1.5 text-[10px] border-t" style={{ borderColor: 'var(--rule)', color: 'var(--muted)' }}>
                    {/* Google's required attribution when predictions render without a map (Places API terms). Text
                        placeholder for the branded "Powered by Google" light/dark asset, which must be sourced from
                        Google's Maps Platform branding kit (design.md "Google attribution" / plan.md gap #1, routed
                        to devops/infra follow-up). The TEXT itself is deliberately NOT a `addressCopy.ts` `COPY`
                        entry — `GOOGLE_ATTRIBUTION_TEXT` is its own non-localized constant (QE fix; see that
                        constant's doc comment for why "Powered by Google" must never be translated). */}
                    {GOOGLE_ATTRIBUTION_TEXT}
                  </li>
                ) : undefined
              }
            />
            {streetCaption === 'searching' && (
              <p className="text-xs mt-1" style={{ color: 'var(--soft)' }} data-testid="address-street-searching">
                {t('address.suggest.searching', undefined, locale)}
              </p>
            )}
            {streetCaption === 'no-results' && (
              <p className="text-xs mt-1" style={{ color: 'var(--soft)' }} data-testid="address-street-no-results">
                {t('address.suggest.noResults', undefined, locale)}
              </p>
            )}
            {fieldError('street', `${streetInputId}-error`)}
          </div>

          {/* House / building number */}
          <div>
            <label htmlFor={houseNumberInputId} className="block text-xs font-medium mb-1" style={{ color: 'var(--soft)' }}>
              {t('address.field.houseNumber', undefined, locale)}
              {requiredMark}
            </label>
            <input
              ref={houseNumberInputRef}
              id={houseNumberInputId}
              type="text"
              value={fields.houseNumber}
              onChange={handleFieldChange('houseNumber')}
              aria-invalid={missingFields.has('houseNumber')}
              aria-describedby={missingFields.has('houseNumber') ? `${houseNumberInputId}-error` : undefined}
              aria-disabled={pendingClear || undefined}
              readOnly={pendingClear}
              data-testid="address-housenumber-input"
              className="w-full border rounded-md px-3 py-2 text-sm"
              style={inputStyle(missingFields.has('houseNumber'))}
            />
            {fieldError('houseNumber', `${houseNumberInputId}-error`)}
          </div>

          {/* Postal code — optional */}
          <div>
            <label htmlFor={postalCodeInputId} className="block text-xs font-medium mb-1" style={{ color: 'var(--soft)' }}>
              {t('address.field.postalCode', undefined, locale)}
            </label>
            <input
              id={postalCodeInputId}
              type="text"
              value={fields.postalCode}
              onChange={handleFieldChange('postalCode')}
              aria-disabled={pendingClear || undefined}
              readOnly={pendingClear}
              data-testid="address-postalcode-input"
              className="w-full border rounded-md px-3 py-2 text-sm"
              style={inputStyle(false)}
            />
          </div>

          {/* City */}
          <div>
            <label htmlFor={cityInputId} className="block text-xs font-medium mb-1" style={{ color: 'var(--soft)' }}>
              {t('address.field.city', undefined, locale)}
              {requiredMark}
            </label>
            <input
              id={cityInputId}
              type="text"
              value={fields.city}
              onChange={handleFieldChange('city')}
              aria-invalid={missingFields.has('city')}
              aria-describedby={missingFields.has('city') ? `${cityInputId}-error` : undefined}
              aria-disabled={pendingClear || undefined}
              readOnly={pendingClear}
              data-testid="address-city-input"
              className="w-full border rounded-md px-3 py-2 text-sm"
              style={inputStyle(missingFields.has('city'))}
            />
            {fieldError('city', `${cityInputId}-error`)}
          </div>

          {/* Region / canton / state — optional */}
          <div>
            <label htmlFor={regionInputId} className="block text-xs font-medium mb-1" style={{ color: 'var(--soft)' }}>
              {t('address.field.region', undefined, locale)}
            </label>
            <input
              id={regionInputId}
              type="text"
              value={fields.region}
              onChange={handleFieldChange('region')}
              aria-disabled={pendingClear || undefined}
              readOnly={pendingClear}
              data-testid="address-region-input"
              className="w-full border rounded-md px-3 py-2 text-sm"
              style={inputStyle(false)}
            />
          </div>

          {/* Country — the local, non-Google combobox (design.md "Country control") */}
          <div>
            <label htmlFor={countryInputId} className="block text-xs font-medium mb-1" style={{ color: 'var(--soft)' }}>
              {t('address.field.country', undefined, locale)}
              {requiredMark}
            </label>
            <Combobox
              id={countryInputId}
              value={countryFilterText}
              onValueChange={(value) => {
                setCountryFilterText(value)
                setCountryPopupOpen(true)
              }}
              options={countryOptions}
              onSelect={handleCountrySelect}
              isOpen={countryPopupOpen}
              onOpenChange={setCountryPopupOpen}
              onFocus={() => setCountryPopupOpen(true)}
              onBlur={handleCountryBlur}
              disabled={pendingClear}
              placeholder={t('address.country.placeholder', undefined, locale)}
              ariaInvalid={missingFields.has('countryCode')}
              ariaDescribedBy={missingFields.has('countryCode') ? `${countryInputId}-error` : undefined}
              emptyState={t('address.country.noMatch', undefined, locale)}
              liveRegionText={countryLiveRegionText}
              testId="address-country-combobox"
            />
            {fieldError('countryCode', `${countryInputId}-error`)}
          </div>

          {/* Coordinate-staleness status (AC-2.6) — calm, aria-live="polite", never styled as an error */}
          <p className="text-xs" aria-live="polite" data-testid="address-coords-status" style={{ color: 'var(--soft)' }}>
            {coordStatus === 'captured' && t('address.coords.captured', undefined, locale)}
            {coordStatus === 'cleared' && t('address.coords.cleared', undefined, locale)}
            {coordStatus === 'none' && t('address.coords.none', undefined, locale)}
          </p>

          {pendingClear && (
            <p className="text-xs" aria-live="polite" style={{ color: 'var(--soft)' }} data-testid="address-clear-pending-notice">
              {t('address.clearPending', undefined, locale)}{' '}
              <button
                type="button"
                onClick={handleUndoClear}
                data-testid="address-clear-undo"
                className="underline transition-opacity hover:opacity-80"
                style={{ color: 'var(--acc)' }}
              >
                {t('address.clearUndo', undefined, locale)}
              </button>
            </p>
          )}

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={handleSave}
              disabled={!canSave}
              data-testid="address-save-button"
              className="text-sm font-medium border px-3 py-1.5 transition-opacity hover:opacity-80 disabled:opacity-40 disabled:cursor-not-allowed"
              style={{ borderColor: 'var(--acc)', color: 'var(--acc)' }}
            >
              {saving ? t('address.saving', undefined, locale) : t('address.save', undefined, locale)}
            </button>

            {hasStoredAddress && !pendingClear && (
              <button
                type="button"
                onClick={handleClearRequest}
                disabled={saving}
                data-testid="address-clear-button"
                className="text-sm font-medium border px-3 py-1.5 transition-opacity hover:opacity-80 disabled:opacity-40 disabled:cursor-not-allowed"
                style={{ borderColor: 'var(--rule)', color: 'var(--soft)' }}
              >
                {t('address.clear', undefined, locale)}
              </button>
            )}
          </div>

          {saveError && (
            <p role="alert" data-testid="address-save-error" className="text-sm" style={{ color: 'var(--org)' }}>
              {saveError}
            </p>
          )}

          {/* History panel (F5, AC-5.3) — independent load/error state */}
          <div className="border-t pt-3 mt-2" style={{ borderColor: 'var(--rule)' }} data-testid="address-history-panel">
            <h4 className="text-xs font-semibold mb-2" style={{ color: 'var(--text)' }}>
              {t('address.history.title', undefined, locale)}
            </h4>

            {historyState.status === 'loading' && <SkeletonListRows rows={2} />}

            {historyState.status === 'error' && (
              <ErrorBanner message={historyState.message} onRetry={handleHistoryRetry} retryLabel={t('address.retry', undefined, locale)} />
            )}

            {historyState.status === 'loaded' && historyState.entries.length === 0 && (
              <p className="text-xs" style={{ color: 'var(--soft)' }} data-testid="address-history-empty">
                {t('address.history.empty', undefined, locale)}
              </p>
            )}

            {historyState.status === 'loaded' && historyState.entries.length > 0 && (
              <ul className="flex flex-col gap-2">
                {historyState.entries.map((entry) => (
                  <li key={entry.id} data-testid={`address-history-entry-${entry.id}`} className="text-xs" style={{ color: 'var(--text)' }}>
                    <span style={{ color: 'var(--soft)' }}>
                      {/* sr-only column labels (design.md "Changed by / Changed on / Previous → New") — the visible
                          layout is a compact, un-headered list (design.md: "not necessarily a full paginated
                          <table>"), but a screen-reader user still benefits from knowing which value is which. */}
                      <span className="sr-only">{t('address.history.columns.changedBy', undefined, locale)}: </span>
                      {formatHistoryActor(entry.actorUserId, locale)}
                      {' · '}
                      <span className="sr-only">{t('address.history.columns.changedOn', undefined, locale)}: </span>
                      {formatHistoryTimestamp(entry.createdAt)}
                    </span>
                    <br />
                    <span className="sr-only">{t('address.history.columns.previous', undefined, locale)}: </span>
                    {formatHistorySide(entry.data?.before, locale)}
                    {' → '}
                    <span className="sr-only">{t('address.history.columns.new', undefined, locale)}: </span>
                    {formatHistorySide(entry.data?.after, locale)}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
