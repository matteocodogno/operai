/**
 * Test-only fixture bridge for specs/20260716-refund-service e2e (T21, QE pass).
 *
 * Refund permissions are deliberately admin-assigned, never automatic for
 * the built-in `employee` role (spec.md Constraints — "holding `employee`
 * does not by itself grant refund access"), and accounting review is
 * entity-scoped via the `user.entity` attribute (ADR 20260716-entity-scoped-abac-refund-api). There is no
 * test-only "make me a refund employee/accounting user" endpoint (nor
 * should there be, for the same reason `shell/e2e/helpers/inviteFixtures.ts`
 * gives for its own `grantRole`). This file mirrors that exact pattern —
 * shelling out to `auth/scripts/e2e-invite-fixtures.ts` (which this pass
 * extended with two new commands, `grant-refund-employee` and
 * `grant-refund-accounting`) via `direnv exec .`, so the real Role/
 * PermissionRule/UserRole tables are written and refund-api's live
 * `GET /authz/resolve` call resolves these test users through the exact
 * same code path a real admin-granted user would.
 */
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Call } from '../fixtures/letterheads'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const AUTH_DIR = path.resolve(__dirname, '../../../auth')

function runFixtureScript(args: string[]): string {
  const output = execFileSync('direnv', ['exec', '.', 'bun', 'run', 'scripts/e2e-invite-fixtures.ts', ...args], {
    cwd: AUTH_DIR,
    encoding: 'utf-8',
  })
  const lines = output
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (line.startsWith('{')) return line
  }
  throw new Error(`[refundFixtures] no JSON output from fixture script (args: ${args.join(' ')})\n${output}`)
}

/**
 * Grants the (already test-auth-seeded) user at `email` the refund employee permission set.
 * better-auth stores emails lower-cased and the fixture script looks the row up verbatim,
 * so a mixed-case address (e.g. `...-empA-...`) must be lower-cased here or it is "not found".
 */
export function grantRefundEmployee(email: string): void {
  runFixtureScript(['grant-refund-employee', email.toLowerCase()])
}

/**
 * Grants the (already test-auth-seeded) user at `email` the real `accounting`
 * role, entity-scoped to `entity` (`welld_it` | `welld_ch` | `global`).
 */
export function grantRefundAccounting(email: string, entity: 'welld_it' | 'welld_ch' | 'global'): void {
  runFixtureScript(['grant-refund-accounting', email.toLowerCase(), entity])
}

/** The refund-api origin the e2e talks to. */
export const REFUND_API_URL = (
  process.env['E2E_REFUND_API_URL'] ??
  process.env['VITE_REFUND_API_URL'] ??
  'http://localhost:8082'
).replace(/\/$/, '')

/**
 * Pays out every approved-but-unbatched request already in the database, so a
 * journey that asserts the exact contents of a compile preview starts from an
 * empty candidate set.
 *
 * Why this exists: a compile claims EVERY eligible request, not just the ones a
 * test created, and other journeys (refund-headline approves a request and
 * leaves it unbatched by design, 007 AC-5.2) leave candidates behind on the
 * shared local database. Without the drain the batch journeys only pass on a
 * fresh database and fail on any re-run.
 *
 * `token` must belong to a global accounting user (review + approve).
 */
export async function drainApprovedBacklog(token: string): Promise<number> {
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  const candidates = await fetch(`${REFUND_API_URL}/batches/candidates`, { headers })
  if (!candidates.ok) throw new Error(`[refundFixtures] GET /batches/candidates -> ${candidates.status}`)
  const { requestCount } = (await candidates.json()) as { requestCount: number }
  if (requestCount === 0) return 0

  const compiled = await fetch(`${REFUND_API_URL}/batches`, { method: 'POST', headers, body: '{}' })
  if (compiled.status !== 201) throw new Error(`[refundFixtures] POST /batches -> ${compiled.status}`)
  const { id } = (await compiled.json()) as { id: string }
  const paid = await fetch(`${REFUND_API_URL}/batches/${id}/mark-paid`, { method: 'POST', headers })
  if (!paid.ok) throw new Error(`[refundFixtures] POST /batches/${id}/mark-paid -> ${paid.status}`)
  return requestCount
}

