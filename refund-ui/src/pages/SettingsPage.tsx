import { useCallback, useEffect, useRef, useState } from 'react'
import { usePermissions } from 'shell/session'
import {
  Button,
  Card,
  DataTable,
  FactList,
  Field,
  PageHeader,
  SkeletonRows,
  StatePanel,
  Tabs,
  VisuallyHidden,
  formatDate,
  formatDateTime,
  formatNumber,
  tabPanelProps,
} from '@operai/ui'
import type { DataTableColumn } from '@operai/ui'
import * as ratesApi from '../lib/ratesApi'
import type { EntityRates, RateEntry, RatesResult } from '../lib/ratesApi'
import * as settingsApi from '../lib/settingsApi'
import { ACCOUNTING_DISTRIBUTION_EMAIL_KEY } from '../lib/settingsApi'
import type { SettingResult } from '../lib/settingsApi'
import { ApiError } from '../lib/refundApi'
import type { Entity } from '../components/EntityBadge'
import type { Currency } from '../lib/money'
import ErrorBanner from '../components/ErrorBanner'
import PermissionDenied from '../components/PermissionDenied'
import RateInEffectBadge from '../components/RateInEffectBadge'
import AddRateEntryModal from '../components/AddRateEntryModal'
import SuccessBanner from '../components/SuccessBanner'
import { validateRate, validateValidFrom } from '../lib/rateValidation'
import { strings } from '../strings'
import AccountingSettingsView from './settings/AccountingSettingsView'
import ExchangeRatesView from './settings/ExchangeRatesView'

const t = strings.settings

/**
 * SettingsPage — the refund tool's configuration (moved from admin-ui's
 * "Refund" section on 2026-11-13; ADR 20260720-mileage-rate-model-snapshot-admin-ui-composition amendment): one card per entity
 * with its append-only mileage-rate history (specs/20260720-mileage-rate AC-4.1–4.7, AC-5.3) and
 * the accounting distribution email (specs/20260722-refund-settings AC-1.1–1.4, AC-3.2, AC-5.3).
 *
 * Two independent fetch/state machines, because they are two resources with
 * two capabilities (`rate:*`, `settings:*`, ADR 20260722-settings-catalog-permission-config-not-rate):
 *   - rates: always fetched; a 403 shows a section-level PermissionDenied.
 *   - email: fetched only with `settings:read`; without it, or on a 403, the
 *     card is not shown at all (AC-3.2).
 * "Add rate entry" needs `rate:manage`, the email form `settings:manage` — both
 * read from the shell's cached permissions (INC-32), so they fail CLOSED until
 * resolved. UX only: refund-api enforces every grant server-side.
 *
 * Effects use an explicit Promise chain (react-hooks/set-state-in-effect).
 */

// Entity names come from strings; no flag emoji (they do not render on Windows — INC-23).
const ENTITY_LABEL: Record<Entity, string> = strings.badges.entity

const ENTITY_ORDER: Entity[] = ['welld_ch', 'welld_it']

type ListState =
  | { status: 'loading' }
  | { status: 'loaded'; result: RatesResult }
  | { status: 'error'; message: string }
  | { status: 'forbidden' }

type AddModalState =
  | { open: false }
  | {
      open: true
      entity: Entity
      rate: string
      validFrom: string
      submitting: boolean
      rateError: string | null
      validFromError: string | null
      generalError: string | null
    }

/**
 * State for the accounting-distribution-email panel (T6,
 * specs/20260722-refund-settings/tasks.md, refs AC-1.1, AC-3.2, AC-5.3).
 *
 * `hidden` is the reactive path: "GET /settings/:key came back 403 anyway"
 * (mirrors the rate section's `forbidden` handling but as an outright absence
 * rather than a PermissionDenied block — AC-3.2 requires the section not be
 * shown at all, not shown-then-blocked). The proactive path (no
 * `settings:read` in `usePermissions()`, AC-3.2) is derived at render and
 * never fetches.
 */
type SettingsState =
  | { status: 'hidden' }
  | { status: 'loading' }
  | { status: 'loaded'; setting: SettingResult }
  | { status: 'error'; message: string }

const errorMessageFor = (error: unknown): string => {
  if (error instanceof ApiError) {
    return error.detail ?? error.title
  }
  return t.loadError
}

const settingsErrorMessageFor = (error: unknown): string => {
  if (error instanceof ApiError) {
    return error.detail ?? error.title
  }
  return t.email.loadError
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
    return { rateError: null, validFromError: error.detail ?? t.validFromError }
  }
  return { rateError: error.detail ?? t.rateError, validFromError: null }
}

