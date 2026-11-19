/**
 * accountingApi — typed operations against refund-api's accounting surface
 * (specs/20261118-refund-accounting-export, plan.md § API contracts): the WellD CH ledger-account and VAT-code
 * catalogs, the per-expense-type defaults and the foreign-currency VAT code, the classification options, and a
 * request's classification view and line classification.
 *
 * specs/20261119-accounting (T35): Accounting owns the reference data now, and refund-api reads it. The defaults,
 * the designation, the options and a line's classification are keyed by NUMBER and CODE (natural keys, D1), never
 * an id; each entry a copy points to carries Accounting's `state` (`active`, `deactivated`, `not_found`, or
 * `unverified` when Accounting cannot be read); and a read answers `accounting: "unavailable"` instead of failing
 * when Accounting is down. A write answers 503 `accounting_unavailable` (nothing saved) or 422 `*_inactive` /
 * `*_not_found`. The catalog half below (ledger accounts and VAT codes by id) stays until T38 removes it: it is
 * what the cards waiting to move to accounting-ui still read.
 *
 * Built on `getJson`/`sendJson` exactly as `reviewApi.ts` is, and written against the documented contract
 * with the backend still being built: every test mocks `apiFetch`. Lists are unwrapped from their
 * `{ items }` envelope. Ids and keys that go into a path are `encodeURIComponent`-ed.
 *
 * Errors are `ApiError`s whose `code` is the contract's stable discriminator (`ledger_account_duplicate`,
 * `already_active`, `ledger_account_inactive`, `classification_locked`, `classification_missing`, …).
 * A caller branches on `code`, never on `status` alone and never on `detail` (human text). The
 * `classification_missing` 409 carries the lines it refuses on; `classificationMissingLines` reads
 * them with a guard, because the body is wire data.
 *
 * Amounts are integer cents and rates are display strings, both exactly as the server sends them:
 * nothing here (or in any caller) computes a CHF or VAT figure.
 */

import type { Entity } from '../components/EntityBadge'
import type { RequestStatus } from '../components/RequestStatusBadge'
import type { ExpenseType } from './expenseTypes'
import type { Currency } from './money'
import { ApiError, getJson, sendJson } from './refundApi'

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** One entry of a catalog item's status history: oldest first, the first one is the creation (AC-1.8). */
export type CatalogStatusEntry = { active: boolean; at: string; byEmail: string }

export type LedgerAccount = {
  id: string
  number: string
  name: string
  active: boolean
  createdAt: string
  createdByEmail: string
  history: CatalogStatusEntry[]
}

export type VatCode = {
  id: string
  code: string
  label: string
  rateBasisPoints: number
  /** The rate as the server displays it: `"8.1"`. */
  ratePercent: string
  active: boolean
  createdAt: string
  createdByEmail: string
  history: CatalogStatusEntry[]
}

/**
 * What Accounting says about the entry a stored copy points to (UX-18): `active`, `deactivated` (reversible),
 * `not_found` (the number or code is not there any more, SA-3) or `unverified` (Accounting cannot be read, so the
 * copy is shown as recorded and nothing is claimed about it). Only `active` is a usable default.
 */
export type EntryState = 'active' | 'deactivated' | 'not_found' | 'unverified'

/** A ledger account by its number, as a copy recorded in Refund, with Accounting's current `state`. */
export type AccountRef = { number: string; name: string; state: EntryState }
/** A VAT code by its code, as a copy recorded in Refund, with Accounting's current `state`. */
export type VatCodeRef = { code: string; label: string; ratePercent: string; state: EntryState }

/** A copy as the history recorded it: no state, so the history reads the same whatever happens in Accounting (AC-4.7). */
export type AccountCopy = { number: string; name: string }
export type VatCodeCopy = { code: string; label: string; ratePercent: string }

export type ForeignCurrencyVatHistoryEntry = {
  vatCode: VatCodeCopy | null
  at: string
  byEmail: string
}

export type ForeignCurrencyVatCodeState = {
  /** The designation, even when it is deactivated or no longer in Accounting. */
  foreignCurrencyVatCode: VatCodeRef | null
  /** False when there is no designation or it is not `active` (AC-2.7). */
  foreignCurrencyVatCodeUsable: boolean
  /** Oldest first. */
  foreignCurrencyVatCodeHistory: ForeignCurrencyVatHistoryEntry[]
}

export type ExpenseTypeDefaultHistoryEntry = {
  account: AccountCopy | null
  vatCode: VatCodeCopy | null
  at: string
  byEmail: string
}