// ─── Accounting export fixtures (specs/20261118-refund-accounting-export, T31/T32; specs/20261119-accounting, T40, T73) ─────
//
// The accounting journeys need a known set of defaults, whatever accounting's seed
// (`accounting-api/scripts/data/seed.welld-ch.json`, loaded by `seed:welld-ch`) and Refund's defaults file
// (`refund-api/scripts/data/accounting-defaults.welld-ch.json`, read by `accounting:release --defaults`) end up holding. The
// ledger accounts, VAT codes and rates the journeys use are Accounting's: a journey creates them with
// helpers/accountingFixtures.ts (`createLedgerAccount`, `createVatCode`, `setRate`) and then names an ACCOUNT to refund-api by
// its natural key, the account NUMBER.
//
// Since the 2026-11-19 sign-off (20261118 SO-2, SO-16) a default is an ACCOUNT and nothing else: there is no VAT default and no
// foreign-currency VAT code to designate (the route is gone and answers 404), and a line gets a VAT code only when accounting
// chooses one. Refund keeps the fourteen defaults, written through its own admin route as a real admin, the way the Settings
// screen writes them (nothing is inserted behind the API), and every default the journey changes is put back by `restore()`.
//
// Nothing here runs without the e2e stack (refund-api, accounting-api, auth with ENABLE_TEST_AUTH): see playwright.config.ts.

const AUTH_API_URL = (process.env['E2E_AUTH_URL'] ?? process.env['VITE_AUTH_URL'] ?? 'http://localhost:3001').replace(
  /\/$/,
  '',
)

/**
 * A bearer token minted AFTER the grants were written. `seedUserSession` returns the token it fetched before
 * `grantRefundAccounting` / `grantRole` bumped the user's `perm_epoch`, so a token used for admin-only writes is fetched again here.
 */
export async function freshToken(cookieHeader: string): Promise<string> {
  const res = await fetch(`${AUTH_API_URL}/auth/token`, { headers: { Cookie: cookieHeader } })
  if (!res.ok) throw new Error(`[refundFixtures] GET /auth/token -> ${res.status}`)
  const { token } = (await res.json()) as { token?: string }
  if (!token) throw new Error('[refundFixtures] /auth/token returned no token')
  return token
}

async function refundApi<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${REFUND_API_URL}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) {
    // the problem body names a code and a sentence, never a secret
    throw new Error(`[refundFixtures] ${method} ${path} -> ${res.status}: ${(await res.text()).slice(0, 300)}`)
  }
  return (await res.json()) as T
}

/**
 * A call to refund-api as `token` (or with none) that never throws on a status: a journey that proves a REFUSAL (404 for a removed
 * route, 422 for a refused body) asserts the status and the problem `code` itself. A body that is not JSON comes back as `{ raw }`.
 */
