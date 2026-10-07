import { useEffect, useId, useState } from 'react'
import DataTable from '../components/DataTable'
import EntityBadge from '../components/EntityBadge'
import ErrorBanner from '../components/ErrorBanner'
import NewRuleDialog from '../components/NewRuleDialog'
import PermissionDenied from '../components/PermissionDenied'
import SkeletonListRows from '../components/SkeletonListRows'
import { useInventoryCapabilities } from '../hooks/useInventoryCapabilities'
import { useScope } from '../hooks/useScope'
import { ApiError } from '../lib/api'
import { formatDate, todayIsoDate } from '../lib/dates'
import { formatMoney } from '../lib/money'
import { listRules } from '../lib/rulesApi'
import type { Currency, Entity, Identity, Rule, RulesList } from '../lib/types'
import { strings } from '../strings'

/**
 * RulesPage — T4, `/rules` (T37, specs/015-hardware-inventory; design.md T4, F11,
 * § Accessibility "T4 rules"; AC-6.1, AC-6.2, AC-6.5), modelled on admin-ui's
 * MileageRatesPage: one section per entity of `GET /scope`'s `ledger` list, each a
 * table of EVERY rule (past, in force, scheduled) with who added it and when, and
 * its own "New rule for {entity}" button. A rule is append-only (AC-6.5): there is
 * no edit and no delete control anywhere — a correction is a new rule.
 *
 * `ledger:manage` only (a UX gate; the server's 403 is the real one). Each section
 * loads its own rules, so one entity's failure never hides the other: loading
 * skeleton, `ErrorBanner` + Retry (the 503 variant for an `auth` outage),
 * `PermissionDenied` for a 403, and an empty note. The Status column says "In
 * force" (from `inForceId`, never computed here), "Scheduled" (effective date after
 * today) or "Superseded" — text with a glyph, never colour alone. After a save the
 * section reloads (keeping the old rows on screen meanwhile), the page announces
 * "Rule added. It applies to purchases from {date}." and focus moves to the new
 * row's header cell.
 */

/** AC-1.2: CHF for `welld_ch`, EUR for `welld_it`. Display only. */
const CURRENCY_OF: Record<Entity, Currency> = { welld_ch: 'CHF', welld_it: 'EUR' }

const PAGE_TEST_ID = 'inventory-rules-page'

const identityLabel = (identity: Identity): string => {
  if (identity.status === 'system') return strings.assets.holderSystem
  if (identity.status === 'deleted') return strings.assets.holderDeleted
  return identity.name ?? strings.assets.holderUnknown
}

/** Newest effective date first, so a scheduled rule sits on top; ties by creation time. */
const newestFirst = (a: Rule, b: Rule): number =>
  b.effectiveFrom.localeCompare(a.effectiveFrom) || b.createdAt.localeCompare(a.createdAt)

type Outcome =
  | { key: string; entity: Entity; ok: true; list: RulesList }
  | { key: string; entity: Entity; ok: false; error: unknown }

function StatusCell({ rule, inForceId, today }: { rule: Rule; inForceId: string; today: string }) {
  const t = strings.rules.status
  const [glyph, label] =
    rule.id === inForceId ? ['✓', t.inForce] : rule.effectiveFrom > today ? ['◷', t.scheduled] : ['–', t.superseded]
  return (
    <span
      className="inline-flex items-center gap-1"
      style={rule.id === inForceId ? { color: 'var(--grn)' } : undefined}
    >
      <span aria-hidden="true">{glyph}</span>
      <span>{label}</span>
    </span>
  )
}