export type ExpenseTypeDefault = {
  type: ExpenseType
  account: AccountRef | null
  vatCode: VatCodeRef | null
  updatedAt: string | null
  updatedByEmail: string | null
  /** Oldest first. */
  history: ExpenseTypeDefaultHistoryEntry[]
}

/** Whether Refund could read Accounting while answering (AC-6.9). */
export type AccountingAvailability = 'available' | 'unavailable'

/** `GET /accounting/expense-type-defaults`: always the twelve types, in enum order (AC-2.2). */
export type ExpenseTypeDefaults = ForeignCurrencyVatCodeState & {
  entity: 'welld_ch'
  /** `unavailable`: every `state` is `unverified` and the defaults are shown as recorded. */
  accounting: AccountingAvailability
  types: ExpenseTypeDefault[]
}

/** `GET /accounting/options`: the ACTIVE WellD CH entries only, keyed by number and code (AC-4.1, AC-4.4). */
export type AccountingOptions = {
  ledgerAccounts: { number: string; name: string }[]
  vatCodes: { code: string; label: string; ratePercent: string; rateBasisPoints: number }[]
}

export type ClassificationState = 'review' | 'post_approval' | 'locked' | 'none'

/** A VAT code of a line: the label can be unknown when the copy recorded none. */
export type LineVatCodeRef = Omit<VatCodeRef, 'label'> & { label: string | null }

/**
 * The account and VAT code a line carries. A type default (or designation) whose entry is deactivated or not found is
 * returned WITH its state and `…IsDefault: true`, never as `null`: `null` means no default is set (G8a). Approval
 * still refuses it server-side (AC-6.3).
 */
export type LineClassification = {
  account: AccountRef | null
  accountIsDefault: boolean
  vatCode: LineVatCodeRef | null
  vatCodeIsDefault: boolean
}

/**
 * Where a line's exchange rate stands: `copied` (frozen at approval or export), `in_effect` (a rate exists and a
 * line not yet approved follows it), `missing` (none yet, before approval), `pending` (approved, no copy yet: it
 * is copied at the first export, AC-5.6), `unavailable` (Accounting cannot be read) or `not_applicable` (a CHF line).
 */
export type RateStatus = 'copied' | 'in_effect' | 'missing' | 'pending' | 'unavailable' | 'not_applicable'

export type LineChf = {
  amountCents: number | null
  rateMicros: number | null
  /** `"0.9246"` */
  rate: string | null
  /** `"2026-03"` */
  rateMonth: string | null
  rateStatus: RateStatus
}

/** One line of `GET /review/requests/:id/accounting`, and the body of a successful classification PUT. */
export type AccountingLine = {
  lineId: string
  entity: Entity
  date: string
  type: ExpenseType
  currency: Currency
  /** `approvedTotalCents ?? requestedAmountCents`: provisional before approval. */
  amountCents: number
  receiptNumber: string | null
  employee: { name: string | null; email: string }
  rejected: boolean
  /**
   * `false` when the caller's entity scope does not cover this line (plan.md SR-1): `classification`, `chf` and
   * `vatAmountCents` are then all `null`, and the page shows no figure and no control for it.
   */
  inScope: boolean
  /** `null` for a WellD Italia line, for a rejected line and for a line out of scope. */
  classification: LineClassification | null
  /** `null` for a line out of scope. */
  chf: LineChf | null
  /** `null` when the CHF amount is unknown or there is no VAT code (never a computed zero), and out of scope. */
  vatAmountCents: number | null
}

export type RequestAccounting = {
  requestId: string
  status: RequestStatus
  batch: { id: string; status: string } | null
  /** `unavailable`: Accounting could not be read, so every value is shown as recorded and cannot be changed (AC-6.5). */
  accounting: AccountingAvailability
  /** Whether the person may open Accounting's exchange rates for WellD CH: it decides the link (AC-7.3, D17). */
  viewer: { canOpenAccountingRates: boolean }
  classificationState: ClassificationState
  /**
   * `true` when the caller owns this request and their grant bars them from approving it (plan.md SR-2): the
   * classification is read-only for them, whatever capability they hold.
   */
  selfRestricted: boolean
  lines: AccountingLine[]
}

/** At least one key; natural keys (D1). There is no "back to default". */
export type ClassifyBody = { accountNumber?: string; vatCode?: string }

export type MissingValue = 'account' | 'vatCode'

/** One line the approve refusal (409 `classification_missing`) names. */
export type ClassificationMissingLine = { lineId: string; date: string; type: string; missing: MissingValue[] }

