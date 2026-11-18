/**
 * AccountingExportCard — the accounting CSV of a batch (specs/20261118-refund-accounting-export, design S10, F9, UX-6, UX-7,
 * UX-9, UX-12; AC-6.1, AC-6.5, AC-6.6, AC-6.7, AC-6.9, AC-6.11, AC-7.2). It sits on the batch page under the summary
 * card and loads on its own: the check may call the official rate source and take several seconds, and the rest
 * of the page never waits for it. The page does not render it at all for a discarded batch (AC-6.9).
 *
 *   - Ready: how many rows will be exported, and how many WellD Italia lines are left out, said only when above zero
 *     (G12). With no rows, the file will hold only its header (AC-6.7), and Download is still offered.
 *   - Blocked: a missing exchange rate (AC-6.5) or a line with no account or VAT code (AC-7.2) is a warning, not an
 *     error (UX-6): the batch can still be paid or discarded, and the card says so. The lists name what is missing and
 *     link to where it is fixed: Settings at that month (only with `settings:read`; otherwise "ask an administrator")
 *     and the request. **Check again** loads the summary again. Download stays on screen, `aria-disabled` with its
 *     reason as its description (UX-7), so it can be reached to learn why.
 *   - Out of scope (403): a short info note and no button (AC-6.11); everyone who can open the batch can ask "why can't
 *     I export?".
 *   - Download: the bytes are fetched through the authenticated client and saved from a `Blob` (UX-12), under a
 *     filename built here from the cutoff and the batch id. The button is busy while it runs and a second press is
 *     ignored, so one click writes one row in the server's export log (AC-6.10). If the summary changed since the
 *     check (409 `accounting_export_blocked`), the card switches to Blocked from the body of that answer; a 409
 *     `batch_discarded` reports to the page, which removes the card; any other failure, a failed log write
 *     included, is "No file was produced".
 */

