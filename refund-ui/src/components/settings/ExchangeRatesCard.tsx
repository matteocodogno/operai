/**
 * ExchangeRatesCard — the monthly CHF exchange rates (specs/20261118-refund-accounting-export, design S5, F8, UX-10,
 * UX-11; AC-5.2, AC-5.3, AC-5.5, AC-5.6, AC-5.7).
 *
 * A table of months (newest first) by EUR, USD and GBP. A cell is the rate exactly as the server displays it
 * (mono), where it came from (*Fetched* / *Corrected*) and, for people with `settings:manage`, **Correct**; a month
 * the source never published is a *Missing* badge, with **Correct** so an administrator can type one. A **History**
 * icon button opens the shared change-history drawer for that one rate. The last fetch is always stated.
 *
 *   - Auto-fetch. When the GET says `fetchDue` and the user can manage, the card fetches ONCE per visit (this
 *     component mounts only while its tab is open): never again, also after a failure. It reports in a polite
 *     status line and banners and never moves focus; the table stays usable throughout.
 *   - Fetch now (manage) runs the same fetch on demand. A source failure is a 200 with `outcome: "failed"`, not an
 *     HTTP error: the rates already recorded are untouched and the failure stays on screen as a persistent,
 *     non-dismissible warning, derived from the server's `lastFetch`, until a later fetch succeeds (AC-5.6).
 *   - Deep link. `month` (`&month=YYYY-MM`, from the export's missing-rate blocker) puts focus on that row's header
 *     when the table first appears; a month outside the window is ignored.
 *
 * Dialogs and the drawer are mounted beside the card (ADR 20261118 dialog-beside-form). Without `settings:manage` the
 * card is read-only; a 403 that arrives anyway leaves it out (UX-9).
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  Badge,
  Banner,
  Button,
  Card,
  DataTable,
  FactList,
  Icon,
  SkeletonRows,
  StatePanel,
  StatusBadge,
  VisuallyHidden,
  formatDateTime,
} from '@operai/ui'
import type { DataTableColumn } from '@operai/ui'
import { strings } from '../../strings'
import { fetchExchangeRates, listExchangeRates } from '../../lib/exchangeRatesApi'
import type {
  ExchangeRateMonth,
  ExchangeRates,
  FetchResult,
  LastFetch,
  RateCurrency,
  RateHistoryEntry,
} from '../../lib/exchangeRatesApi'
import { monthLabel } from '../../lib/monthLabel'
import { ApiError } from '../../lib/refundApi'
import { RATE_MISSING_MEANING } from '../../lib/statusMeaning'
import { useLoadedResource } from '../../lib/useLoadedResource'
import ChangeHistoryDrawer from '../ChangeHistoryDrawer'
import ErrorBanner from '../ErrorBanner'
import SuccessBanner from '../SuccessBanner'
import RateCorrectionDialog from './RateCorrectionDialog'

const t = strings.settings.fx
const tc = strings.settings.catalog
const th = strings.settings.history

const CURRENCIES: readonly RateCurrency[] = ['EUR', 'USD', 'GBP']

export type ExchangeRatesCardProps = {
  /** `settings:manage`: Fetch now and Correct are offered (and the auto-fetch runs). */
  canManage: boolean
  /** `&month=YYYY-MM` deep link: focus that row's header when the table first appears. */
  month?: string
}

type Target = { month: string; currency: RateCurrency }

const buttonId = (target: Target, purpose: 'correct' | 'history'): string =>
  `${purpose}:${target.month}:${target.currency}`

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

