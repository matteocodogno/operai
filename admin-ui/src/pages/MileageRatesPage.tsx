import { useCallback, useEffect, useRef, useState } from 'react'
import * as adminApi from '../lib/adminApi'
import * as ratesApi from '../lib/ratesApi'
import { ApiError } from '../lib/ratesApi'
import type { MileageRateEntity, RatesResult } from '../lib/ratesApi'
import SkeletonListRows from '../components/SkeletonListRows'
import ErrorBanner from '../components/ErrorBanner'
import PermissionDenied from '../components/PermissionDenied'
import RateInEffectBadge from '../components/RateInEffectBadge'
import AddRateEntryModal from '../components/AddRateEntryModal'

/**
 * MileageRatesPage — Screen ADM-1 (Mileage Rates) + Modal ADM-M1 (Add rate
 * entry) — T11, specs/009-mileage-rate/tasks.md, refs AC-4.1, AC-4.2, AC-4.3,
 * AC-4.5, AC-4.6, AC-5.3.
 *
 * NEW screen — no existing admin-ui page covers this domain; closest
 * siblings (RolesPage/DepartmentsPage) are single-table, this is TWO
 * independent per-entity tables (WellD CH, WellD Italia — AC-2.3's
 * independence reflected structurally, not just logically) each with its
 * own "+ Add rate entry" action (design.md F5). No edit/delete affordance
 * anywhere (AC-4.7, mirrors AuditPage.tsx's own precedent for a non-mutable
 * record type) — the "Added by"/"Added on" columns already visible on every
 * row double as the audit view (AC-5.3, F6 — same payload, no separate tab).
 *
 * States mirror every other admin-ui list screen (design.md "L/E/P/Err",
 * plus a per-entity Empty), with a NEW "Forbidden" 403 branch that carries a
 * section-specific `PermissionDenied` message (design.md's flagged gap — the
 * first section-level, rather than whole-tool, 403 in this app):
 *   L    — SkeletonListRows under each entity heading (one GET /rates call
 *          populates both).
 *   Forbidden — GET /rates → 403 (missing `rate:read`), or the route reached
 *          without it: PermissionDenied in place of both tables (design.md
 *          F7's reactive/defense-in-depth path — the proactive path is
 *          SectionNav.tsx hiding the nav entry entirely).
 *   Err  — ErrorBanner + Retry (mirrors RolesPage.tsx/AuditPage.tsx).
 *   Empty (per entity) — "No rate configured yet for {entity}." (no CTA of
 *          its own — the entity header's "+ Add rate entry" button already
 *          serves this, so a second button here would be redundant).
 *   Populated (per entity) — Rate / Valid from / Added by / Added on /
 *          Status table; the `inEffectToday` row carries `RateInEffectBadge`.
 *
 * `rate:manage` (whether "+ Add rate entry" renders at all — design.md F5
 * step 2) is resolved via `adminApi.getMe()` — the SAME `GET /authz/me` call
 * SectionNav.tsx uses for its own proactive `rate:read` nav gate — fetched
 * independently here (this screen's own data-fetch, matching every other
 * admin-ui screen's "each page owns its own fetch" convention) and fails
 * CLOSED (button hidden, not a crash) if that call itself fails: UX-only,
 * never the actual security boundary (that is refund-api's server-side
 * `rate:manage` gate on `POST /rates`, plan.md Security section).
 *
 * Fetch pattern: an explicit Promise chain rather than an async/await helper
 * invoked from `useEffect` — mirrors RolesPage.tsx/AuditPage.tsx's own
 * documented rationale (`react-hooks/set-state-in-effect` static analysis).
 */

const ENTITY_CONFIG: Record<MileageRateEntity, { label: string; flag: string }> = {
  welld_ch: { label: 'WellD CH', flag: '🇨🇭' },
  welld_it: { label: 'WellD Italia', flag: '🇮🇹' },
}

