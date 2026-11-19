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

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const AUTH_DIR = path.resolve(__dirname, '../../../auth')

function runFixtureScript(args: string[]): string {
  const output = execFileSync(
    'direnv',
    ['exec', '.', 'bun', 'run', 'scripts/e2e-invite-fixtures.ts', ...args],
    { cwd: AUTH_DIR, encoding: 'utf-8' },
  )
  const lines = output.split('\n').map((l) => l.trim()).filter(Boolean)
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

const REFUND_API_URL =
  process.env['E2E_REFUND_API_URL'] ?? process.env['VITE_REFUND_API_URL'] ?? 'http://localhost:8082'

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

// ─── Accounting export fixtures (specs/20261118-refund-accounting-export, T31/T32) ─────────────────────────────────────
//
// The accounting journeys need a known catalog (an account, VAT codes, defaults, the foreign-currency VAT code) and a
// known exchange rate, whatever accounting's seed (`refund-api/scripts/data/accounting-seed.welld-ch.json`, T39) ends up
// holding. They are written through refund-api's own admin routes as a real admin, the way the Settings screen writes
// them (nothing is inserted behind the API), and every default the journey changes is put back by `restore()`.
//
// Nothing here runs without the e2e stack (refund-api, auth with ENABLE_TEST_AUTH): see playwright.config.ts.

const AUTH_API_URL = (
  process.env['E2E_AUTH_URL'] ?? process.env['VITE_AUTH_URL'] ?? 'http://localhost:3001'
).replace(/\/$/, '')

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

export interface CatalogAccount {
  id: string
  number: string
  name: string
}

export interface CatalogVatCode {
  id: string
  code: string
  label: string
  ratePercent: string
}

/** A ledger-account number no earlier run used: 5 digits and 3 decimals (`^[0-9]{3,6}(\.[0-9]{1,3})?$`), random. */
export function uniqueAccountNumber(): string {
  const whole = 10_000 + Math.floor(Math.random() * 89_999)
  const decimals = 100 + Math.floor(Math.random() * 899)
  return `${whole}.${decimals}`
}

/** A VAT code no earlier run used (`^[A-Z0-9_-]{1,16}$`; a code stays taken after it is deactivated, so it is random). */
export function uniqueVatCode(): string {
  return `E2E${Math.random().toString(36).slice(2, 10).toUpperCase().padEnd(8, '0')}`
}

export function createLedgerAccount(token: string, input: { number: string; name: string }): Promise<CatalogAccount> {
  return refundApi<CatalogAccount>(token, 'POST', '/accounting/ledger-accounts', input)
}

export function createVatCode(
  token: string,
  input: { code: string; label: string; ratePercent: string },
): Promise<CatalogVatCode> {
  return refundApi<CatalogVatCode>(token, 'POST', '/accounting/vat-codes', input)
}

/** `null` and `null` clears the default of the type (an approval of a WellD CH line of that type is then refused, AC-3.4). */
export async function setExpenseTypeDefault(
  token: string,
  type: string,
  ledgerAccountId: string | null,
  vatCodeId: string | null,
): Promise<void> {
  await refundApi(token, 'PUT', `/accounting/expense-type-defaults/${type}`, { ledgerAccountId, vatCodeId })
}

export async function setForeignCurrencyVatCode(token: string, vatCodeId: string | null): Promise<void> {
  await refundApi(token, 'PUT', '/accounting/foreign-currency-vat-code', { vatCodeId })
}

/** A monthly average rate typed by hand (`rate` as CHF per 1 unit, e.g. "0.9246"); the same value as in effect is a no-op. */
export async function setExchangeRate(
  token: string,
  month: string,
  currency: 'EUR' | 'USD' | 'GBP',
  rate: string,
): Promise<void> {
  await refundApi(token, 'PUT', `/exchange-rates/${month}/${currency}`, { rate })
}

interface DefaultsSnapshotResponse {
  foreignCurrencyVatCode: { id: string } | null
  types: { type: string; account: { id: string } | null; vatCode: { id: string } | null }[]
}

/**
 * Remembers the default classification of `types` and the foreign-currency VAT code as they are now, and returns a function
 * that puts them back. A journey changes defaults on a database that other journeys, and a person, share; the history rows
 * it appended stay (they are append-only), but what is in effect afterwards is what was before.
 *
 * `restore` never throws: an entry that was deactivated meanwhile answers 422 and is left as it is, with a line on stderr
 * that names the type and nothing else.
 */
export async function snapshotAccountingDefaults(token: string, types: readonly string[]): Promise<() => Promise<void>> {
  const before = await refundApi<DefaultsSnapshotResponse>(token, 'GET', '/accounting/expense-type-defaults')
  return async () => {
    for (const type of types) {
      const row = before.types.find((candidate) => candidate.type === type)
      try {
        await setExpenseTypeDefault(token, type, row?.account?.id ?? null, row?.vatCode?.id ?? null)
      } catch (error) {
        console.error(`[refundFixtures] default of ${type} not restored: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    try {
      await setForeignCurrencyVatCode(token, before.foreignCurrencyVatCode?.id ?? null)
    } catch (error) {
      console.error(`[refundFixtures] foreign-currency VAT code not restored: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

/** The header of the accounting CSV (AC-6.2): the 16 columns, in this order. */
export const ACCOUNTING_CSV_HEADER = [
  'Employee',
  'Receipt number',
  'Expense date',
  'Expense type',
  'Reason',
  'Km',
  'Currency',
  'Approved total',
  'Exchange rate',
  'CHF amount',
  'Account number',
  'Account name',
  'VAT code',
  'VAT rate (%)',
  'VAT amount (CHF)',
  'Batch',
] as const

/**
 * Reads the accounting CSV as the spreadsheet would: `;` separated, `"` quoting with `""` for a quote, CRLF line ends, a
 * leading byte-order mark ignored. `header` is what the file says, so a test can compare it with the contract and a
 * renamed or moved column fails there, not as a missing key. A row is keyed by the header the FILE carries.
 */
export function parseAccountingCsv(text: string): { header: string[]; rows: Record<string, string>[] } {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const records: string[][] = []
  let record: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!
    if (quoted) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          field += '"'
          i++
        } else {
          quoted = false
        }
      } else {
        field += ch
      }
    } else if (ch === '"') {
      quoted = true
    } else if (ch === ';') {
      record.push(field)
      field = ''
    } else if (ch === '\r' && source[i + 1] === '\n') {
      record.push(field)
      records.push(record)
      record = []
      field = ''
      i++
    } else {
      field += ch
    }
  }
  if (field !== '' || record.length > 0) {
    record.push(field)
    records.push(record)
  }
  const [header = [], ...body] = records
  return {
    header,
    rows: body.map((cells) => Object.fromEntries(header.map((name, index) => [name, cells[index] ?? '']))),
  }
}
