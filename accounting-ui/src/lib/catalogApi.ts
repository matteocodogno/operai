/**
 * catalogApi — the ledger-account and VAT-code operations of accounting-api (specs/20261119-accounting, plan § API
 * contracts, design UX-5): every path is under `/v1/entities/{entity}/…`, and a row is addressed by its NATURAL key
 * (the account number, the VAT code), never by an id: the wire has none (plan D1, D18, D24). A key that goes into a path is
 * `encodeURIComponent`-ed.
 *
 *   GET  /v1/entities/{entity}/ledger-accounts                       200 { entity, items: [ { number, name, active } ] }
 *   POST /v1/entities/{entity}/ledger-accounts          { number, name }            201 item
 *        409 ledger_account_duplicate { number, reactivate }   422 invalid_ledger_account { fields: [ { field, reason } ] }
 *   POST /v1/entities/{entity}/ledger-accounts/{number}/deactivate | /reactivate   200 item | 409 already_inactive / already_active
 *
 *   GET  /v1/entities/{entity}/vat-codes                             200 { entity, items: [ { code, label, ratePercent: "8.1", rateBasisPoints: 810, active } ] }
 *   POST /v1/entities/{entity}/vat-codes                { code, label, ratePercent }    201 item
 *        409 vat_code_duplicate { vatCode, reactivate }   422 invalid_vat_code { fields: [ { field: code|label|ratePercent, reason } ] }
 *   POST /v1/entities/{entity}/vat-codes/{code}/deactivate | /reactivate                200 item | 409 already_inactive / already_active
 *
 * A list is unwrapped from its `{ entity, items }` envelope and read defensively (a row it cannot vouch for is dropped, an
 * unreadable `active` reads as deactivated), as `readMe` does. A write answers with the row, which the card swaps in; the
 * card reloads for order, and nothing here computes anything. A failure is an `ApiError` whose `code` is the discriminator
 * (`ledger_account_duplicate`, `invalid_ledger_account`, `already_active`, `accounting_manage_required`, …), whose `extras`
 * hold `reactivate`, `number` and `fields`; a caller branches on `code`, never on `detail` (AC-6.10).
 *
 * There is no PUT, PATCH or DELETE on an entry, so there is no function for one: not for a ledger account (AC-1.12), and not
 * for a VAT code's rate either (AC-1.7: a new rate is a new code). The rate is the server's display string, never computed.
 */
import { getJson, sendJson } from './api'
import type { ApiError } from './api'
import type { EntityId } from './meApi'
import type { LimitReason } from './limits'
import { reasonOf } from './limits'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const basePath = (entity: EntityId, resource: string) => `/v1/entities/${encodeURIComponent(entity)}/${resource}`

/** The items of a `{ entity, items }` list, each through `read`; a body without a list reads as empty. */
const readItems = <T>(body: unknown, read: (item: Record<string, unknown>) => T | null): T[] => {
  const raw = isRecord(body) && Array.isArray(body.items) ? body.items : []
  return raw.flatMap((item) => (isRecord(item) ? (read(item) ?? []) : []))
}

// ---------------------------------------------------------------------------
// Ledger accounts
// ---------------------------------------------------------------------------

/** What accounting-api says about an account: no id, no who-added, no history (D18). */
export interface LedgerAccount {
  number: string
  name: string
  active: boolean
}

const readLedgerAccount = (item: Record<string, unknown>): LedgerAccount | null =>
  typeof item.number === 'string' && typeof item.name === 'string'
    ? { number: item.number, name: item.name, active: item.active === true }
    : null

export const listLedgerAccounts = async (entity: EntityId, init?: RequestInit): Promise<LedgerAccount[]> =>
  readItems(await getJson<unknown>(basePath(entity, 'ledger-accounts'), init), readLedgerAccount)

/** The row the server answers a write with; an answer that is not a row is a failure of the call, not an empty row. */
const readLedgerAccountAnswer = (body: unknown): LedgerAccount => {
  const account = isRecord(body) ? readLedgerAccount(body) : null
  if (account === null) throw new TypeError('accounting-api answered a ledger account that cannot be read')
  return account
}

export const createLedgerAccount = async (
  entity: EntityId,
  input: { number: string; name: string },
): Promise<LedgerAccount> =>
  readLedgerAccountAnswer(await sendJson<unknown>(basePath(entity, 'ledger-accounts'), 'POST', input))