const ENTITY_ORDER: MileageRateEntity[] = ['welld_ch', 'welld_it']

type ListState =
  | { status: 'loading' }
  | { status: 'loaded'; result: RatesResult; canManage: boolean }
  | { status: 'error'; message: string }
  | { status: 'forbidden' }

type AddModalState =
  | { open: false }
  | {
      open: true
      entity: MileageRateEntity
      rate: string
      validFrom: string
      submitting: boolean
      rateError: string | null
      validFromError: string | null
      generalError: string | null
    }

const errorMessageFor = (error: unknown): string => {
  if (error instanceof ApiError) {
    return error.detail ?? error.title
  }
  return 'Could not load the mileage rates.'
}

/** Whether `permissions` contains the given (resource, action) pair. */
const hasCapability = (
  permissions: { resource: string; action: string }[],
  resource: string,
  action: string,
): boolean => permissions.some((p) => p.resource === resource && p.action === action)

/**
 * Maps a `POST /rates` 422 onto a field (AC-4.5's "clear message"). plan.md
 * documents no `fields.*` contract for this endpoint (unlike submit's
 * `fields.offendingLineIds`) — this is a best-effort heuristic over the RFC
 * 7807 `detail` text (design.md's flagged gap: "worth the architect/
 * backend-dev confirming the exact fields.* key names"). A date-shaped
 * detail routes to the Valid-from field; anything else (including an absent
 * detail) routes to the Rate field, since a non-positive value is the more
 * common 422 case per AC-4.5.
 */
const mapAddRateError = (error: ApiError): { rateError: string | null; validFromError: string | null } => {
  const detail = (error.detail ?? '').toLowerCase()
  if (detail.includes('date') || detail.includes('validfrom') || detail.includes('valid from')) {
    return { rateError: null, validFromError: error.detail ?? 'Enter a valid date.' }
  }
  return { rateError: error.detail ?? 'Enter a rate greater than 0.', validFromError: null }
}

const formatDateOnly = (isoDate: string): string => {
  try {
    return new Date(`${isoDate}T00:00:00`).toLocaleDateString(undefined, {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    })
  } catch {
    return isoDate
  }
}

