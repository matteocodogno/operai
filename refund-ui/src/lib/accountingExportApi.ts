/**
 * accountingExportApi — the batch accounting export (specs/20261118-refund-accounting-export, plan.md § API contracts
 * → Export): the pre-download summary and the file itself. `request:review` with a scope covering WellD CH.
 *
 * Accounting sign-off (T71, specs/20261118 SO-6, SO-12, 2026-11-19): the file is an Excel workbook (`.xlsx`), served
 * from `GET /batches/:id/accounting-export/file`; the old `/csv` route answers 404 and is never called.
 *
 * `downloadAccountingFile` returns `response.blob()`, never `.text()`: a workbook is a ZIP of binary parts, and any
 * text decoding would corrupt it; the Blob keeps every byte exactly as the server wrote them, so the saved file is
 * the one that was logged and hashed (UX-12). The filename is built by the caller (`accountingExportFileName`), not
 * read from `Content-Disposition`, which a browser on another origin cannot read unless the server exposes it (G9).
 *
 * specs/20261119-accounting: the summary also says how many lines get their exchange rate at this export
 * (`ratePendingLineCount`, AC-5.6), why each missing rate is missing (`reason`, G7), that Accounting cannot be read
 * (`blockers.accountingUnavailable`, AC-6.6) and whether the person may open Accounting's rates
 * (`viewer.canOpenAccountingRates`, AC-7.3). The currency type is local: refund-ui no longer reads the rates.
 *
 * Refusals are `ApiError`s: 403 `accounting_export_out_of_scope` (AC-6.11), 409 `batch_discarded` (AC-6.9),
 * 404, and, on the file only, 409 `accounting_export_blocked` whose body IS the summary (G10). `blockedSummary`
 * reads that body with a guard. A blocker line names an account and nothing else (AC-3.11, SO-4): approval, release
 * and export need no VAT code.
 */

import { apiFetch } from 'shell/session'
import type { MissingValue } from './accountingApi'
import { ApiError, getJson, refundApiBase, throwFromResponse } from './refundApi'

/** The currencies a WellD CH line can be in besides CHF (the rates Accounting keeps). */
export type RateCurrency = 'EUR' | 'USD' | 'GBP'

/** Why a rate is missing, as Accounting answered the consumer read (G7): never published yet, the fetch failed, no source. */
export type MissingRateReason = 'not_published' | 'fetch_failed' | 'no_source'

const RATE_REASONS: readonly MissingRateReason[] = ['not_published', 'fetch_failed', 'no_source']
const asReason = (value: unknown): MissingRateReason | null =>
  RATE_REASONS.find((reason) => reason === value) ?? null

/** `reason` is `null` when the answer carries none (or one this client does not know): the item then says no reason. */
export type MissingRateBlocker = { currency: RateCurrency; month: string; reason: MissingRateReason | null }

export type UnclassifiedLineBlocker = {
  lineId: string
  requestId: string
  date: string
  type: string
  employee: string
  receiptNumber: string | null
  missing: MissingValue[]
}

export type UnnumberedLineBlocker = { lineId: string; requestId: string; employee: string }

export type ExportBlockers = {
  missingRates: MissingRateBlocker[]
  unclassifiedLines: UnclassifiedLineBlocker[]
  unnumberedLines: UnnumberedLineBlocker[]
  /**
   * Accounting cannot be read while lines still wait for their rate (AC-6.6). Then `missingRates` is empty: it is
   * not a missing rate, and the card says so under its own heading.
   */
  accountingUnavailable: boolean
}

export type AccountingExportSummary = {
  batchId: string
  batchStatus: string
  exportable: boolean
  rowCount: number
  /** WellD Italia lines left out (AC-6.6). */
  excludedLineCount: number
  blockers: ExportBlockers
  /** Approved lines in a foreign currency whose rate is copied at this export (AC-5.6). */
  ratePendingLineCount: number
  /** True when the server just tried to fetch the missing rates from the official source. */
  fetchAttempted: boolean
  /** Whether the person may open Accounting's exchange rates for WellD CH: it decides the link (AC-7.3, D17). */
  viewer: { canOpenAccountingRates: boolean }
}

/**
 * Fills what an answer from an older or newer server may leave out, so the card reads one shape: the pending count
 * 0, the viewer flag false (no link), the unavailable blocker false and no reason on a missing rate.
 */
