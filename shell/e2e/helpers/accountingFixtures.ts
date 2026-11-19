/**
 * Test-only fixtures for the Accounting e2e journeys (specs/20261119-accounting, T40; plan § Local development and e2e).
 *
 * Accounting owns the reference data (ledger accounts, VAT codes, monthly average rates), so a journey that needs a known
 * account, VAT code or rate writes it HERE, through accounting-api's own user routes as a real admin (the way the
 * Accounting screens write them: nothing is inserted behind the API). The `admin` role holds `accounting:read` and
 * `accounting:manage` unconditioned (auth's seed), so an admin token reaches both entities.
 *
 * Every helper takes the token first; mint it AFTER the grants were written (`freshToken` in refundFixtures.ts), because a
 * grant bumps the user's `perm_epoch` and a token minted earlier is refused.
 *
 * Keys are the natural ones (an account NUMBER, a VAT CODE): there is no id in the Accounting API, and Refund's defaults
 * are set by the same keys (refundFixtures.ts).
 *
 * Nothing here runs without the e2e stack (accounting-api, auth with ENABLE_TEST_AUTH): see playwright.config.ts. The stack is
 * expected to run accounting-api with `ACCOUNTING_FX_SOURCE=off`, so no rate comes from the federal source and a month is
 * "missing" until `setRate` types it.
 */

import { authCall, type Call } from '../fixtures/letterheads'
import { seedAdminSession, seedUserSession, type SeededSession } from './adminSession'

export type { SeededSession }

/** The accounting-api origin the e2e talks to (the same value the global setup health-checks). */
export const ACCOUNTING_API_URL = (
  process.env['E2E_ACCOUNTING_API_URL'] ??
  process.env['VITE_ACCOUNTING_API_URL'] ??
  'http://localhost:8089'
).replace(/\/$/, '')

/** The entities Accounting keeps data for. WellD CH is the only one Refund reads. */
export type AccountingEntity = 'welld_ch' | 'welld_it'

/** The currencies WellD CH converts (WellD Italia has no rate source). */
export type RateCurrency = 'EUR' | 'USD' | 'GBP'

export interface LedgerAccount {
  number: string
  name: string
  active: boolean
}

export interface VatCode {
  code: string
  label: string
  ratePercent: string
  rateBasisPoints: number
  active: boolean
}

/** One cell of the rates table: `missing`, or a `fetched` / `corrected` rate with its display form. */
export type RateCell = { status: 'missing' } | { status: 'fetched' | 'corrected'; rateMicros: number; rate: string }

export interface MonthRow {
  month: string
  rates: Record<string, RateCell>
}

async function accountingApi<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${ACCOUNTING_API_URL}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) {
    // the problem body names a code and a sentence, never a secret
    throw new Error(`[accountingFixtures] ${method} ${path} -> ${res.status}: ${(await res.text()).slice(0, 300)}`)
  }
  return (await res.json()) as T
}

/**
 * A ledger-account number no earlier run used: 5 digits and 3 decimals, random (digits separated by a single dot, 1 to 20
 * characters). A number stays taken after its entry is deactivated, so it is never reused. The seed's numbers are shorter
 * than this shape and cannot collide with it.
 */
export function uniqueAccountNumber(): string {
  const whole = 10_000 + Math.floor(Math.random() * 89_999)
  const decimals = 100 + Math.floor(Math.random() * 899)
  return `${whole}.${decimals}`
}

/** A VAT code no earlier run used (`^[A-Z0-9_-]{1,16}$`; a code stays taken after it is deactivated, so it is random). */
export function uniqueVatCode(): string {
  return `E2E${Math.random().toString(36).slice(2, 10).toUpperCase().padEnd(8, '0')}`
}

export function createLedgerAccount(
  token: string,
  input: { number: string; name: string },
  entity: AccountingEntity = 'welld_ch',
): Promise<LedgerAccount> {
  return accountingApi<LedgerAccount>(token, 'POST', `/v1/entities/${entity}/ledger-accounts`, input)
}

export function createVatCode(
  token: string,
  input: { code: string; label: string; ratePercent: string },
  entity: AccountingEntity = 'welld_ch',
): Promise<VatCode> {
  return accountingApi<VatCode>(token, 'POST', `/v1/entities/${entity}/vat-codes`, input)
}

/** Deactivates a ledger account (a manager's action; the entry stays listed, inactive, and can be reactivated). */
export function deactivateLedgerAccount(token: string, number: string, entity: AccountingEntity = 'welld_ch'): Promise<LedgerAccount> {
  return accountingApi<LedgerAccount>(token, 'POST', `/v1/entities/${entity}/ledger-accounts/${encodeURIComponent(number)}/deactivate`)
}