export default function ExchangeRatesCard({ canManage, month }: ExchangeRatesCardProps) {
  const resource = useLoadedResource(() => listExchangeRates())
  const { replace, reload } = resource
  // Which fetch is running: the one-per-visit automatic check or a press of Fetch now.
  const [fetching, setFetching] = useState<'auto' | 'manual' | null>(null)
  const [notices, setNotices] = useState<FetchNotices>(NO_NOTICES)
  const [success, setSuccess] = useState<string | null>(null)
  const [correcting, setCorrecting] = useState<Target | null>(null)
  const [history, setHistory] = useState<Target | null>(null)
  // The icon buttons that open a dialog or the drawer, and a request to focus one (a new object each time).
  const buttons = useRef(new Map<string, HTMLButtonElement>())
  const [focusRequest, setFocusRequest] = useState<{ id: string } | null>(null)
  const autoFetchStarted = useRef(false)

  useEffect(() => {
    if (focusRequest) buttons.current.get(focusRequest.id)?.focus()
  }, [focusRequest])

  const runFetch = useCallback(
    async (kind: 'auto' | 'manual') => {
      setFetching(kind)
      setNotices(NO_NOTICES)
      setSuccess(null)
      let result: FetchResult
      try {
        result = await fetchExchangeRates()
      } catch (error) {
        setFetching(null)
        setNotices({
          ...NO_NOTICES,
          error: error instanceof ApiError && error.status === 403 ? tc.forbidden : t.fetchError,
        })
        return
      }
      // The attempt is the new "last fetch" at once (a failure is a 200 with outcome "failed"); the months follow
      // from the server when something was recorded.
      replace((current) => ({ ...current, lastFetch: result.lastFetch }))
      if (recordedSomething(result)) reload()
      setNotices({
        notes: result.attempts
          .filter((attempt) => attempt.outcome === 'not_fetchable')
          .map((attempt) => t.notFetchable(monthLabel(attempt.month))),
        disabled: result.attempts.some((attempt) => attempt.outcome === 'disabled'),
        error: null,
      })
      setSuccess(confirmationOf(result))
      setFetching(null)
    },
    [replace, reload],
  )

  const fetchDue = resource.status === 'loaded' && resource.data.fetchDue
  useEffect(() => {
    if (!canManage || !fetchDue || autoFetchStarted.current) return
    // Once per visit, whatever the outcome: the guard is never reset, so a failure cannot loop.
    autoFetchStarted.current = true
    // Started from a callback, never by setting state in the effect body.
    void Promise.resolve().then(() => runFetch('auto'))
  }, [canManage, fetchDue, runFetch])

  // A 403 that arrives anyway: the card is left out (UX-9).
  if (resource.status === 'forbidden') return null

  const data: ExchangeRates | null = resource.status === 'loaded' ? resource.data : null
  const rowOf = (target: Target | null): ExchangeRateMonth | null =>
    target === null ? null : (data?.months.find((row) => row.month === target.month) ?? null)

  const register = (id: string) => (node: HTMLButtonElement | null) => {
    if (node) buttons.current.set(id, node)
    else buttons.current.delete(id)
  }

  const closeCorrection = (target: Target) => {
    setCorrecting(null)
    setFocusRequest({ id: buttonId(target, 'correct') })
  }
  const closeHistory = (target: Target) => {
    setHistory(null)
    setFocusRequest({ id: buttonId(target, 'history') })
  }

  const handleSaved = (saved: ExchangeRateMonth, target: Target) => {
    replace((current) => ({
      ...current,
      months: current.months.map((row) => (row.month === saved.month ? saved : row)),
    }))
    setNotices(NO_NOTICES)
    setSuccess(t.correction.saved(target.currency, monthLabel(target.month)))
    closeCorrection(target)
  }

  const renderCell = (row: ExchangeRateMonth, currency: RateCurrency): ReactNode => {
    const target: Target = { month: row.month, currency }
    const rate = row.rates[currency]
    const label = monthLabel(row.month)
    const correct = canManage && (
      <Button
        ref={register(buttonId(target, 'correct'))}
        size="sm"
        variant="ghost"
        iconOnly
        aria-haspopup="dialog"
        aria-label={t.correctLabel(currency, label)}
        title={t.correct}
        onClick={() => setCorrecting(target)}
        data-testid={`settings-fx-correct-${row.month}-${currency}`}
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
          data-testid={`settings-fx-cell-${row.month}-${currency}`}
        >
          <StatusBadge status={RATE_MISSING_MEANING}>{t.missing}</StatusBadge>
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
        data-testid={`settings-fx-cell-${row.month}-${currency}`}
      >
        <span className="font-mono tabular-nums">{rate.rate}</span>
        <Badge tone={rate.status === 'corrected' ? 'accent' : 'neutral'}>{origin}</Badge>
        {correct}
        <Button
          ref={register(buttonId(target, 'history'))}
          size="sm"
          variant="ghost"
          iconOnly
          aria-haspopup="dialog"
          aria-label={th.openLabel(t.historyLabel(currency, label))}
          title={th.open}
          onClick={() => setHistory(target)}
          data-testid={`settings-fx-history-${row.month}-${currency}`}
        >
          <Icon name="clock" />
        </Button>
      </div>
    )
  }

  const columns: DataTableColumn<ExchangeRateMonth>[] = [
    { id: 'month', header: t.columns.month, rowHeader: true, render: (row) => monthLabel(row.month) },
    ...CURRENCIES.map(
      (currency): DataTableColumn<ExchangeRateMonth> => ({
        id: currency,
        header: currency,
        render: (row) => renderCell(row, currency),
      }),
    ),
  ]

  const lastFetch: LastFetch | null = data?.lastFetch ?? null
  const lastFetchValue =
    lastFetch === null
      ? t.lastFetch.never
      : lastFetch.outcome === 'ok'
        ? t.lastFetch.ok(formatDateTime(lastFetch.at))
        : formatDateTime(lastFetch.at)
  const showDisabled = notices.disabled || lastFetch?.outcome === 'disabled'

  const correctingRow = rowOf(correcting)
  const correctingRate = correctingRow && correcting ? correctingRow.rates[correcting.currency] : undefined
  const historyRow = rowOf(history)
  const historyRate = historyRow && history ? historyRow.rates[history.currency] : undefined

  return (
    <>
      <Card
        title={t.title}
        data-testid="settings-fx-card"
        action={
          canManage && (
            <Button
              size="sm"
              busy={fetching === 'manual'}
              disabled={fetching === 'auto'}
              onClick={() => void runFetch('manual')}
              data-testid="settings-fx-fetch-now"
            >
              {fetching === 'manual' ? t.fetching : t.fetchNow}
            </Button>
          )
        }
      >
        <p className="text-sm text-soft mb-4">{t.description}</p>

        {resource.status === 'loading' && (
          <>
            <VisuallyHidden live>{t.loading}</VisuallyHidden>
            <SkeletonRows rows={4} testId="skeleton-list-rows" />
          </>
        )}

        {resource.status === 'error' && <ErrorBanner message={t.loadError} onRetry={resource.reload} />}

        {data && (
          <div className="flex flex-col gap-3">
            <FactList
              items={[{ id: 'last-fetch', term: t.lastFetch.term, value: lastFetchValue }]}
              testId="settings-fx-last-fetch"
            />

            {fetching === 'auto' && (
              <p role="status" className="text-sm text-soft" data-testid="settings-fx-checking">
                {t.checking}
              </p>
            )}

            {lastFetch?.outcome === 'failed' && (
              // Persistent (AC-5.6): no ×, derived from the server's last attempt, gone only when a later fetch works.
              <Banner tone="warning" live="polite" title={t.lastFetch.failedTitle} data-testid="settings-fx-failed">
                {t.lastFetch.failedBody(formatDateTime(lastFetch.at), reasonText(lastFetch.errorCode))}
              </Banner>
            )}

            {showDisabled && (
              <Banner tone="info" data-testid="settings-fx-disabled">
                {t.disabled}
              </Banner>
            )}

            {notices.notes.map((note) => (
              <Banner
                key={note}
                tone="info"
                onDismiss={() =>
                  setNotices((current) => ({ ...current, notes: current.notes.filter((other) => other !== note) }))
                }
                dismissLabel={strings.settings.dismiss}
                data-testid="settings-fx-note"
              >
                {note}
              </Banner>
            ))}

            {notices.error && (
              <Banner
                tone="danger"
                onDismiss={() => setNotices((current) => ({ ...current, error: null }))}
                dismissLabel={strings.settings.dismiss}
                data-testid="settings-fx-fetch-error"
              >
                {notices.error}
              </Banner>
            )}

            <SuccessBanner message={success} onDismiss={() => setSuccess(null)} testId="settings-fx-success" />

            {data.months.length === 0 ? (
              <StatePanel title={t.empty.title} headingLevel={4} testId="settings-fx-empty">
                {t.empty.body}
              </StatePanel>
            ) : (
              <DataTable
                caption={t.caption}
                columns={columns}
                rows={data.months}
                getRowKey={(row) => row.month}
                focusRowKey={month !== undefined && data.months.some((row) => row.month === month) ? month : null}
                testId="settings-fx-table"
                rowTestIdPrefix="settings-fx-row"
              />
            )}
          </div>
        )}
      </Card>

      {correcting && correctingRate && (
        <RateCorrectionDialog
          month={correcting.month}
          currency={correcting.currency}
          rate={correctingRate}
          onCancel={() => closeCorrection(correcting)}
          onSaved={(row) => handleSaved(row, correcting)}
        />
      )}

      {history && historyRate && historyRate.status !== 'missing' && (
        <ChangeHistoryDrawer<RateHistoryEntry>
          subject={t.historyLabel(history.currency, monthLabel(history.month))}
          rows={historyRate.history}
          valueColumns={[
            {
              id: 'rate',
              header: t.history.rateColumn,
              render: (entry) => <span className="font-mono">{entry.rate}</span>,
            },
            { id: 'origin', header: t.history.originColumn, render: (entry) => t.origin[entry.origin] },
          ]}
          onClose={() => closeHistory(history)}
        />
      )}
    </>
  )
}