import { useEffect, useId, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { Banner, Button, Card, SkeletonRows, VisuallyHidden } from '@operai/ui'
import { strings } from '../strings'
import { usePermissions } from 'shell/session'
import {
  accountingExportFileName,
  blockedSummary,
  downloadAccountingCsv,
  getAccountingExport,
} from '../lib/accountingExportApi'
import type { AccountingExportSummary, UnclassifiedLineBlocker } from '../lib/accountingExportApi'
import { formatDate } from '../lib/dates'
import { expenseTypeLabel } from '../lib/expenseTypes'
import type { ExpenseType } from '../lib/expenseTypes'
import { monthLabel } from '../lib/monthLabel'
import { ApiError } from '../lib/refundApi'
import { useLoadedResource } from '../lib/useLoadedResource'
import ErrorBanner from './ErrorBanner'
import SuccessBanner from './SuccessBanner'

const t = strings.pages.batchDetail.accountingExport

export type AccountingExportCardProps = {
  batchId: string
  /** The batch's cutoff instant: its date is in the filename. */
  cutoff: string
  /** The batch turned out to be discarded (409 `batch_discarded`): the page reloads it and drops this card. */
  onBatchDiscarded: () => void
}

/** What a line is called when it has no receipt number yet: its date and type (`expenseTypeLabel` keeps an unknown type as sent). */
const lineName = (line: UnclassifiedLineBlocker): string =>
  line.receiptNumber ??
  `${line.date ? formatDate(line.date) : ''} ${expenseTypeLabel(line.type as ExpenseType)}`.trim()

const missingWhat = (line: UnclassifiedLineBlocker): string =>
  line.missing.length === 1
    ? line.missing[0] === 'account'
      ? t.blocked.missingWhat.account
      : t.blocked.missingWhat.vatCode
    : t.blocked.missingWhat.both

export default function AccountingExportCard({ batchId, cutoff, onBatchDiscarded }: AccountingExportCardProps) {
  const { permissions } = usePermissions()
  const canOpenSettings = permissions.some(
    (permission) => permission.resource === 'settings' && permission.action === 'read',
  )
  const reasonId = useId()
  const resource = useLoadedResource(() => getAccountingExport(batchId))
  const { replace } = resource
  const [downloading, setDownloading] = useState(false)
  const [rechecking, setRechecking] = useState(false)
  const [downloaded, setDownloaded] = useState<string | null>(null)
  const [downloadError, setDownloadError] = useState<string | null>(null)
  const [turnedBlocked, setTurnedBlocked] = useState(false)
  const [denied, setDenied] = useState(false)
  const [recheckFailed, setRecheckFailed] = useState(false)

  // A batch discarded since this page loaded: the page removes the card (AC-6.9).
  const isDiscarded = (error: unknown): boolean => error instanceof ApiError && error.code === 'batch_discarded'
  const discardedOnLoad = resource.status === 'error' && isDiscarded(resource.error)
  useEffect(() => {
    if (discardedOnLoad) onBatchDiscarded()
  }, [discardedOnLoad, onBatchDiscarded])
  if (discardedOnLoad) return null

  const summary: AccountingExportSummary | null = resource.status === 'loaded' ? resource.data : null
  // Any 403: the user is not allowed this export (out of the WellD CH review scope, AC-6.11).
  const outOfScope = resource.status === 'forbidden' || denied

  const recheck = async () => {
    if (rechecking) return
    setRechecking(true)
    setRecheckFailed(false)
    try {
      replace(await getAccountingExport(batchId))
    } catch (error) {
      if (isDiscarded(error)) onBatchDiscarded()
      else if (error instanceof ApiError && error.status === 403) setDenied(true)
      else setRecheckFailed(true)
    } finally {
      setRechecking(false)
    }
  }

  const download = async () => {
    if (downloading || summary === null || !summary.exportable) return
    setDownloading(true)
    setDownloadError(null)
    setDownloaded(null)
    setTurnedBlocked(false)
    let objectUrl: string | null = null
    try {
      const blob = await downloadAccountingCsv(batchId)
      objectUrl = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = objectUrl
      anchor.download = accountingExportFileName(cutoff, batchId)
      anchor.click()
      setDownloaded(t.downloaded(summary.rowCount))
    } catch (error) {
      const blocked = blockedSummary(error)
      if (blocked !== null) {
        // It became blocked between the check and the download: the answer carries what blocks it.
        replace(blocked)
        setTurnedBlocked(true)
      } else if (error instanceof ApiError && error.code === 'accounting_export_blocked') {
        replace((current) => ({ ...current, exportable: false }))
        setTurnedBlocked(true)
        void recheck()
      } else if (isDiscarded(error)) {
        onBatchDiscarded()
      } else if (error instanceof ApiError && error.status === 403) {
        setDenied(true)
      } else {
        // Any other failure, a failed export-log write included (AC-6.10), produced no file.
        setDownloadError(t.downloadError)
      }
    } finally {
      // The click has already been dispatched, so releasing the Blob handle does not affect the download.
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl)
      setDownloading(false)
    }
  }

  const blocked = summary !== null && !summary.exportable

  return (
    <Card title={t.title} data-testid="accounting-export-card">
      <p className="mb-3 text-sm text-soft">{t.description}</p>

      {resource.status === 'loading' && (
        <>
          <VisuallyHidden live>{t.loading}</VisuallyHidden>
          <SkeletonRows rows={2} actions={0} testId="accounting-export-skeleton" />
        </>
      )}

      {resource.status === 'error' && <ErrorBanner message={t.loadError} onRetry={resource.reload} />}

      {outOfScope && (
        <Banner tone="info" live="off" data-testid="accounting-export-denied">
          {t.denied}
        </Banner>
      )}

      {summary !== null && !outOfScope && (
        <div className="flex flex-col gap-3">
          {rechecking && <VisuallyHidden live>{t.loading}</VisuallyHidden>}
          {recheckFailed && <ErrorBanner message={t.loadError} onRetry={() => void recheck()} />}

          {blocked ? (
            <>
              {turnedBlocked && (
                <p role="alert" className="form-error" data-testid="accounting-export-turned-blocked">
                  {t.blocked.turnedBlocked}
                </p>
              )}
              <Banner
                tone="warning"
                live="off"
                title={t.blocked.title}
                actions={
                  <Button
                    size="sm"
                    busy={rechecking}
                    onClick={() => {
                      setTurnedBlocked(false)
                      void recheck()
                    }}
                    data-testid="accounting-export-check-again"
                  >
                    {t.blocked.checkAgain}
                  </Button>
                }
                data-testid="accounting-export-blocked"
              >
                <p className="m-0">{t.blocked.intro}</p>

                {summary.blockers.missingRates.length > 0 && (
                  <section className="mt-3" data-testid="accounting-export-missing-rates">
                    <h4 className="m-0 text-sm font-medium">{t.blocked.missingRates}</h4>
                    <ul className="m-0 mt-1 flex list-none flex-col gap-1 p-0">
                      {summary.blockers.missingRates.map((rate) => (
                        <li key={`${rate.currency}:${rate.month}`} className="flex flex-wrap items-center gap-x-3">
                          <span>{t.blocked.rateItem(rate.currency, monthLabel(rate.month))}</span>
                          {canOpenSettings && (
                            <Link
                              to="/settings"
                              search={{ section: 'exchange-rates', month: rate.month }}
                              className="link text-sm"
                              aria-label={`${strings.pages.reviewDetail.classification.openRates}: ${t.blocked.rateItem(rate.currency, monthLabel(rate.month))}`}
                            >
                              {strings.pages.reviewDetail.classification.openRates}
                            </Link>
                          )}
                        </li>
                      ))}
                    </ul>
                    {!canOpenSettings && <p className="m-0 mt-1 text-sm">{t.blocked.askAdmin}</p>}
                  </section>
                )}

                {summary.blockers.unclassifiedLines.length > 0 && (
                  <section className="mt-3" data-testid="accounting-export-unclassified">
                    <h4 className="m-0 text-sm font-medium">{t.blocked.unclassified}</h4>
                    <ul className="m-0 mt-1 flex list-none flex-col gap-1 p-0">
                      {summary.blockers.unclassifiedLines.map((line) => {
                        const text = t.blocked.unclassifiedItem(line.employee, lineName(line), missingWhat(line))
                        return (
                          <li key={line.lineId} className="flex flex-wrap items-center gap-x-3">
                            <span>{text}</span>
                            <Link
                              to="/review/$id"
                              params={{ id: line.requestId }}
                              className="link text-sm"
                              aria-label={`${t.blocked.openRequest}: ${text}`}
                            >
                              {t.blocked.openRequest}
                            </Link>
                          </li>
                        )
                      })}
                    </ul>
                  </section>
                )}

                {summary.blockers.unnumberedLines.length > 0 && (
                  <section className="mt-3" data-testid="accounting-export-unnumbered">
                    <h4 className="m-0 text-sm font-medium">{t.blocked.unnumbered}</h4>
                    <p className="m-0 mt-1 text-sm">{t.blocked.unnumberedBody}</p>
                  </section>
                )}

                {summary.fetchAttempted && (
                  <p className="m-0 mt-3 text-sm" data-testid="accounting-export-fetch-tried">
                    {t.blocked.fetchTried}
                  </p>
                )}
              </Banner>
            </>
          ) : (
            <div className="flex flex-col gap-1 text-sm" data-testid="accounting-export-ready">
              <p className="m-0">{summary.rowCount === 0 ? t.headerOnly : t.rows(summary.rowCount)}</p>
              {summary.excludedLineCount > 0 && (
                <p className="m-0 text-soft" data-testid="accounting-export-excluded">
                  {t.excluded(summary.excludedLineCount)}
                </p>
              )}
            </div>
          )}

          <SuccessBanner message={downloaded} onDismiss={() => setDownloaded(null)} testId="accounting-export-downloaded" />

          <div className="flex flex-wrap items-center justify-end gap-3">
            {downloadError && (
              <span role="alert" className="field-error" data-testid="accounting-export-download-error">
                {downloadError}
              </span>
            )}
            {blocked && (
              <VisuallyHidden>
                <span id={reasonId}>{t.blocked.reason}</span>
              </VisuallyHidden>
            )}
            <Button
              variant="secondary"
              busy={downloading}
              aria-disabled={blocked || undefined}
              aria-describedby={blocked ? reasonId : undefined}
              onClick={() => void download()}
              data-testid="accounting-export-download"
            >
              {downloading ? t.downloading : t.download}
            </Button>
          </div>
        </div>
      )}
    </Card>
  )
}
