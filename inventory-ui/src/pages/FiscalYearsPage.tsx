import { Link } from '@tanstack/react-router'
import { useEffect, useId, useState } from 'react'
import DataTable from '../components/DataTable'
import EntityBadge from '../components/EntityBadge'
import ErrorBanner from '../components/ErrorBanner'
import PermissionDenied from '../components/PermissionDenied'
import SkeletonListRows from '../components/SkeletonListRows'
import { useInventoryCapabilities } from '../hooks/useInventoryCapabilities'
import { useScope } from '../hooks/useScope'
import { ApiError } from '../lib/api'
import { formatDate } from '../lib/dates'
import { listFiscalYears } from '../lib/fiscalYearsApi'
import type { Entity, FiscalYearSummary } from '../lib/types'
import { strings } from '../strings'

/**
 * FiscalYearsPage — T5, `/years` (T38, specs/015-hardware-inventory; design.md T5,
 * F12; AC-8.1): one section per entity of `GET /scope`'s `ledger` list, each a
 * table of that entity's fiscal years, newest first — year, Open / Closed (text
 * with a glyph, never colour alone), the closed-on date, and a link to the year's
 * detail. `ledger:manage` only (a UX gate; the server's 403 is the real one) —
 * without it the page renders `PermissionDenied` and calls nothing.
 *
 * Each section loads its own list, so one entity's failure never hides the other:
 * loading skeleton, `ErrorBanner` + Retry (the 503 variant for an `auth` outage),
 * `PermissionDenied` for a 403, and a per-entity empty note.
 */

const PAGE_TEST_ID = 'inventory-fiscal-years-page'

type Outcome =
  { request: string; ok: true; years: FiscalYearSummary[] } | { request: string; ok: false; error: unknown }

const errorBanner = (error: unknown, retry: () => void) =>
  error instanceof ApiError && error.status === 503 ? (
    <ErrorBanner variant="authUnavailable" onRetry={retry} retryLabel={strings.years.retry} />
  ) : (
    <ErrorBanner
      message={error instanceof ApiError ? (error.detail ?? strings.errors.unknown) : strings.errors.network}
      onRetry={retry}
      retryLabel={strings.years.retry}
    />
  )

function StatusCell({ status }: { status: FiscalYearSummary['status'] }) {
  const [glyph, label] = status === 'closed' ? ['■', strings.years.status.closed] : ['◌', strings.years.status.open]
  return (
    <span className="inline-flex items-center gap-1">
      <span aria-hidden="true">{glyph}</span>
      <span>{label}</span>
    </span>
  )
}

function YearsSection({ entity }: { entity: Entity }) {
  const t = strings.years
  const headingId = useId()
  const entityName = strings.common.entity[entity]
  const [attempt, setAttempt] = useState(0)
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const request = `${entity}:${attempt}`

  useEffect(() => {
    const controller = new AbortController()
    listFiscalYears(entity, { signal: controller.signal }).then(
      ({ years }) => {
        if (!controller.signal.aborted) setOutcome({ request, ok: true, years })
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setOutcome({ request, ok: false, error })
      },
    )
    return () => controller.abort()
  }, [entity, request])

  const current = outcome?.request === request ? outcome : null
  const retry = () => setAttempt((previous) => previous + 1)

  let content
  if (current !== null && !current.ok) {
    content =
      current.error instanceof ApiError && current.error.status === 403 ? (
        <PermissionDenied />
      ) : (
        errorBanner(current.error, retry)
      )
  } else if (current === null) {
    content = (
      <div className="flex flex-col gap-2">
        <p role="status" className="sr-only">
          {t.sectionLoading(entityName)}
        </p>
        <SkeletonListRows />
      </div>
    )
  } else if (current.years.length === 0) {
    content = (
      <p className="text-sm" style={{ color: 'var(--soft)' }}>
        {t.empty(entityName)}
      </p>
    )
  } else {
    const ordered = [...current.years].sort((a, b) => b.year - a.year)
    content = (
      <DataTable
        caption={t.caption(entityName)}
        columns={[
          { id: 'year', header: t.columns.year, numeric: true, rowHeader: true, render: (row) => row.year },
          { id: 'status', header: t.columns.status, render: (row) => <StatusCell status={row.status} /> },
          {
            id: 'closedOn',
            header: t.columns.closedOn,
            render: (row) => (row.closedAt === null ? t.notClosed : formatDate(row.closedAt)),
          },
          {
            id: 'open',
            header: t.columns.open,
            render: (row) => (
              <Link
                to="/years/$entity/$year"
                params={{ entity, year: String(row.year) }}
                aria-label={t.openLinkLabel(row.year, entityName)}
                className="underline"
                style={{ color: 'var(--acc)' }}
              >
                {t.openLink}
              </Link>
            ),
          },
        ]}
        rows={ordered}
        getRowKey={(row) => String(row.year)}
        testId={`fiscal-years-table-${entity}`}
      />
    )
  }

  return (
    <section aria-labelledby={headingId} data-testid={`fiscal-years-section-${entity}`} className="flex flex-col gap-3">
      <h3
        id={headingId}
        className="flex items-center gap-2 text-base font-semibold"
        style={{ fontFamily: 'var(--disp)', color: 'var(--text)' }}
      >
        {t.sectionHeading(entityName)}
        <EntityBadge entity={entity} />
      </h3>
      {content}
    </section>
  )
}

export default function FiscalYearsPage() {
  const t = strings.years
  const { canManageLedger } = useInventoryCapabilities()
  const scope = useScope(canManageLedger)

  if (!canManageLedger) {
    return (
      <section data-testid={PAGE_TEST_ID}>
        <PermissionDenied />
      </section>
    )
  }

  let content
  if (scope.status === 'error') {
    content = errorBanner(scope.error, scope.retry)
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
          <YearsSection key={entity} entity={entity} />
        ))}
      </div>
    )
  }

  return (
    <section data-testid={PAGE_TEST_ID} aria-labelledby="fiscal-years-heading" className="flex flex-col gap-4">
      <h2 id="fiscal-years-heading" className="text-lg font-semibold" style={{ fontFamily: 'var(--disp)' }}>
        {t.heading}
      </h2>
      {content}
    </section>
  )
}
