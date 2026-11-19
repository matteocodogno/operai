/**
 * ExchangeRatesCard — one entity's monthly exchange rates (moved from refund-ui, where it listed WellD CH's CHF rates only;
 * specs/20261119-accounting, design AS5, FA7, FA8, FA9, UX-8 to UX-11, UX-13, UX-15; AC-2.3 to AC-2.5, AC-2.7 to AC-2.9, AC-2.11,
 * AC-7.3, AC-8.4).
 *
 * A table of months (newest first) by the entity's currencies (EUR, USD and GBP for WellD CH). A cell is the rate exactly as the
 * server displays it (mono), where it came from (*Fetched* / *Corrected*) and, with `canManage` (`/v1/me`'s, for the displayed
 * entity), **Correct**; a month the source never published is a *Missing* badge (never an estimate from another month,
 * AC-2.7), with **Correct** so a manager can type one. There is no history drawer and no per-cell history button (UX-8), no who
 * and no when (D18). A **Source** fact says where the rates come from and **Last fetch** states its OUTCOME in words, not only a
 * time (UX-9, closing A-7 of 20261118).
 *
 *   - No official source (`source: null`, WellD Italia, AC-2.11, UX-13). A `StatePanel` says so: no table, no Fetch now, no
 *     last-fetch fact, no auto-fetch, the same for a reader and a manager. It is NOT the lists' "nothing entered yet".
 *   - Auto-fetch. When the GET says `fetchDue` and the person can manage, the card fetches ONCE per mount (per visit: the page
 *     keys it by entity): never again, also after a failure. It reports in the polite status line and banners and never moves
 *     focus; the table stays usable throughout. The request carries no `trigger`: the server derives who asks (D4).
 *   - Fetch now (manage) runs the same fetch on demand and reports what happened: how many months were recorded, nothing new,
 *     a month not published yet, throttled, more months to fetch, switched off, or the failure. A source failure is a 200 with
 *     `outcome: "failed"`, not an HTTP error: the rates already recorded are untouched and the failure stays on screen as a
 *     persistent, non-dismissible warning, derived from the server's `lastFetch`, until a later fetch succeeds (AC-2.8). Readers
 *     see it too.
 *   - Deep link. `month` (`&month=YYYY-MM`, the AC-7.3 link from Refund's export blocker) puts focus on that row's header when the
 *     table first appears. A month that is not in the table says so in the polite status (UX-11): the link is never a dead end.
 *
 * Exactly one state at a time: loading, denied (403 replaces the view), failed (the ladder, UX-15), no source, empty ("No months
 * to show yet"), loaded. A list answering 404 and a write answering 403 reach the frame. The dialog is mounted beside the card
 * (ADR 20261118 dialog-beside-form).
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Badge, Banner, Button, Card, DataTable, FactList, Icon, StatePanel, StatusBadge, formatDateTime } from '@operai/ui'
import type { DataTableColumn } from '@operai/ui'
import { useLoadedResource } from '../hooks/useLoadedResource'
import { ApiError } from '../lib/api'
import { fetchExchangeRates, listExchangeRates } from '../lib/exchangeRatesApi'
import type { ExchangeRateMonth, ExchangeRates, FetchResult, LastFetch, RateCurrency } from '../lib/exchangeRatesApi'
import { statusOf } from '../lib/errors'
import type { EntityId } from '../lib/meApi'
import { monthLabel } from '../lib/monthLabel'
import { RATE_MISSING_MEANING } from '../lib/statusMeaning'
import { strings } from '../strings'
import { LoadFailure, Loading } from './LoadState'
import PermissionDenied from './PermissionDenied'
import RateCorrectionDialog from './RateCorrectionDialog'
import { Saved } from './Saved'

const t = strings.fx

export type ExchangeRatesCardProps = {
  entity: EntityId
  /** `/v1/me`'s `canManage` for this entity: Fetch now and Correct are offered (and the auto-fetch runs). */
  canManage: boolean
  /** `&month=YYYY-MM` deep link: focus that row's header when the table first appears. */
  month?: string
  /** The list answered 404: this entity is not covered any more (UX-12). */
  onEntityGone: () => void
  /** A write answered 403: re-read `/v1/me` (UX-15, AC-3.4). */
  onWriteRefused: () => void
}

type Target = { month: string; currency: RateCurrency }

const buttonId = (target: Target): string => `${target.month}:${target.currency}`

/** The plain reason of a failed fetch, from the API's error code (`timeout`, `http_<status>`, `parse`, …). */
const reasonText = (errorCode: string | null): string => {
  if (errorCode === 'timeout') return t.reason.timeout
  if (errorCode !== null && errorCode.startsWith('http_')) return t.reason.http
  if (errorCode === 'parse') return t.reason.parse
  if (errorCode === 'month_mismatch') return t.reason.monthMismatch
  if (errorCode === 'currency_missing') return t.reason.currencyMissing
  return t.reason.unknown
}