// ---------------------------------------------------------------------------
// Ledger accounts
// ---------------------------------------------------------------------------

const unwrapItems = <T>(envelope: { items: T[] }): T[] => envelope.items

/** `GET /accounting/ledger-accounts` (`settings:read`). */
export const listLedgerAccounts = (): Promise<LedgerAccount[]> =>
  getJson<{ items: LedgerAccount[] }>('/accounting/ledger-accounts').then(unwrapItems)

/** `POST /accounting/ledger-accounts` (`settings:manage`). 409 `ledger_account_duplicate` (active or deactivated), 422 `invalid_ledger_account`. */
export const createLedgerAccount = (body: { number: string; name: string }): Promise<LedgerAccount> =>
  sendJson<LedgerAccount>('/accounting/ledger-accounts', 'POST', body)

/** 409 `already_inactive` on a stale list. */
export const deactivateLedgerAccount = (id: string): Promise<LedgerAccount> =>
  sendJson<LedgerAccount>(`/accounting/ledger-accounts/${encodeURIComponent(id)}/deactivate`, 'POST', undefined)

/** 409 `already_active` on a stale list. */
export const reactivateLedgerAccount = (id: string): Promise<LedgerAccount> =>
  sendJson<LedgerAccount>(`/accounting/ledger-accounts/${encodeURIComponent(id)}/reactivate`, 'POST', undefined)

// ---------------------------------------------------------------------------
// VAT codes (no update operation exists, AC-1.5)
// ---------------------------------------------------------------------------

/** `GET /accounting/vat-codes` (`settings:read`). */
export const listVatCodes = (): Promise<VatCode[]> =>
  getJson<{ items: VatCode[] }>('/accounting/vat-codes').then(unwrapItems)

/** `POST /accounting/vat-codes`. `ratePercent` is a string such as `"8.1"` (`^\d{1,3}(\.\d{1,2})?$`, 0 to 100). 409 `vat_code_duplicate`, 422 `invalid_vat_code`. */
export const createVatCode = (body: { code: string; label: string; ratePercent: string }): Promise<VatCode> =>
  sendJson<VatCode>('/accounting/vat-codes', 'POST', body)

export const deactivateVatCode = (id: string): Promise<VatCode> =>
  sendJson<VatCode>(`/accounting/vat-codes/${encodeURIComponent(id)}/deactivate`, 'POST', undefined)

export const reactivateVatCode = (id: string): Promise<VatCode> =>
  sendJson<VatCode>(`/accounting/vat-codes/${encodeURIComponent(id)}/reactivate`, 'POST', undefined)

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/**
 * `GET /accounting/expense-type-defaults` (`settings:read`). With Accounting down it still answers 200, with
 * `accounting: "unavailable"` (an absent flag reads as `available`).
 */
export const getExpenseTypeDefaults = (): Promise<ExpenseTypeDefaults> =>
  getJson<ExpenseTypeDefaults>('/accounting/expense-type-defaults').then((raw) => ({
    ...raw,
    accounting: raw.accounting === 'unavailable' ? 'unavailable' : 'available',
  }))

/**
 * `PUT /accounting/expense-type-defaults/:type` (`settings:manage`). `null` clears that half of the default.
 * 422 `ledger_account_inactive` / `ledger_account_not_found` / `vat_code_inactive` / `vat_code_not_found` (AC-4.3),
 * 503 `accounting_unavailable` (nothing saved). Setting the value already in effect answers 200 and writes no
 * history row.
 */
export const putExpenseTypeDefault = (
  type: ExpenseType,
  body: { accountNumber: string | null; vatCode: string | null },
): Promise<ExpenseTypeDefault> =>
  sendJson<ExpenseTypeDefault>(`/accounting/expense-type-defaults/${encodeURIComponent(type)}`, 'PUT', body)

/**
 * `PUT /accounting/foreign-currency-vat-code` (`settings:manage`). `null` clears the designation. 422
 * `vat_code_inactive` / `vat_code_not_found` (AC-2.6), 503 `accounting_unavailable`.
 */
export const putForeignCurrencyVatCode = (vatCode: string | null): Promise<ForeignCurrencyVatCodeState> =>
  sendJson<ForeignCurrencyVatCodeState>('/accounting/foreign-currency-vat-code', 'PUT', { vatCode })

/**
 * Accounting could not be read (503 `accounting_unavailable`): nothing was changed, and the message names the cause
 * and the remedy (AC-6.10). A different 503 (the authorization service) is not this.
 */