export async function refundCall<T = Record<string, unknown>>(
  token: string | null,
  method: string,
  path: string,
  body?: unknown,
): Promise<Call<T>> {
  const res = await fetch(`${REFUND_API_URL}${path}`, {
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

/**
 * Sets the default ACCOUNT of an expense type by Accounting's natural key, the account NUMBER. `null` clears the default of the type
 * (an approval of a WellD CH line of that type is then refused until accounting chooses an account on the line, AC-3.4). The
 * account must be active in Accounting, else refund-api answers 422. The body carries `accountNumber` and nothing else: a body
 * with `vatCode` is a 422 (a default has no VAT half any more).
 */
export async function setExpenseTypeDefault(token: string, type: string, accountNumber: string | null): Promise<void> {
  await refundApi(token, 'PUT', `/accounting/expense-type-defaults/${type}`, { accountNumber })
}

/** One row of `GET /accounting/expense-type-defaults`: always the fourteen types, in enum order, each with its account or none. */
export interface TypeDefaultRow {
  type: string
  account: { number: string; name: string; state: string } | null
  updatedAt: string | null
  updatedByEmail: string | null
  /** Oldest first: each entry is an account as it was copied (or none), who set it and when. */
  history: { account: { number: string; name: string } | null; at: string; byEmail: string }[]
}

export interface DefaultsResponse {
  entity: string
  accounting: 'available' | 'unavailable'
  types: TypeDefaultRow[]
}

export function getExpenseTypeDefaults(token: string): Promise<DefaultsResponse> {
  return refundApi<DefaultsResponse>(token, 'GET', '/accounting/expense-type-defaults')
}

/**
 * Remembers the default account of `types` as it is now, and returns a function that puts them back. A journey changes defaults on a
 * database that other journeys, and a person, share; the history rows it appended stay (they are append-only), but what is in
 * effect afterwards is what was before.
 *
 * `restore` never throws: an account that was deactivated meanwhile answers 422 and is left as it is, with a line on stderr
 * that names the type and nothing else.
 */
export async function snapshotAccountingDefaults(
  token: string,
  types: readonly string[],
): Promise<() => Promise<void>> {
  const before = await getExpenseTypeDefaults(token)
  return async () => {
    for (const type of types) {
      const row = before.types.find((candidate) => candidate.type === type)
      try {
        await setExpenseTypeDefault(token, type, row?.account?.number ?? null)
      } catch (error) {
        console.error(
          `[refundFixtures] default of ${type} not restored: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
  }
}

// ─── Receipt codes (specs/20261124-receipt-numbers-from-the-register, T23) ────────────────────────────────────────────────
//
// `GET/PUT /accounting/receipt-codes` need `receipt-code:manage` (the `accounting` and `admin` roles, AC-4.9). The employees the
// list shows are those who have a refund request, so a test employee is made known to Refund with an (empty) draft: the draft
// stays on the shared development database, as the drafts of the other refund journeys do. A code a journey sets is cleared in
// `afterEach` through the API (its history rows stay: they are append-only).

/** One row of `GET /accounting/receipt-codes` (the fields these journeys read). */
export interface ReceiptCodeRow {
  userId: string
  email: string
  initials: string
  code: string | null
  prefix: string
  lastNumber: string | null
  /** True when another employee has the same prefix (flagged in Settings; a codeless one stops the release, exit 9). */
  sharesPrefix: boolean
}

/** Makes `token`'s owner known to Refund: the receipt-code list shows an employee after their first request. Returns the draft's id. */
export async function makeKnownToRefund(token: string): Promise<string> {
  return (await refundApi<{ id: string }>(token, 'POST', '/requests')).id
}

export async function listReceiptCodeRows(token: string): Promise<ReceiptCodeRow[]> {
  return (await refundApi<{ employees: ReceiptCodeRow[] }>(token, 'GET', '/accounting/receipt-codes')).employees
}

/** Sets (`code`) or clears (`null`) an employee's receipt code through the API; never throws on a status, the caller asserts it. */
export function putReceiptCode(token: string, userId: string, code: string | null): Promise<Call> {
  return refundCall(token, 'PUT', `/accounting/receipt-codes/${encodeURIComponent(userId)}`, { code })
}

/**
 * `count` valid receipt codes (three capitals) that no employee of the database holds, derives as initials or has a number
 * issued with: drawn from letters (Q X Z J K W V Y) that no seeded employee derives, then checked against every prefix in the list
 * as it is NOW. Call it after the test employees exist, so their own initials are in the list too. Random, so two runs on the same
 * database rarely draw the same code; a code left behind by a crashed run is excluded by the check, not by luck.
 */
export async function unusedReceiptCodes(token: string, count: number): Promise<string[]> {
  const taken = new Set<string>()
  for (const row of await listReceiptCodeRows(token)) {
    for (const value of [row.code, row.prefix, row.initials, row.lastNumber?.match(/^[A-Z]+/)?.[0]])
      if (value) taken.add(value)
  }
  const letters = 'QXZJKWVY'
  const pool: string[] = []
  for (const a of letters) for (const b of letters) for (const c of letters) pool.push(`${a}${b}${c}`)
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[pool[i], pool[j]] = [pool[j]!, pool[i]!]
  }
  const free = pool.filter((candidate) => !taken.has(candidate)).slice(0, count)
  if (free.length < count)
    throw new Error(`[refundFixtures] only ${free.length} of ${count} unused receipt codes are left`)
  return free
}
