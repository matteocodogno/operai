import { Link, useParams } from '@tanstack/react-router'
import { useEffect, useId, useRef, useState } from 'react'
import CloseYearDialog from '../components/CloseYearDialog'
import DataTable from '../components/DataTable'
import EntityBadge from '../components/EntityBadge'
import ErrorBanner from '../components/ErrorBanner'
import ExportYearButton from '../components/ExportYearButton'
import PermissionDenied from '../components/PermissionDenied'
import RollForwardStatement from '../components/RollForwardStatement'
import SkeletonListRows from '../components/SkeletonListRows'
import { useInventoryCapabilities } from '../hooks/useInventoryCapabilities'
import { ApiError } from '../lib/api'
import { formatDate } from '../lib/dates'
import { getFiscalYear, listFiscalYears } from '../lib/fiscalYearsApi'
import { formatMoney } from '../lib/money'
import type { Entity, FiscalYearView, Identity } from '../lib/types'
import { strings } from '../strings'

/**
 * FiscalYearDetailPage — T6, `/years/$entity/$year` (T38, specs/015-hardware-
 * inventory; design.md T6, F12, § Accessibility "T6 year detail"; AC-8.1, AC-8.4,
 * AC-8.5, AC-8.7): the roll-forward statement (five lines, words and signs), the
 * per-asset table (opening, purchase, depreciation, disposal and closing, so the
 * statement can be reconciled on screen), the Export XLSX control and — for an
 * OPEN year only — the Provisional banner and the Close year button.
 *
 * `ledger:manage` only (a UX gate; the server's 403 is the real one): without it
 * the page renders `PermissionDenied` and calls nothing. A malformed route
 * (unknown entity, a year that is not four digits) is the not-found state with no
 * API call; a 404 from the server (outside scope, before the entity's first
 * year) is the same state.
 *
 * `FiscalYearView` does not say whether the year may be closed (AC-8.5): that is
 * `closable` on the list's summary row, so the page loads both and treats a
 * failure of either as a page failure — Close is never guessed. Close is offered
 * only when the year is open; when it is not `closable` the button is
 * `aria-disabled`, stays focusable and points at "Close {year-1} first.". A
 * closed year has no close and no reopen control anywhere (AC-8.7). After a
 * successful close the page re-renders from the closed view the server returned,
 * announces it and moves focus to the heading (the trigger is gone).
 */

const PAGE_TEST_ID = 'inventory-fiscal-year-detail-page'
const ENTITIES: readonly Entity[] = ['welld_ch', 'welld_it']
const YEAR = /^\d{4}$/

type Outcome =
  | { request: string; route: string; ok: true; view: FiscalYearView; closable: boolean }
  | { request: string; route: string; ok: false; error: unknown }

const holderLabel = (holder: Identity | null): string => {
  const t = strings.yearDetail.assets
  if (holder === null) return t.noHolder
  if (holder.status === 'system') return t.holderSystem
  if (holder.status === 'deleted') return t.holderDeleted
  return holder.name ?? t.holderUnknown
}

function NotFound() {
  const headingRef = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    headingRef.current?.focus()
  }, [])
  const t = strings.yearDetail
  return (
    <section aria-labelledby="year-not-found-heading" data-testid="year-not-found" className="flex flex-col gap-3">
      <h2
        id="year-not-found-heading"
        ref={headingRef}
        tabIndex={-1}
        className="text-lg font-semibold focus:outline-none"
        style={{ fontFamily: 'var(--disp)' }}
      >
        {t.notFound.heading}
      </h2>
      <p className="text-sm" style={{ color: 'var(--soft)' }}>
        {t.notFound.body}
      </p>
      <Link to="/years" className="text-sm underline" style={{ color: 'var(--acc)' }}>
        {t.backToYears}
      </Link>
    </section>
  )
}