function RulesSection({ entity, announce }: { entity: Entity; announce: (message: string) => void }) {
  const t = strings.rules
  const headingId = useId()
  const entityName = strings.common.entity[entity]
  const currency = CURRENCY_OF[entity]
  const [attempt, setAttempt] = useState(0)
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const [adding, setAdding] = useState(false)
  const [focusId, setFocusId] = useState<string | null>(null)
  const key = `${entity}:${attempt}`

  useEffect(() => {
    const controller = new AbortController()
    listRules(entity, { signal: controller.signal }).then(
      (list) => {
        if (!controller.signal.aborted) setOutcome({ key, entity, ok: true, list })
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setOutcome({ key, entity, ok: false, error })
      },
    )
    return () => controller.abort()
  }, [entity, key])

  const current = outcome?.key === key ? outcome : null
  const shown = current ?? (outcome?.entity === entity && outcome.ok ? outcome : null)
  const retry = () => setAttempt((previous) => previous + 1)

  let content
  if (current !== null && !current.ok) {
    const { error } = current
    if (error instanceof ApiError && error.status === 403) content = <PermissionDenied />
    else if (error instanceof ApiError && error.status === 503) {
      content = <ErrorBanner variant="authUnavailable" onRetry={retry} retryLabel={t.retry} />
    } else {
      content = (
        <ErrorBanner
          message={error instanceof ApiError ? (error.detail ?? strings.errors.unknown) : strings.errors.network}
          onRetry={retry}
          retryLabel={t.retry}
        />
      )
    }
  } else if (shown === null || !shown.ok) {
    content = (
      <div className="flex flex-col gap-2">
        <p role="status" className="sr-only">
          {t.sectionLoading(entityName)}
        </p>
        <SkeletonListRows />
      </div>
    )
  } else if (shown.list.rules.length === 0) {
    content = (
      <p className="text-sm" style={{ color: 'var(--soft)' }}>
        {t.empty(entityName)}
      </p>
    )
  } else {
    const { rules, inForceId } = shown.list
    const today = todayIsoDate()
    const money = (cents: number) => formatMoney(cents, currency)
    const ordered = [...rules].sort(newestFirst)
    content = (
      <DataTable
        caption={t.caption(entityName)}
        columns={[
          {
            id: 'effectiveFrom',
            header: t.columns.effectiveFrom,
            rowHeader: true,
            render: (r) => formatDate(r.effectiveFrom),
          },
          { id: 'usefulLife', header: t.columns.usefulLife, numeric: true, render: (r) => r.usefulLifeYears },
          { id: 'firstYearShare', header: t.columns.firstYearShare, render: (r) => t.firstYearShare[r.firstYearShare] },
          {
            id: 'threshold',
            header: t.columns.threshold,
            numeric: true,
            render: (r) => (r.lowValueThresholdCents === null ? t.noThreshold : money(r.lowValueThresholdCents)),
          },
          { id: 'residual', header: t.columns.residual, numeric: true, render: (r) => money(r.residualCents) },
          { id: 'addedBy', header: t.columns.addedBy, render: (r) => identityLabel(r.createdBy) },
          { id: 'addedOn', header: t.columns.addedOn, render: (r) => formatDate(r.createdAt) },
          {
            id: 'status',
            header: t.columns.status,
            render: (r) => <StatusCell rule={r} inForceId={inForceId} today={today} />,
          },
        ]}
        rows={ordered}
        getRowKey={(r) => r.id}
        focusRowKey={focusId !== null && rules.some((r) => r.id === focusId) ? focusId : null}
        testId={`rules-table-${entity}`}
      />
    )
  }

  const inForceRule =
    shown !== null && shown.ok ? (shown.list.rules.find((r) => r.id === shown.list.inForceId) ?? null) : null

  return (
    <section aria-labelledby={headingId} data-testid={`rules-section-${entity}`} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3
          id={headingId}
          className="flex items-center gap-2 text-base font-semibold"
          style={{ fontFamily: 'var(--disp)', color: 'var(--text)' }}
        >
          {t.sectionHeading(entityName)}
          <EntityBadge entity={entity} />
        </h3>
        {shown !== null && shown.ok && (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="border px-3 py-2 text-sm font-medium"
            style={{ borderColor: 'var(--rule)', color: 'var(--text)' }}
          >
            {t.newRule(entityName)}
          </button>
        )}
      </div>

      {content}

      {adding && (
        <NewRuleDialog
          entity={entity}
          inForceRule={inForceRule}
          onCancel={() => setAdding(false)}
          onSaved={(saved) => {
            setAdding(false)
            setFocusId(saved.id)
            retry()
            announce(t.added(formatDate(saved.effectiveFrom)))
          }}
        />
      )}
    </section>
  )
}

export default function RulesPage() {
  const t = strings.rules
  const { canManageLedger } = useInventoryCapabilities()
  const scope = useScope(canManageLedger)
  const [statusLine, setStatusLine] = useState('')

  if (!canManageLedger) {
    return (
      <section data-testid={PAGE_TEST_ID}>
        <PermissionDenied />
      </section>
    )
  }

  let content
  if (scope.status === 'error') {
    const { error } = scope
    content =
      error instanceof ApiError && error.status === 503 ? (
        <ErrorBanner variant="authUnavailable" onRetry={scope.retry} retryLabel={t.retry} />
      ) : (
        <ErrorBanner
          message={error instanceof ApiError ? (error.detail ?? strings.errors.unknown) : strings.errors.network}
          onRetry={scope.retry}
          retryLabel={t.retry}
        />
      )
  } else if (scope.status !== 'ready' || scope.scope === null) {
    content = (
      <div className="flex flex-col gap-2">
        <p role="status" className="sr-only">
          {t.loading}
        </p>
        <SkeletonListRows />
      </div>
    )
  } else if (scope.scope.ledger.length === 0) {
    content = (
      <p className="text-sm" style={{ color: 'var(--soft)' }}>
        {t.noEntity}
      </p>
    )
  } else {
    content = (
      <div className="flex flex-col gap-8">
        {scope.scope.ledger.map((entity) => (
          <RulesSection key={entity} entity={entity} announce={setStatusLine} />
        ))}
      </div>
    )
  }

  return (
    <section data-testid={PAGE_TEST_ID} aria-labelledby="rules-heading" className="flex flex-col gap-4">
      <h2 id="rules-heading" className="text-lg font-semibold" style={{ fontFamily: 'var(--disp)' }}>
        {t.heading}
      </h2>
      <p role="status" className="sr-only">
        {statusLine}
      </p>
      {content}
    </section>
  )
}