const formatTimestamp = (iso: string): string => {
  try {
    return new Date(iso).toLocaleString(undefined, {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return '—'
  }
}

export default function MileageRatesPage() {
  const [listState, setListState] = useState<ListState>({ status: 'loading' })
  const [reloadToken, setReloadToken] = useState(0)
  const [addModal, setAddModal] = useState<AddModalState>({ open: false })

  // The button that opened the currently-open modal — focus returns here on
  // a successful add (design.md ADM-M1 "Success" state: "focus returns to
  // the entity's '+ Add rate entry' button — new focus-return behavior").
  // A plain ref (not a per-entity map) so it tracks whichever entity's header
  // "+ Add rate entry" button was actually clicked.
  const lastTriggerRef = useRef<HTMLButtonElement | null>(null)

  // See the module doc comment above re: why this is a Promise chain, not
  // an async function called from the effect (react-hooks/set-state-in-effect).
  useEffect(() => {
    let cancelled = false

    Promise.resolve()
      .then(() => {
        if (!cancelled) setListState({ status: 'loading' })
      })
      .then(() => ratesApi.listRates())
      .then((result) =>
        adminApi
          .getMe()
          .then((me) => ({ result, canManage: hasCapability(me.permissions, 'rate', 'manage') }))
          // A failed permission check hides the manage affordance rather than
          // failing the whole screen — fail closed, UX-only (see doc comment).
          .catch(() => ({ result, canManage: false })),
      )
      .then(({ result, canManage }) => {
        if (!cancelled) setListState({ status: 'loaded', result, canManage })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        if (error instanceof ApiError && error.status === 403) {
          setListState({ status: 'forbidden' })
        } else {
          setListState({ status: 'error', message: errorMessageFor(error) })
        }
      })

    return () => {
      cancelled = true
    }
  }, [reloadToken])

  const handleRetry = useCallback(() => {
    setReloadToken((token) => token + 1)
  }, [])

  // ---------------------------------------------------------------------------
  // Add rate entry (Modal ADM-M1 — design.md F5)
  // ---------------------------------------------------------------------------

  const handleAddOpen = useCallback((entity: MileageRateEntity, trigger: HTMLButtonElement) => {
    lastTriggerRef.current = trigger
    setAddModal({
      open: true,
      entity,
      rate: '',
      validFrom: '',
      submitting: false,
      rateError: null,
      validFromError: null,
      generalError: null,
    })
  }, [])

  const handleAddCancel = useCallback(() => {
    setAddModal({ open: false })
  }, [])

  const handleRateChange = useCallback((rate: string) => {
    setAddModal((prev) => (prev.open ? { ...prev, rate, rateError: null } : prev))
  }, [])

  const handleValidFromChange = useCallback((validFrom: string) => {
    setAddModal((prev) => (prev.open ? { ...prev, validFrom, validFromError: null } : prev))
  }, [])

  const handleAddSubmit = useCallback(async () => {
    if (!addModal.open) return
    const { entity, rate, validFrom } = addModal

    // Client-side pre-check (design.md ADM-M1: "Field error … or client-side
    // pre-check" both render the same field-level message).
    const rateValue = Number(rate)
    if (!Number.isFinite(rateValue) || rateValue <= 0) {
      setAddModal((prev) => (prev.open ? { ...prev, rateError: 'Enter a rate greater than 0.' } : prev))
      return
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(validFrom)) {
      setAddModal((prev) => (prev.open ? { ...prev, validFromError: 'Enter a valid date.' } : prev))
      return
    }

    setAddModal((prev) =>
      prev.open ? { ...prev, submitting: true, rateError: null, validFromError: null, generalError: null } : prev,
    )
    try {
      await ratesApi.addRate({ entity, ratePerKm: rate, validFrom })
      setAddModal({ open: false })
      lastTriggerRef.current?.focus()
      setReloadToken((token) => token + 1)
    } catch (error) {
      if (error instanceof ApiError && error.status === 422) {
        const { rateError, validFromError } = mapAddRateError(error)
        setAddModal((prev) => (prev.open ? { ...prev, submitting: false, rateError, validFromError } : prev))
      } else {
        setAddModal((prev) =>
          prev.open ? { ...prev, submitting: false, generalError: 'Could not add this rate entry. Try again.' } : prev,
        )
      }
    }
  }, [addModal])

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const canManage = listState.status === 'loaded' && listState.canManage

  return (
    <section aria-labelledby="admin-rates-heading" data-testid="admin-rates-page">
      {addModal.open && (
        <AddRateEntryModal
          entity={addModal.entity}
          entityLabel={ENTITY_CONFIG[addModal.entity].label}
          rate={addModal.rate}
          validFrom={addModal.validFrom}
          onRateChange={handleRateChange}
          onValidFromChange={handleValidFromChange}
          onSubmit={() => void handleAddSubmit()}
          onCancel={handleAddCancel}
          submitting={addModal.submitting}
          rateError={addModal.rateError}
          validFromError={addModal.validFromError}
          generalError={addModal.generalError}
        />
      )}

      <h2 id="admin-rates-heading" className="text-lg font-semibold" style={{ fontFamily: 'var(--disp)' }}>
        Mileage Rates
      </h2>
      <p className="mt-2 text-sm" style={{ color: 'var(--soft)' }}>
        Two entirely independent per-km rate series, one per entity. A new entry never edits or
        removes a past one — history accumulates, and an already-submitted claim keeps the rate
        that applied to it forever.
      </p>

      <div className="mt-4">
        {listState.status === 'forbidden' && (
          <PermissionDenied message="You don't have permission to view mileage rates." />
        )}

        {listState.status === 'loading' && (
          <div className="flex flex-col gap-8">
            {ENTITY_ORDER.map((entity) => (
              <div key={entity}>
                <h3 className="text-base font-semibold" style={{ fontFamily: 'var(--disp)' }}>
                  <span aria-hidden="true">{ENTITY_CONFIG[entity].flag}</span> {ENTITY_CONFIG[entity].label}
                </h3>
                <div className="mt-2">
                  <SkeletonListRows rows={3} />
                </div>
              </div>
            ))}
          </div>
        )}

        {listState.status === 'error' && <ErrorBanner message={listState.message} onRetry={handleRetry} />}

        {listState.status === 'loaded' && (
          <div className="flex flex-col gap-8">
            {listState.result.entities.map((entityRates) => {
              const config = ENTITY_CONFIG[entityRates.entity]
              const headingId = `rates-${entityRates.entity}-heading`

              return (
                <div key={entityRates.entity} data-testid={`rates-section-${entityRates.entity}`}>
                  <div className="flex items-center justify-between gap-4">
                    <h3 id={headingId} className="text-base font-semibold" style={{ fontFamily: 'var(--disp)' }}>
                      <span aria-hidden="true">{config.flag}</span> {config.label}
                    </h3>
                    {canManage && (
                      <button
                        type="button"
                        onClick={(e) => handleAddOpen(entityRates.entity, e.currentTarget)}
                        data-testid={`add-rate-button-${entityRates.entity}`}
                        className="text-sm py-1.5 px-3 font-medium transition-opacity hover:opacity-90"
                        style={{ color: 'white', backgroundColor: 'var(--acc)' }}
                      >
                        + Add rate entry
                      </button>
                    )}
                  </div>

                  <div className="mt-2">
                    {entityRates.entries.length === 0 && (
                      <div
                        className="flex flex-col items-center gap-3 py-8 text-center"
                        data-testid={`rates-empty-${entityRates.entity}`}
                      >
                        <p className="text-sm" style={{ color: 'var(--soft)' }}>
                          No rate configured yet for {config.label}.
                        </p>
                        {/* No CTA here — the entity header's "+ Add rate entry" button already covers this (avoids a redundant second button). */}
                      </div>
                    )}

                    {entityRates.entries.length > 0 && (
                      <div className="overflow-x-auto">
                        <table
                          className="w-full text-[11px]"
                          aria-labelledby={headingId}
                          data-testid={`rates-table-${entityRates.entity}`}
                        >
                          <thead>
                            <tr className="border-b" style={{ borderColor: 'var(--rule)' }}>
                              {(['Rate', 'Valid from', 'Added by', 'Added on', 'Status'] as const).map((label) => (
                                <th
                                  key={label}
                                  scope="col"
                                  className="text-left py-1.5 px-2 text-[9px] font-mono uppercase tracking-wider"
                                  style={{ color: 'var(--soft)' }}
                                >
                                  {label}
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {entityRates.entries.map((entry) => (
                              <tr
                                key={entry.id}
                                data-testid={`rate-row-${entry.id}`}
                                className="border-b"
                                style={{ borderColor: 'color-mix(in srgb, var(--rule) 50%, transparent)' }}
                              >
                                <td className="py-1.5 px-2 font-medium" style={{ color: 'var(--text)' }}>
                                  {entry.ratePerKm} {entityRates.currency}/km
                                </td>
                                <td className="py-1.5 px-2 whitespace-nowrap" style={{ color: 'var(--text)' }}>
                                  {formatDateOnly(entry.validFrom)}
                                </td>
                                <td className="py-1.5 px-2" style={{ color: 'var(--text)' }}>
                                  {entry.createdByEmail}
                                </td>
                                <td className="py-1.5 px-2 whitespace-nowrap" style={{ color: 'var(--text)' }}>
                                  {formatTimestamp(entry.createdAt)}
                                </td>
                                <td className="py-1.5 px-2">{entry.inEffectToday && <RateInEffectBadge />}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </section>
  )
}