const recordedSomething = (result: FetchResult): boolean =>
  result.attempts.some((attempt) => Object.keys(attempt.recorded ?? {}).length > 0)

/** What a fetch said beyond the persistent failure banner: a confirmation, notes, the switched-off note, an error. */
type FetchNotices = { notes: string[]; disabled: boolean; error: string | null }

const NO_NOTICES: FetchNotices = { notes: [], disabled: false, error: null }

/** The confirmation of a fetch, or `null` when something else (a failure, a note) already explains the result. */
const confirmationOf = (result: FetchResult): string | null => {
  const recordedMonths = result.attempts.filter((attempt) => Object.keys(attempt.recorded ?? {}).length > 0).length
  if (recordedMonths > 0) return t.fetchedOk(recordedMonths)
  // "No new rates" only when nothing else explains the silence: a failure, a switched-off source or a month that
  // is not published yet each have their own message.
  const explained = result.attempts.some((attempt) => attempt.outcome !== 'ok')
  return explained ? null : t.nothingNew
}

const lastFetchText = (lastFetch: LastFetch | null): string => {
  if (lastFetch === null) return t.lastFetch.never
  const at = formatDateTime(lastFetch.at)
  switch (lastFetch.outcome) {
    case 'ok':
      return t.lastFetch.ok(at)
    case 'failed':
      return t.lastFetch.failed(at)
    case 'disabled':
      return t.lastFetch.disabled(at)
    case 'throttled':
      return t.lastFetch.throttled(at)
    case 'not_fetchable':
      return t.lastFetch.notFetchable(at)
  }
}