export function reactivateLedgerAccount(token: string, number: string, entity: AccountingEntity = 'welld_ch'): Promise<LedgerAccount> {
  return accountingApi<LedgerAccount>(token, 'POST', `/v1/entities/${entity}/ledger-accounts/${encodeURIComponent(number)}/reactivate`)
}

/**
 * A monthly average rate typed by hand: `rate` is the own currency (CHF) for 1 unit of `currency`, e.g. "0.9246". Only a
 * completed month is accepted. Typing the value already in effect writes nothing and answers the month row all the same.
 */
export function setRate(
  token: string,
  month: string,
  currency: RateCurrency,
  rate: string,
  entity: AccountingEntity = 'welld_ch',
): Promise<MonthRow> {
  return accountingApi<MonthRow>(token, 'PUT', `/v1/entities/${entity}/exchange-rates/${month}/${currency}`, { rate })
}

interface RatesListResponse {
  months: MonthRow[]
}

/**
 * A COMPLETED month in which `currency` has no rate in effect at WellD CH, newest first, so a line dated in it is
 * "rate pending" (AC-5.6) until a journey types the rate with `setRate`. Once typed the month is used up, and the next run
 * gets the next one: a database supplies about one such month per run, so a long-lived one needs its rates
 * left alone, or the e2e database recreated.
 *
 * The month comes from what Accounting says now (its own clock decides what is completed), not from the machine's date.
 * `exclude` is for months another journey in the same run relies on (e.g. the month whose rate a journey corrects).
 *
 * The listed window is every completed month from 2026-01; when all of those have a rate, the months of 2025 that Accounting
 * does not list (so they hold no entry and no attempt) are the candidates, newest first. Throws when none is left.
 */
export async function unusedPastMonth(
  token: string,
  options: { currency?: RateCurrency; entity?: AccountingEntity; exclude?: readonly string[] } = {},
): Promise<string> {
  const { currency = 'EUR', entity = 'welld_ch', exclude = [] } = options
  const { months } = await accountingApi<RatesListResponse>(token, 'GET', `/v1/entities/${entity}/exchange-rates`)
  const listed = new Set(months.map((row) => row.month))
  const unused = months.find((row) => !exclude.includes(row.month) && row.rates[currency]?.status === 'missing')
  if (unused) return unused.month
  for (let month = 12; month >= 1; month--) {
    const key = `2025-${String(month).padStart(2, '0')}`
    if (!listed.has(key) && !exclude.includes(key)) return key
  }
  throw new Error(`[accountingFixtures] no ${currency} month without a rate is left at ${entity}: recreate the e2e accounting database`)
}

/**
 * A call to accounting-api as `token` that never throws on a status: a journey that proves a REFUSAL (403, 404, 422) asserts
 * the status and the problem `code` itself.
 */