const withDefaults = (raw: AccountingExportSummary): AccountingExportSummary => ({
  ...raw,
  ratePendingLineCount: typeof raw.ratePendingLineCount === 'number' ? raw.ratePendingLineCount : 0,
  viewer: { canOpenAccountingRates: raw.viewer?.canOpenAccountingRates === true },
  blockers: raw.blockers
    ? {
        ...raw.blockers,
        missingRates: (raw.blockers.missingRates ?? []).map((rate) => ({ ...rate, reason: asReason(rate.reason) })),
        accountingUnavailable: raw.blockers.accountingUnavailable === true,
      }
    : raw.blockers,
})

/** `GET /batches/:id/accounting-export`: may call the official source and take several seconds. */
export const getAccountingExport = async (batchId: string): Promise<AccountingExportSummary> =>
  withDefaults(await getJson<AccountingExportSummary>(`/batches/${encodeURIComponent(batchId)}/accounting-export`))

/**
 * `GET /batches/:id/accounting-export/file`: the workbook's bytes, untouched. Every export is logged by the server,
 * and a failed log write is a 500 with no file (AC-6.10), so any non-2xx here means no file was produced.
 */
export const downloadAccountingFile = async (batchId: string): Promise<Blob> => {
  const response = await apiFetch(`${refundApiBase()}/batches/${encodeURIComponent(batchId)}/accounting-export/file`)
  if (!response.ok) return throwFromResponse(response)
  return response.blob()
}

/** `refund-accounting-<cutoff YYYY-MM-DD>-<batchId>.xlsx`; the cutoff is the batch's ISO instant, only its date is used. */
export const accountingExportFileName = (cutoff: string, batchId: string): string =>
  `refund-accounting-${cutoff.slice(0, 10)}-${batchId}.xlsx`

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const asList = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value.filter(isRecord) : [])

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null)

const isMissingValue = (value: unknown): value is MissingValue => value === 'account'

/**
 * The summary a 409 `accounting_export_blocked` carries, or `null` when `error` is anything else or its body
 * is not a summary. Entries that are malformed are dropped; the result is always `exportable: false` (the
 * server just refused to export). `null` tells the caller to fall back to a fresh `getAccountingExport`.
 */
export const blockedSummary = (error: unknown): AccountingExportSummary | null => {
  if (!(error instanceof ApiError) || error.code !== 'accounting_export_blocked') return null
  const { batchId, batchStatus, rowCount, excludedLineCount, blockers, fetchAttempted, ratePendingLineCount, viewer } =
    error.extras
  if (typeof batchId !== 'string' || !isRecord(blockers)) return null

  const missingRates: MissingRateBlocker[] = []
  for (const entry of asList(blockers.missingRates)) {
    const month = str(entry.month)
    if (month !== null && (entry.currency === 'EUR' || entry.currency === 'USD' || entry.currency === 'GBP')) {
      missingRates.push({ currency: entry.currency, month, reason: asReason(entry.reason) })
    }
  }
  const unclassifiedLines: UnclassifiedLineBlocker[] = []
  for (const entry of asList(blockers.unclassifiedLines)) {
    const lineId = str(entry.lineId)
    const requestId = str(entry.requestId)
    if (lineId === null || requestId === null) continue
    unclassifiedLines.push({
      lineId,
      requestId,
      date: str(entry.date) ?? '',
      type: str(entry.type) ?? '',
      employee: str(entry.employee) ?? '',
      receiptNumber: str(entry.receiptNumber),
      missing: Array.isArray(entry.missing) ? entry.missing.filter(isMissingValue) : [],
    })
  }
  const unnumberedLines: UnnumberedLineBlocker[] = []
  for (const entry of asList(blockers.unnumberedLines)) {
    const lineId = str(entry.lineId)
    const requestId = str(entry.requestId)
    if (lineId !== null && requestId !== null)
      unnumberedLines.push({ lineId, requestId, employee: str(entry.employee) ?? '' })
  }

  return {
    batchId,
    batchStatus: typeof batchStatus === 'string' ? batchStatus : '',
    exportable: false,
    rowCount: typeof rowCount === 'number' ? rowCount : 0,
    excludedLineCount: typeof excludedLineCount === 'number' ? excludedLineCount : 0,
    blockers: { missingRates, unclassifiedLines, unnumberedLines, accountingUnavailable: blockers.accountingUnavailable === true },
    ratePendingLineCount: typeof ratePendingLineCount === 'number' ? ratePendingLineCount : 0,
    fetchAttempted: fetchAttempted === true,
    viewer: { canOpenAccountingRates: isRecord(viewer) && viewer.canOpenAccountingRates === true },
  }
}