/**
 * A rate per km for display: integer micros of the currency unit (ADR 20260720-mileage-rate-money-precision-integer-micros)
 * as a locale number with at least two decimals and up to the six micros
 * carry, with the currency per km — "CHF 0.81/km" (INC-27).
 */
const formatRatePerKm = (micros: number, currency: Currency): string =>
  t.perKm(formatNumber(micros / 1_000_000, { minimumFractionDigits: 2, maximumFractionDigits: 6 }), currency)

const rateColumns = (currency: Currency): DataTableColumn<RateEntry>[] => [
  {
    id: 'rate',
    header: t.columns.rate,
    rowHeader: true,
    numeric: true,
    render: (entry) => formatRatePerKm(entry.ratePerKmMicros, currency),
  },
  { id: 'validFrom', header: t.columns.validFrom, render: (entry) => formatDate(entry.validFrom) },
  { id: 'addedBy', header: t.columns.addedBy, render: (entry) => entry.createdByEmail },
  { id: 'addedOn', header: t.columns.addedOn, render: (entry) => formatDateTime(entry.createdAt) },
  { id: 'status', header: t.columns.status, render: (entry) => entry.inEffectToday && <RateInEffectBadge /> },
]

/**
 * The General view: today's Settings page, unchanged — the mileage-rate cards and the accounting
 * distribution email (specs/20261118-refund-accounting-export T23: the page became three views and this is the first).
 */