export async function accountingCall<T = Record<string, unknown>>(
  token: string | null,
  method: string,
  path: string,
  body?: unknown,
): Promise<Call<T>> {
  const res = await fetch(`${ACCOUNTING_API_URL}${path}`, {
    method,
    headers: {
      ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let parsed: unknown = {}
  try {
    parsed = text ? JSON.parse(text) : {}
  } catch {
    parsed = { raw: text }
  }
  return { status: res.status, body: parsed as T }
}

// ─── People and what they may do (specs/20261119-accounting, T41) ─────────────────────────────────────────────────────

export type AccountingPersona = 'admin' | 'manager' | 'reader' | 'chManager' | 'nobody'

/** `{ key: 'entity', match: 'user' }`: the grant covers the entity equal to the person's own (auth `grantKind`). */
const OWN_ENTITY = { attributes: [{ key: 'entity', match: 'user' }] }

interface PersonaSpec {
  email: string
  name: string
  /** The role created for it, with its rules; absent: the baseline roles only (or `admin`). */
  role?: { name: string; rules: Array<{ resource: string; action: string; conditions?: object }> }
  /** Its entity attribute, which the scope of an entity-conditioned grant reads. */
  entity?: 'welld_ch' | 'welld_it'
}

/**
 * Made the way an administrator makes them, through `auth`'s admin API like any capability (AC-3.1): the `accounting` resource
 * of the Accounting catalog, with `read` and `manage`, unconditioned or limited to the person's own entity. None holds
 * `admin:access` or any Refund permission.
 */
export const ACCOUNTING_PERSONAS: Record<AccountingPersona, PersonaSpec> = {
  admin: { email: 'acc-e2e-admin@operai.test', name: 'Accounting E2E Admin' },
  manager: {
    email: 'acc-e2e-manager@operai.test',
    name: 'Accounting E2E Manager',
    role: { name: 'e2e-accounting-manager', rules: [{ resource: 'accounting', action: 'manage' }] },
  },
  reader: {
    email: 'acc-e2e-reader@operai.test',
    name: 'Accounting E2E Reader',
    role: { name: 'e2e-accounting-reader', rules: [{ resource: 'accounting', action: 'read' }] },
  },
  chManager: {
    email: 'acc-e2e-ch-manager@operai.test',
    name: 'Accounting E2E CH Manager',
    role: {
      name: 'e2e-accounting-ch-manager',
      rules: [{ resource: 'accounting', action: 'manage', conditions: OWN_ENTITY }],
    },
    entity: 'welld_ch',
  },
  nobody: { email: 'acc-e2e-nobody@operai.test', name: 'Accounting E2E Nobody' },
}

export type AccountingPeople = Record<AccountingPersona, SeededSession>

interface RoleRow {
  id: string
  name: string
}
interface UserDetail {
  id: string
  entity: string | null
  roles: Array<{ id: string; name: string }>
}

async function mustOk<T>(what: string, result: Call<T>, ok: number[] = [200, 201, 204]): Promise<T> {
  if (!ok.includes(result.status)) {
    throw new Error(`[accountingFixtures] ${what} answered ${result.status}: ${JSON.stringify(result.body).slice(0, 400)}`)
  }
  return result.body
}

/** Creates the role when it does not exist, then full-replaces its rules (idempotent). Returns its id. */
async function ensureRole(admin: SeededSession, spec: NonNullable<PersonaSpec['role']>): Promise<string> {
  const roles = await mustOk('GET /admin/roles', await authCall<RoleRow[]>(admin, 'GET', '/admin/roles'))
  let role = roles.find((row) => row.name === spec.name)
  if (!role) {
    role = await mustOk(
      'POST /admin/roles',
      await authCall<RoleRow>(admin, 'POST', '/admin/roles', {
        name: spec.name,
        description: 'Created by the Accounting e2e (specs/20261119-accounting T41)',
      }),
    )
  }
  await mustOk('PUT /admin/roles/{id}/rules', await authCall(admin, 'PUT', `/admin/roles/${role.id}/rules`, { rules: spec.rules }))
  return role.id
}

/** Gives `user` the role (keeping the ones it has: the PUT replaces the set) and, when named, its entity. */
async function assign(admin: SeededSession, user: SeededSession, roleId: string, entity?: PersonaSpec['entity']): Promise<void> {
  const detail = await mustOk('GET /admin/users/{id}', await authCall<UserDetail>(admin, 'GET', `/admin/users/${user.userId}`))
  const roleIds = new Set(detail.roles.map((row) => row.id))
  if (!roleIds.has(roleId)) {
    roleIds.add(roleId)
    await mustOk('PUT /admin/users/{id}/roles', await authCall(admin, 'PUT', `/admin/users/${user.userId}/roles`, { roleIds: [...roleIds] }))
  }
  if (entity !== undefined && detail.entity !== entity) {
    await mustOk('PATCH /admin/users/{id}', await authCall(admin, 'PATCH', `/admin/users/${user.userId}`, { entity }))
  }
}

/**
 * The five people of the Accounting journeys, grants in place (idempotent by e-mail). The sessions are minted AFTER the grants,
 * so the JWT each one carries holds the grant's `perm_epoch` (a token minted earlier is refused).
 */
export async function setUpAccountingPeople(): Promise<AccountingPeople> {
  const adminSpec = ACCOUNTING_PERSONAS.admin
  await seedAdminSession(adminSpec.email, adminSpec.name)
  const admin = await seedUserSession(adminSpec.email, adminSpec.name)

  const sessions: Partial<AccountingPeople> = { admin }
  for (const persona of ['manager', 'reader', 'chManager', 'nobody'] as const) {
    const spec = ACCOUNTING_PERSONAS[persona]
    const first = await seedUserSession(spec.email, spec.name)
    if (spec.role) {
      const roleId = await ensureRole(admin, spec.role)
      await assign(admin, first, roleId, spec.entity)
    }
    sessions[persona] = spec.role ? await seedUserSession(spec.email, spec.name) : first
  }
  return sessions as AccountingPeople
}