export default function FiscalYearDetailPage() {
  const t = strings.yearDetail
  const params = useParams({ strict: false }) as { entity?: string; year?: string }
  const { canManageLedger } = useInventoryCapabilities()
  const reasonId = useId()

  const entity = ENTITIES.find((candidate) => candidate === params.entity)
  const year = params.year !== undefined && YEAR.test(params.year) ? Number(params.year) : undefined
  const valid = entity !== undefined && year !== undefined
  const route = `${entity}:${year}`

  const [attempt, setAttempt] = useState(0)
  const request = `${route}:${attempt}`
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const [closing, setClosing] = useState(false)
  const [statusLine, setStatusLine] = useState('')
  const headingRef = useRef<HTMLHeadingElement>(null)
  const pendingFocus = useRef(false)

  useEffect(() => {
    if (!canManageLedger || !valid) return
    const controller = new AbortController()
    const init = { signal: controller.signal }
    Promise.all([getFiscalYear(entity, year, init), listFiscalYears(entity, init)]).then(
      ([view, list]) => {
        if (controller.signal.aborted) return
        const closable = list.years.find((summary) => summary.year === year)?.closable ?? false
        setOutcome({ request, route, ok: true, view, closable })
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setOutcome({ request, route, ok: false, error })
      },
    )
    return () => controller.abort()
  }, [canManageLedger, valid, entity, year, request, route])

  // Move focus once the heading exists (after a close the trigger is gone).
  useEffect(() => {
    if (pendingFocus.current && headingRef.current) {
      pendingFocus.current = false
      headingRef.current.focus()
    }
  })

  if (!canManageLedger) {
    return (
      <section data-testid={PAGE_TEST_ID}>
        <PermissionDenied />
      </section>
    )
  }

  if (!valid) {
    return (
      <section data-testid={PAGE_TEST_ID}>
        <NotFound />
      </section>
    )
  }

  const current = outcome?.request === request ? outcome : null
  // While a refetch is in flight keep showing the last good view of THIS year.
  const shown = current ?? (outcome !== null && outcome.ok && outcome.route === route ? outcome : null)
  const retry = () => setAttempt((previous) => previous + 1)

  if (current !== null && !current.ok) {
    const { error } = current
    let body
    if (error instanceof ApiError && error.status === 404) body = <NotFound />
    else if (error instanceof ApiError && error.status === 403) body = <PermissionDenied />
    else if (error instanceof ApiError && error.status === 503) {
      body = <ErrorBanner variant="authUnavailable" onRetry={retry} retryLabel={t.retry} />
    } else {
      body = (
        <ErrorBanner
          message={error instanceof ApiError ? (error.detail ?? strings.errors.unknown) : strings.errors.network}
          onRetry={retry}
          retryLabel={t.retry}
        />
      )
    }
    return <section data-testid={PAGE_TEST_ID}>{body}</section>
  }

  if (shown === null || !shown.ok) {
    return (
      <section data-testid={PAGE_TEST_ID} className="flex flex-col gap-2">
        <p role="status" className="sr-only">
          {t.loading}
        </p>
        <SkeletonListRows />
      </section>
    )
  }

  const { view, closable } = shown
  const entityName = strings.common.entity[view.entity]
  const isOpen = view.status === 'open'
  const money = (cents: number) => formatMoney(cents, view.currency)
  const columns = strings.yearDetail.assets.columns

  const onClosed = (closed: FiscalYearView) => {
    setOutcome({ request, route, ok: true, view: closed, closable: false })
    setClosing(false)
    setStatusLine(t.closedAnnouncement(closed.year))
    pendingFocus.current = true
  }

  return (
    <section data-testid={PAGE_TEST_ID} aria-labelledby="year-heading" className="flex flex-col gap-4">
      <Link to="/years" className="text-sm underline" style={{ color: 'var(--acc)' }}>
        {t.backToYears}
      </Link>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <EntityBadge entity={view.entity} />
          <h2
            id="year-heading"
            ref={headingRef}
            tabIndex={-1}
            className="text-lg font-semibold focus:outline-none"
            style={{ fontFamily: 'var(--disp)' }}
          >
            {t.heading(view.year)}
          </h2>
          <span data-testid="year-status" className="inline-flex items-center gap-1 text-sm">
            <span aria-hidden="true">{isOpen ? '◌' : '■'}</span>
            <span>{isOpen ? t.status.open : t.status.closed}</span>
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <ExportYearButton view={view} />
          {isOpen && (
            <button
              type="button"
              aria-disabled={closable ? undefined : true}
              aria-describedby={closable ? undefined : reasonId}
              onClick={() => {
                if (closable) setClosing(true)
              }}
              className="border px-3 py-2 text-sm font-medium aria-disabled:opacity-60"
              style={{ borderColor: 'var(--rule)', color: 'var(--text)' }}
            >
              {t.close.button(view.year)}
            </button>
          )}
        </div>
      </div>
      {isOpen && !closable && (
        <p id={reasonId} className="text-sm" style={{ color: 'var(--soft)' }}>
          {t.close.blocked(view.year - 1)}
        </p>
      )}

      <p role="status" data-testid="year-status-line" className="sr-only">
        {statusLine}
      </p>

      {isOpen ? (
        <p role="status" className="text-sm" style={{ color: 'var(--soft)' }}>
          {t.provisional}
        </p>
      ) : (
        view.closedAt !== null && (
          <p className="text-sm" style={{ color: 'var(--soft)' }}>
            {t.closedOn(formatDate(view.closedAt))}
          </p>
        )
      )}

      <section aria-labelledby="year-statement-heading" className="flex flex-col gap-2">
        <h3
          id="year-statement-heading"
          className="text-base font-semibold"
          style={{ fontFamily: 'var(--disp)', color: 'var(--text)' }}
        >
          {t.statement.heading(view.currency)}
        </h3>
        <RollForwardStatement
          rollForward={view.rollForward}
          currency={view.currency}
          entity={view.entity}
          year={view.year}
        />
      </section>

      <section aria-labelledby="year-assets-heading" className="flex flex-col gap-2">
        <h3
          id="year-assets-heading"
          className="text-base font-semibold"
          style={{ fontFamily: 'var(--disp)', color: 'var(--text)' }}
        >
          {t.assets.heading}
        </h3>
        {view.assets.length === 0 ? (
          <p className="text-sm" style={{ color: 'var(--soft)' }}>
            {t.assets.empty}
          </p>
        ) : (
          <DataTable
            caption={t.assets.caption(entityName, view.year)}
            columns={[
              { id: 'purchaseDate', header: columns.purchaseDate, render: (a) => formatDate(a.purchaseDate) },
              { id: 'description', header: columns.description, rowHeader: true, render: (a) => a.description },
              { id: 'serialNumber', header: columns.serialNumber, render: (a) => a.serialNumber ?? t.assets.noSerial },
              { id: 'heldBy', header: columns.heldBy, render: (a) => holderLabel(a.holder) },
              { id: 'price', header: columns.purchasePrice, numeric: true, render: (a) => money(a.purchasePriceCents) },
              { id: 'opening', header: columns.opening, numeric: true, render: (a) => money(a.openingCents) },
              { id: 'purchases', header: columns.purchases, numeric: true, render: (a) => money(a.purchaseCents) },
              {
                id: 'depreciation',
                header: columns.depreciation,
                numeric: true,
                render: (a) => money(a.depreciationCents),
              },
              { id: 'disposals', header: columns.disposals, numeric: true, render: (a) => money(a.disposalCents) },
              { id: 'closing', header: columns.closing, numeric: true, render: (a) => money(a.closingCents) },
            ]}
            rows={view.assets}
            getRowKey={(a) => a.assetId}
            testId="year-assets-table"
          />
        )}
      </section>

      {closing && isOpen && (
        <CloseYearDialog
          entity={view.entity}
          year={view.year}
          currency={view.currency}
          rollForward={view.rollForward}
          onClosed={onClosed}
          onStale={() => {
            setClosing(false)
            retry()
          }}
          onCancel={() => setClosing(false)}
        />
      )}
    </section>
  )
}