export default function ExchangeRatesCard({ entity, canManage, month, onEntityGone, onWriteRefused }: ExchangeRatesCardProps) {
  const resource = useLoadedResource(() => listExchangeRates(entity))
  const { replace, reload } = resource
  const entityName = strings.entity[entity]
  // Which fetch is running: the one-per-visit automatic check or a press of Fetch now.
  const [fetching, setFetching] = useState<'auto' | 'manual' | null>(null)
  const [notices, setNotices] = useState<FetchNotices>(NO_NOTICES)
  const [success, setSuccess] = useState<string | null>(null)
  const [correcting, setCorrecting] = useState<Target | null>(null)
  // The Correct buttons, and a request to focus one (a new object each time): the dialog's opener gets focus back.
  const buttons = useRef(new Map<string, HTMLButtonElement>())
  const [focusRequest, setFocusRequest] = useState<{ id: string } | null>(null)
  const autoFetchStarted = useRef(false)

  // The frame's callbacks are read through refs: their identity changes with every `/v1/me` re-read, and a changed identity
  // must not start a request again.
  const goneRef = useRef(onEntityGone)
  const refusedRef = useRef(onWriteRefused)
  useEffect(() => {
    goneRef.current = onEntityGone
    refusedRef.current = onWriteRefused
  })

  useEffect(() => {
    if (focusRequest) buttons.current.get(focusRequest.id)?.focus()
  }, [focusRequest])

  // A list that answers 404: a grant narrowed during the session. The frame re-reads `/v1/me` and falls back, once per answer.
  const failure = resource.status === 'error' ? resource.error : null
  const gone = failure !== null && statusOf(failure) === 404
  useEffect(() => {
    if (gone) goneRef.current()
  }, [gone, failure])

  const runFetch = useCallback(
    async (kind: 'auto' | 'manual') => {
      setFetching(kind)
      setNotices(NO_NOTICES)
      setSuccess(null)
      let result: FetchResult
      try {
        result = await fetchExchangeRates(entity)
      } catch (error) {
        setFetching(null)
        const status = error instanceof ApiError ? error.status : null
        if (status === 403) refusedRef.current()
        if (status === 404) goneRef.current()
        // 422 `no_rate_source` (the entity lost its source meanwhile): the list says so when it is read again.
        if (error instanceof ApiError && error.code === 'no_rate_source') reload()
        setNotices({ ...NO_NOTICES, error: status === 403 ? strings.common.forbidden : t.fetchError })
        return
      }
      // The attempt is the new "last fetch" at once (a failure is a 200 with outcome "failed"); the months follow from the
      // server when something was recorded.
      replace((current) => ({ ...current, lastFetch: result.lastFetch }))
      if (recordedSomething(result)) reload()
      const deferred = result.deferredMonths.length
      setNotices({
        notes: [
          ...result.attempts
            .filter((attempt) => attempt.outcome === 'not_fetchable')
            .map((attempt) => t.notFetchable(monthLabel(attempt.month))),
          // Asked again within 15 minutes: nothing was written, which is information and not an error.
          ...(result.attempts.some((attempt) => attempt.outcome === 'throttled') ? [t.throttled] : []),
          // Only a few months are fetched per call: say that more remain.
          ...(deferred > 0 ? [t.deferred(deferred)] : []),
        ],
        disabled: result.attempts.some((attempt) => attempt.outcome === 'disabled'),
        error: null,
      })
      setSuccess(confirmationOf(result))
      setFetching(null)
    },
    [entity, replace, reload],
  )

  const fetchDue = resource.status === 'loaded' && resource.data.fetchDue
  useEffect(() => {
    if (!canManage || !fetchDue || autoFetchStarted.current) return
    // Once per visit, whatever the outcome: the guard is never reset, so a failure cannot loop.
    autoFetchStarted.current = true
    // Started from a callback, never by setting state in the effect body.
    void Promise.resolve().then(() => runFetch('auto'))
  }, [canManage, fetchDue, runFetch])

  // Denied replaces the view: here the card IS the page, so leaving it out would say nothing (AS5).
  if (resource.status === 'forbidden') return <PermissionDenied />

  const data: ExchangeRates | null = resource.status === 'loaded' ? resource.data : null
  const hasSource = data !== null && data.source !== null
  const listed = month !== undefined && data !== null && data.months.some((row) => row.month === month)
  const unlistedMonth = month !== undefined && hasSource && !listed ? month : null

  const register = (id: string) => (node: HTMLButtonElement | null) => {
    if (node) buttons.current.set(id, node)
    else buttons.current.delete(id)
  }

  const closeCorrection = (target: Target) => {
    setCorrecting(null)
    setFocusRequest({ id: buttonId(target) })
  }

  const handleSaved = (row: ExchangeRateMonth | null, target: Target) => {
    setNotices(NO_NOTICES)
    if (row === null) {
      // The server recorded nothing (the rate is the one in effect): nothing to confirm, read the list again.
      setSuccess(null)
      reload()
    } else {
      replace((current) => ({ ...current, months: current.months.map((other) => (other.month === row.month ? row : other)) }))
      setSuccess(t.correction.saved(target.currency, monthLabel(target.month)))
    }
    closeCorrection(target)
  }

  const renderCell = (row: ExchangeRateMonth, currency: RateCurrency): ReactNode => {
    const target: Target = { month: row.month, currency }
    const rate = row.rates[currency]
    const label = monthLabel(row.month)
    const correct = canManage && (
      <Button
        ref={register(buttonId(target))}
        size="sm"
        variant="ghost"
        iconOnly
        aria-haspopup="dialog"
        aria-label={t.correctLabel(currency, label)}
        title={t.correct}
        onClick={() => setCorrecting(target)}
        data-testid={`accounting-fx-correct-${row.month}-${currency}`}
      >
        <Icon name="pencil" />
      </Button>
    )

    if (rate === undefined || rate.status === 'missing') {
      return (
        <div
          role="group"
          aria-label={t.cellMissingLabel(currency, label)}
          className="flex flex-wrap items-center gap-1.5"
          data-testid={`accounting-fx-cell-${row.month}-${currency}`}
        >
          <StatusBadge status={RATE_MISSING_MEANING}>{t.origin.missing}</StatusBadge>
          {correct}
        </div>
      )
    }

    const origin = t.origin[rate.status]
    return (
      <div
        role="group"
        aria-label={t.cellLabel(currency, label, rate.rate, origin)}
        className="flex flex-wrap items-center gap-1.5"
        data-testid={`accounting-fx-cell-${row.month}-${currency}`}
      >
        <span className="font-mono tabular-nums">{rate.rate}</span>
        <Badge tone={rate.status === 'corrected' ? 'accent' : 'neutral'}>{origin}</Badge>
        {correct}
      </div>
    )
  }

  const columns: DataTableColumn<ExchangeRateMonth>[] = [
    { id: 'month', header: t.columns.month, rowHeader: true, render: (row) => monthLabel(row.month) },
    ...(data?.currencies ?? []).map(
      (currency): DataTableColumn<ExchangeRateMonth> => ({
        id: currency,
        header: currency,
        render: (row) => renderCell(row, currency),
      }),
    ),
  ]

  const lastFetch: LastFetch | null = data?.lastFetch ?? null
  const showDisabled = notices.disabled || lastFetch?.outcome === 'disabled'
  const sourceName = data?.source?.name === 'bazg' ? t.source.bazg : (data?.source?.name ?? '')

  const correctingRow = correcting === null ? null : (data?.months.find((row) => row.month === correcting.month) ?? null)
  const correctingRate = correctingRow && correcting ? correctingRow.rates[correcting.currency] : undefined

  return (
    <>
      <Card
        title={t.title(entityName)}
        data-testid="accounting-fx-card"
        action={
          canManage && hasSource ? (
            <Button
              size="sm"
              busy={fetching === 'manual'}
              disabled={fetching === 'auto'}
              onClick={() => void runFetch('manual')}
              data-testid="accounting-fx-fetch-now"
            >
              {fetching === 'manual' ? t.fetching : t.fetchNow}
            </Button>
          ) : undefined
        }
      >
        {data !== null && hasSource && (
          <>
            <p className="text-sm text-soft mb-4">{t.description(data.ownCurrency)}</p>
            {!canManage && (
              <p className="text-sm text-soft mb-4" data-testid="accounting-fx-read-only">
                {strings.common.readOnly(strings.common.readOnlyWhat.rates)}
              </p>
            )}
          </>
        )}

        {/* One polite region, mounted before anything is said in it: the automatic check and the unlisted deep-link month. */}
        <div role="status" className="flex flex-col gap-1" data-testid="accounting-fx-status">
          {fetching === 'auto' && (
            <p className="text-sm text-soft" data-testid="accounting-fx-checking">
              {t.checking}
            </p>
          )}
          {unlistedMonth !== null && (
            <p className="text-sm text-soft" data-testid="accounting-fx-deeplink-note">
              {t.deepLink.notListed(monthLabel(unlistedMonth))}
            </p>
          )}
        </div>

        {resource.status === 'loading' && <Loading label={t.loading} rows={4} />}

        {resource.status === 'error' && <LoadFailure error={resource.error} onRetry={resource.reload} message={t.loadError} />}

        {data !== null && !hasSource && (
          // UX-13, AC-2.11: not "nothing entered yet" — nothing can be fetched or kept for this entity yet.
          <StatePanel title={t.noSource.title(entityName)} headingLevel={4} testId="accounting-fx-no-source">
            {t.noSource.body}
          </StatePanel>
        )}

        {data !== null && hasSource && (
          <div className="flex flex-col gap-3">
            <FactList
              items={[
                { id: 'source', term: t.source.term, value: sourceName },
                { id: 'last-fetch', term: t.lastFetch.term, value: lastFetchText(lastFetch) },
              ]}
              testId="accounting-fx-facts"
            />

            {lastFetch?.outcome === 'failed' && (
              // Persistent (AC-2.8): no ×, derived from the server's last attempt, gone only when a later fetch works. Readers see it.
              <Banner tone="warning" live="polite" title={t.lastFetch.failedTitle} data-testid="accounting-fx-failed">
                {t.lastFetch.failedBody(formatDateTime(lastFetch.at), reasonText(lastFetch.errorCode))}
              </Banner>
            )}

            {showDisabled && (
              <Banner tone="info" data-testid="accounting-fx-disabled">
                {canManage ? t.disabled : t.disabledReader}
              </Banner>
            )}

            {notices.notes.map((note) => (
              <Banner
                key={note}
                tone="info"
                onDismiss={() =>
                  setNotices((current) => ({ ...current, notes: current.notes.filter((other) => other !== note) }))
                }
                dismissLabel={strings.common.dismiss}
                data-testid="accounting-fx-note"
              >
                {note}
              </Banner>
            ))}

            {notices.error && (
              <Banner
                tone="danger"
                onDismiss={() => setNotices((current) => ({ ...current, error: null }))}
                dismissLabel={strings.common.dismiss}
                data-testid="accounting-fx-fetch-error"
              >
                {notices.error}
              </Banner>
            )}

            {success && <Saved message={success} onDismiss={() => setSuccess(null)} />}

            {data.months.length === 0 ? (
              <StatePanel title={t.empty.title} headingLevel={4} testId="accounting-empty">
                {t.empty.body}
              </StatePanel>
            ) : (
              <DataTable
                caption={t.caption(entityName)}
                columns={columns}
                rows={data.months}
                getRowKey={(row) => row.month}
                focusRowKey={listed ? (month ?? null) : null}
                testId="accounting-fx-table"
                rowTestIdPrefix="accounting-fx-row"
              />
            )}
          </div>
        )}
      </Card>

      {correcting && correctingRate && data && (
        <RateCorrectionDialog
          entity={entity}
          ownCurrency={data.ownCurrency}
          currencies={data.currencies}
          month={correcting.month}
          currency={correcting.currency}
          rate={correctingRate}
          onCancel={() => closeCorrection(correcting)}
          onSaved={(row) => handleSaved(row, correcting)}
          onForbidden={onWriteRefused}
          onGone={onEntityGone}
        />
      )}
    </>
  )
}