export const isAccountingUnavailable = (error: unknown): boolean =>
  error instanceof ApiError && error.status === 503 && error.code === 'accounting_unavailable'

/** The entry the stored copy points to can be chosen again by nobody until someone acts: not `active` and not unchecked. */
export const entryIsUnusable = (state: EntryState): boolean => state === 'deactivated' || state === 'not_found'

// ---------------------------------------------------------------------------
// Classification of a request's lines (request:review)
// ---------------------------------------------------------------------------

/**
 * `GET /accounting/options` (`request:review` covering WellD CH, or `settings:manage`): the active accounts and VAT
 * codes of WellD CH, read live from Accounting. 403 `accounting_out_of_scope` otherwise (plan.md SR-1); 503
 * `accounting_unavailable` when Accounting cannot be read (AC-6.9, AC-6.10: no options at all).
 */
export const getAccountingOptions = (): Promise<AccountingOptions> => getJson<AccountingOptions>('/accounting/options')

/**
 * One line as the wire sends it, made safe to render. A line outside the caller's scope (`inScope: false`) is
 * stripped of any accounting data even if a server sent some, so no figure can reach the screen; a body that
 * predates the flag (`inScope` absent) is an in-scope line, as before. The server enforces the scope: this only
 * keeps the UI from showing what it must not.
 */
const readLine = (raw: AccountingLine): AccountingLine =>
  raw.inScope === false
    ? { ...raw, inScope: false, classification: null, chf: null, vatAmountCents: null }
    : { ...raw, inScope: true }

/**
 * `GET /review/requests/:id/accounting`: 404 outside the reviewer's scope. A line outside it is
 * `inScope: false` without figures; `selfRestricted` (absent reads as `false`) makes the classification read-only.
 */
export const getRequestAccounting = (requestId: string): Promise<RequestAccounting> =>
  getJson<RequestAccounting>(`/review/requests/${encodeURIComponent(requestId)}/accounting`).then((raw) => ({
    ...raw,
    accounting: raw.accounting === 'unavailable' ? 'unavailable' : 'available',
    viewer: { canOpenAccountingRates: raw.viewer?.canOpenAccountingRates === true },
    selfRestricted: raw.selfRestricted === true,
    lines: Array.isArray(raw.lines) ? raw.lines.map(readLine) : raw.lines,
  }))

/**
 * `PUT /review/requests/:id/lines/:lineId/classification`: at least one key, a number or a code (there is no "back to default").
 * Answers with the whole line, amounts included: merge it, never recompute. 403 `self_approval_forbidden` (the
 * caller owns the request and may not shape its booking, plan.md SR-2), 404 for a line outside the caller's entity
 * scope; 409 `classification_locked` (paid), `not_classifiable_status`, `line_rejected`; 422 `line_not_welld_ch`,
 * `ledger_account_inactive`, `ledger_account_not_found`, `vat_code_inactive`, `vat_code_not_found`; 503
 * `accounting_unavailable` (the line is unchanged, AC-6.5).
 */
export const classifyLine = (requestId: string, lineId: string, body: ClassifyBody): Promise<AccountingLine> =>
  sendJson<AccountingLine>(
    `/review/requests/${encodeURIComponent(requestId)}/lines/${encodeURIComponent(lineId)}/classification`,
    'PUT',
    body,
  ).then(readLine)

// ---------------------------------------------------------------------------
// Reading the approve refusal
// ---------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isMissingValue = (value: unknown): value is MissingValue => value === 'account' || value === 'vatCode'

/**
 * The lines a 409 `classification_missing` names, or `null` when `error` is anything else. The body is wire
 * data: an entry that is not `{ lineId, date, type, missing }` is dropped and unknown `missing` values are
 * ignored, so a malformed refusal yields fewer (possibly zero) lines, never a crash.
 */
export const classificationMissingLines = (error: unknown): ClassificationMissingLine[] | null => {
  if (!(error instanceof ApiError) || error.code !== 'classification_missing') return null
  const lines = error.extras.lines
  if (!Array.isArray(lines)) return []
  const result: ClassificationMissingLine[] = []
  for (const entry of lines as unknown[]) {
    if (!isRecord(entry)) continue
    const { lineId, date, type, missing } = entry
    if (typeof lineId !== 'string' || typeof date !== 'string' || typeof type !== 'string') continue
    result.push({ lineId, date, type, missing: Array.isArray(missing) ? missing.filter(isMissingValue) : [] })
  }
  return result
}