const ledgerAction = async (entity: EntityId, number: string, action: 'deactivate' | 'reactivate') =>
  readLedgerAccountAnswer(
    await sendJson<unknown>(`${basePath(entity, 'ledger-accounts')}/${encodeURIComponent(number)}/${action}`, 'POST'),
  )

export const deactivateLedgerAccount = (entity: EntityId, number: string): Promise<LedgerAccount> =>
  ledgerAction(entity, number, 'deactivate')

export const reactivateLedgerAccount = (entity: EntityId, number: string): Promise<LedgerAccount> =>
  ledgerAction(entity, number, 'reactivate')

// ---------------------------------------------------------------------------
// VAT codes
// ---------------------------------------------------------------------------

/** What accounting-api says about a VAT code. The rate is fixed for the life of the code (AC-1.7). */
export interface VatCode {
  code: string
  label: string
  /** The rate as the server displays it: `"8.1"`. Shown through `formatVatRate`; never parsed to compute anything. */
  ratePercent: string
  active: boolean
}

const readVatCode = (item: Record<string, unknown>): VatCode | null =>
  typeof item.code === 'string' && typeof item.label === 'string' && typeof item.ratePercent === 'string'
    ? { code: item.code, label: item.label, ratePercent: item.ratePercent, active: item.active === true }
    : null

export const listVatCodes = async (entity: EntityId, init?: RequestInit): Promise<VatCode[]> =>
  readItems(await getJson<unknown>(basePath(entity, 'vat-codes'), init), readVatCode)

const readVatCodeAnswer = (body: unknown): VatCode => {
  const vatCode = isRecord(body) ? readVatCode(body) : null
  if (vatCode === null) throw new TypeError('accounting-api answered a VAT code that cannot be read')
  return vatCode
}

export const createVatCode = async (
  entity: EntityId,
  input: { code: string; label: string; ratePercent: string },
): Promise<VatCode> => readVatCodeAnswer(await sendJson<unknown>(basePath(entity, 'vat-codes'), 'POST', input))

const vatAction = async (entity: EntityId, code: string, action: 'deactivate' | 'reactivate') =>
  readVatCodeAnswer(
    await sendJson<unknown>(`${basePath(entity, 'vat-codes')}/${encodeURIComponent(code)}/${action}`, 'POST'),
  )

export const deactivateVatCode = (entity: EntityId, code: string): Promise<VatCode> =>
  vatAction(entity, code, 'deactivate')

export const reactivateVatCode = (entity: EntityId, code: string): Promise<VatCode> =>
  vatAction(entity, code, 'reactivate')

// ---------------------------------------------------------------------------
// What a refusal says (shared by both catalogs)
// ---------------------------------------------------------------------------

/** One refused field of a 422: the server's `{ field, reason }` with the reason read as one of ours. */
export interface RefusedField {
  field: string
  reason: LimitReason
}

/** The `fields[]` of a 422 `invalid_*` body, read with a guard because the body is wire data. */
export function refusedFields(error: ApiError): RefusedField[] {
  const raw = error.extras.fields
  if (!Array.isArray(raw)) return []
  return raw.flatMap((entry) =>
    isRecord(entry) && typeof entry.field === 'string' ? [{ field: entry.field, reason: reasonOf(entry.reason) }] : [],
  )
}

/**
 * The `reactivate` flag of a 409 duplicate (G9: "the existing entry is deactivated"), or null when the body does not carry a
 * boolean — the caller then falls back to the list it already holds.
 */
export const duplicateIsDeactivated = (error: ApiError): boolean | null =>
  typeof error.extras.reactivate === 'boolean' ? error.extras.reactivate : null

/**
 * The `limit` of a 409 `catalog_full` (T53: the entity holds as many entries as it may, deactivated ones included), as the
 * server sent it, or `fallback` (the mirrored cap) when the body carries no whole number above 0. The sentence must always
 * name a limit, never "undefined" or "0".
 */
export const catalogFullLimit = (error: ApiError, fallback: number): number => {
  const limit = error.extras.limit
  return typeof limit === 'number' && Number.isSafeInteger(limit) && limit > 0 ? limit : fallback
}