function GeneralSettingsView() {
  // Capabilities from the shell's cached permissions (INC-32) — derived at
  // render; until they resolve, or on any failure, they are empty (no grants).
  const { permissions } = usePermissions()
  const canManageRates = hasCapability(permissions, 'rate', 'manage')
  const canReadSettings = hasCapability(permissions, 'settings', 'read')
  const canManageSettings = hasCapability(permissions, 'settings', 'manage')

  const [listState, setListState] = useState<ListState>({ status: 'loading' })
  const [reloadToken, setReloadToken] = useState(0)
  const [addModal, setAddModal] = useState<AddModalState>({ open: false })

  // Accounting distribution email panel (T6, specs/20260722-refund-settings) — an
  // entirely independent fetch/state machine from the rate section above:
  // different resource, different capability (`settings:read`/`manage`,
  // ADR 20260722-settings-catalog-permission-config-not-rate), so it is gated and reloaded on its own rather than piggy-backing
  // on the rate section's `listState`.
  const [settingsState, setSettingsState] = useState<SettingsState>({ status: 'loading' })
  const [settingsReloadToken, setSettingsReloadToken] = useState(0)
  const [emailInput, setEmailInput] = useState('')
  const [emailSaving, setEmailSaving] = useState(false)
  const [emailFormError, setEmailFormError] = useState<string | null>(null)
  const emailInputRef = useRef<HTMLInputElement>(null)

  // INC-19 confirmations: per entity for a new rate entry, and for the email setting.
  const [rateSuccess, setRateSuccess] = useState<{ entity: Entity; message: string } | null>(null)
  const [emailSuccess, setEmailSuccess] = useState<string | null>(null)

  // The button that opened the currently-open modal — focus returns here on
  // a successful add (design.md ADM-M1 "Success" state: "focus returns to
  // the entity's 'Add rate entry' button — new focus-return behavior").
  // A plain ref (not a per-entity map) so it tracks whichever entity's header
  // "Add rate entry" button was actually clicked.
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
      .then((result) => {
        if (!cancelled) setListState({ status: 'loaded', result })
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
  // Accounting distribution email panel (T6, specs/20260722-refund-settings)
  // ---------------------------------------------------------------------------

  // Same Promise-chain rationale as the rate-list effect above
  // (react-hooks/set-state-in-effect). Only fetches when `settings:read` is
  // held (from `usePermissions()`); without it the panel is not rendered at
  // all (AC-3.2 — "not shown at all", not a PermissionDenied block), and a
  // failed permissions fetch yields no grants — fails CLOSED, UX-only; the
  // real boundary is refund-api's server-side `settings:read`/`settings:manage`
  // gate (plan.md Security section).
  useEffect(() => {
    if (!canReadSettings) return
    let cancelled = false

    Promise.resolve()
      .then(() => {
        if (!cancelled) setSettingsState({ status: 'loading' })
      })
      .then(() => settingsApi.getSetting(ACCOUNTING_DISTRIBUTION_EMAIL_KEY))
      .then((setting) => {
        if (cancelled) return
        setSettingsState({ status: 'loaded', setting })
        setEmailInput(setting.value ?? '')
        setEmailFormError(null)
      })
      .catch((error: unknown) => {
        if (cancelled) return
        if (error instanceof ApiError && error.status === 403) {
          setSettingsState({ status: 'hidden' })
        } else {
          setSettingsState({ status: 'error', message: settingsErrorMessageFor(error) })
        }
      })

    return () => {
      cancelled = true
    }
  }, [settingsReloadToken, canReadSettings])

  // A failed save moves focus to the field its error describes (INC-16) —
  // in an effect, once the input is enabled again.
  useEffect(() => {
    if (emailFormError) emailInputRef.current?.focus()
  }, [emailFormError])

  const handleSettingsRetry = useCallback(() => {
    setSettingsReloadToken((token) => token + 1)
  }, [])

  const handleEmailInputChange = useCallback((value: string) => {
    setEmailInput(value)
    setEmailFormError(null)
    setEmailSuccess(null)
  }, [])

  const handleEmailSave = useCallback(async () => {
    const trimmed = emailInput.trim()
    setEmailSaving(true)
    setEmailFormError(null)
    try {
      const setting = await settingsApi.putSetting(ACCOUNTING_DISTRIBUTION_EMAIL_KEY, trimmed === '' ? null : trimmed)
      setSettingsState((prev) => (prev.status === 'loaded' ? { ...prev, setting } : prev))
      setEmailInput(setting.value ?? '')
      setEmailSuccess(setting.value ? t.email.saved : t.email.cleared)
    } catch (error) {
      // Leaves the shown current value unchanged (AC-1.3) — settingsState is
      // only ever updated on a successful write, above.
      setEmailFormError(settingsErrorMessageFor(error))
    } finally {
      setEmailSaving(false)
    }
  }, [emailInput])

  const handleEmailClear = useCallback(async () => {
    setEmailSaving(true)
    setEmailFormError(null)
    try {
      const setting = await settingsApi.putSetting(ACCOUNTING_DISTRIBUTION_EMAIL_KEY, null)
      setSettingsState((prev) => (prev.status === 'loaded' ? { ...prev, setting } : prev))
      setEmailInput('')
      setEmailSuccess(t.email.cleared)
    } catch (error) {
      setEmailFormError(settingsErrorMessageFor(error))
    } finally {
      setEmailSaving(false)
    }
  }, [])

  // ---------------------------------------------------------------------------
  // Add rate entry (Modal ADM-M1 — design.md F5)
  // ---------------------------------------------------------------------------

  const handleAddOpen = useCallback((entity: Entity, trigger: HTMLButtonElement) => {
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
    // INC-17: the rate is parsed exactly into integer micros (ADR 20260720-mileage-rate-money-precision-integer-micros's rate
    // precision, up to 6 decimals), comma or dot, never through a float. Both
    // fields are checked so every error shows at once; the modal then focuses
    // the first invalid one.
    const rateError = validateRate(rate)
    const validFromError = validateValidFrom(validFrom)
    if (rateError || validFromError) {
      setAddModal((prev) => (prev.open ? { ...prev, rateError, validFromError } : prev))
      return
    }

    setAddModal((prev) =>
      prev.open ? { ...prev, submitting: true, rateError: null, validFromError: null, generalError: null } : prev,
    )
    try {
      // refund-api takes a dot-decimal string and derives the micros itself.
      await ratesApi.addRate({ entity, ratePerKm: rate.trim().replace(',', '.'), validFrom })
      setAddModal({ open: false })
      setRateSuccess({ entity, message: t.added(ENTITY_LABEL[entity]) })
      lastTriggerRef.current?.focus()
      setReloadToken((token) => token + 1)
    } catch (error) {
      if (error instanceof ApiError && error.status === 422) {
        const { rateError, validFromError } = mapAddRateError(error)
        setAddModal((prev) => (prev.open ? { ...prev, submitting: false, rateError, validFromError } : prev))
      } else {
        setAddModal((prev) =>
          prev.open ? { ...prev, submitting: false, generalError: t.addFailed } : prev,
        )
      }
    }
  }, [addModal])

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const settingsHidden = !canReadSettings || settingsState.status === 'hidden'

  return (
    <>
      {addModal.open && (
        <AddRateEntryModal
          entity={addModal.entity}
          entityLabel={ENTITY_LABEL[addModal.entity]}
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

      <div className="flex flex-col gap-4">
        {listState.status === 'forbidden' && <PermissionDenied headingLevel={3} title={t.forbiddenTitle} message={t.forbidden} />}

        {listState.status === 'loading' &&
          ENTITY_ORDER.map((entity, index) => (
            <Card key={entity} title={t.entityRates(ENTITY_LABEL[entity])}>
              {/* One announcement for the whole screen, on the first card. */}
              {index === 0 && <VisuallyHidden live>{t.loading}</VisuallyHidden>}
              <SkeletonRows rows={3} testId="skeleton-list-rows" />
            </Card>
          ))}

        {listState.status === 'error' && <ErrorBanner message={listState.message} onRetry={handleRetry} />}

        {listState.status === 'loaded' &&
          listState.result.entities.map((entityRates: EntityRates) => {
            const label = ENTITY_LABEL[entityRates.entity]

            return (
              <Card
                key={entityRates.entity}
                title={t.entityRates(label)}
                data-testid={`rates-section-${entityRates.entity}`}
                action={
                  canManageRates && (
                    <Button
                      size="sm"
                      onClick={(e) => handleAddOpen(entityRates.entity, e.currentTarget)}
                      data-testid={`add-rate-button-${entityRates.entity}`}
                    >
                      {t.addRateEntry}
                    </Button>
                  )
                }
              >
                {rateSuccess?.entity === entityRates.entity && (
                  <SuccessBanner
                    message={rateSuccess.message}
                    onDismiss={() => setRateSuccess(null)}
                    testId={`rates-success-${entityRates.entity}`}
                    className="mb-2"
                  />
                )}

                {entityRates.entries.length === 0 && (
                  // No CTA here — the card's "Add rate entry" action already covers this.
                  <StatePanel title={t.empty.title} headingLevel={4} testId={`rates-empty-${entityRates.entity}`}>
                    {t.empty.body(label)}
                  </StatePanel>
                )}

                {entityRates.entries.length > 0 && (
                  <DataTable
                    caption={t.caption(label)}
                    columns={rateColumns(entityRates.currency)}
                    rows={entityRates.entries}
                    getRowKey={(entry) => entry.id}
                    testId={`rates-table-${entityRates.entity}`}
                    rowTestIdPrefix="rate-row"
                  />
                )}
              </Card>
            )
          })}

        {!settingsHidden && (
          <Card title={t.email.title} data-testid="accounting-email-panel">
            <p className="text-sm text-soft mb-4">{t.email.description}</p>

            {settingsState.status === 'loading' && (
              <>
                <VisuallyHidden live>{t.email.loading}</VisuallyHidden>
                <SkeletonRows rows={2} testId="skeleton-list-rows" />
              </>
            )}

            {settingsState.status === 'error' && (
              <ErrorBanner message={settingsState.message} onRetry={handleSettingsRetry} />
            )}

            {settingsState.status === 'loaded' && (
              <div className="flex flex-col gap-4">
                <FactList
                  items={[
                    {
                      id: 'current',
                      term: t.email.currentValue,
                      value: (
                        <span
                          className={settingsState.setting.configured ? 'text-text' : 'text-soft'}
                          data-testid="accounting-email-current-value"
                        >
                          {settingsState.setting.configured ? settingsState.setting.value : t.email.notConfigured}
                        </span>
                      ),
                    },
                  ]}
                />

                <SuccessBanner
                  message={emailSuccess}
                  onDismiss={() => setEmailSuccess(null)}
                  testId="accounting-email-success"
                />

                {canManageSettings && (
                  <form
                    className="flex flex-col gap-2"
                    onSubmit={(e) => {
                      e.preventDefault()
                      void handleEmailSave()
                    }}
                  >
                    <Field
                      label={t.email.emailAddress}
                      error={
                        emailFormError && (
                          <span role="alert" data-testid="accounting-email-error">
                            {emailFormError}
                          </span>
                        )
                      }
                      className="w-72 max-w-full"
                    >
                      {(control) => (
                        <input
                          {...control}
                          ref={emailInputRef}
                          type="text"
                          value={emailInput}
                          onChange={(e) => handleEmailInputChange(e.target.value)}
                          placeholder={t.email.placeholder}
                          data-testid="accounting-email-input"
                          disabled={emailSaving}
                        />
                      )}
                    </Field>
                    <div className="flex items-center gap-2">
                      <Button type="submit" variant="primary" disabled={emailSaving} data-testid="accounting-email-save">
                        {t.email.save}
                      </Button>
                      <Button
                        disabled={emailSaving || !settingsState.setting.configured}
                        onClick={() => void handleEmailClear()}
                        data-testid="accounting-email-clear"
                      >
                        {t.email.clear}
                      </Button>
                    </div>
                  </form>
                )}

                <div>
                  <h4 className="text-sm font-semibold text-text">{t.email.historyTitle}</h4>
                  {settingsState.setting.history.length === 0 && (
                    <p className="mt-2 text-sm text-soft">{t.email.historyEmpty}</p>
                  )}
                  {settingsState.setting.history.length > 0 && (
                    <ul className="mt-2 flex flex-col gap-1.5" data-testid="accounting-email-history">
                      {settingsState.setting.history.map((entry, index) => (
                        <li
                          key={`${entry.changedAt}-${index}`}
                          data-testid={`accounting-email-history-item-${index}`}
                          className="text-2xs text-text"
                        >
                          {t.email.historyItem(
                            entry.value ?? t.email.notConfigured,
                            entry.changedByEmail,
                            formatDateTime(entry.changedAt),
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            )}
          </Card>
        )}
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// The page: a header, the view switch and the one view that is open
// ---------------------------------------------------------------------------

/** The Settings views, in tab order; `?section=` carries these ids. */
const SETTINGS_SECTIONS = ['general', 'accounting', 'exchange-rates'] as const
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]

const SECTION_LABEL: Record<SettingsSection, string> = {
  general: t.sections.general,
  accounting: t.sections.accounting,
  'exchange-rates': t.sections.exchangeRates,
}

export type SettingsPageProps = {
  /** The requested view (`?section=`). Unknown, or one the user cannot open: the first available view is shown. */
  section?: string
  /** The month an exchange-rates deep link points at (`&month=YYYY-MM`); only that view reads it. */
  month?: string
  /**
   * Called with the view the user picked. With it, the page is controlled by `section` (the router keeps it in the
   * URL); without it the page keeps its own choice, so it also works outside a router.
   */
  onSectionChange?: (section: SettingsSection) => void
}

/**
 * SettingsPage — the refund tool's configuration, in same-page views (UX-1, specs/20261118-refund-accounting-export):
 * General (today's page), Accounts and VAT, Exchange rates. Only the open view is mounted, so an auto-fetch
 * of exchange rates runs only when an admin looks at them. A view the user cannot open is left out of
 * the tab list, never disabled (design-system § Tool frame): the accounting views need `settings:read`;
 * General stays for everyone who reaches the page (its own cards handle a 403). With a single view there is
 * no tab list and the page is exactly today's. UX only: refund-api enforces every grant.
 *
 * Capabilities fail CLOSED until the shell resolves them, so a deep link to a gated view first shows
 * General for an instant and then switches.
 */
export default function SettingsPage({ section, month, onSectionChange }: SettingsPageProps) {
  const { permissions } = usePermissions()
  const canReadSettings = hasCapability(permissions, 'settings', 'read')
  const [ownSection, setOwnSection] = useState<string | undefined>(section)

  const available: SettingsSection[] = canReadSettings ? [...SETTINGS_SECTIONS] : ['general']
  const requested = onSectionChange ? section : ownSection
  const active: SettingsSection = available.find((id) => id === requested) ?? available[0]

  const handleChange = (next: SettingsSection) => {
    if (onSectionChange) onSectionChange(next)
    else setOwnSection(next)
  }

  const showTabs = available.length > 1

  return (
    <section aria-labelledby="refund-settings-heading" data-testid="refund-settings-page">
      <PageHeader
        title={t.heading}
        titleId="refund-settings-heading"
        description={showTabs ? t.descriptionAll : t.description}
      />

      {showTabs && (
        <Tabs
          label={t.sections.label}
          tabs={available.map((id) => ({ id, label: SECTION_LABEL[id] }))}
          value={active}
          onChange={handleChange}
          idPrefix="refund-settings"
          testId="refund-settings-tabs"
          wrap
        />
      )}

      <div
        {...(showTabs ? tabPanelProps('refund-settings', active) : {})}
        data-testid={`refund-settings-view-${active}`}
      >
        {active === 'general' && <GeneralSettingsView />}
        {active === 'accounting' && <AccountingSettingsView />}
        {active === 'exchange-rates' && <ExchangeRatesView month={month} />}
      </div>
    </section>
  )
}
