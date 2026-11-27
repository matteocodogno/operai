/**
 * Playwright global setup of the shell e2e suite (specs/20261117-legal-entities, T41).
 *
 * It leaves the legal-entity registry in the state the journeys of that spec (and the CRM offer journeys, which now print the
 * issuer from the registry) start from, and the people they need to exist:
 *
 *   1. the registry SEEDED BY THE IMPORT: where an entity has no version, `mise run legal-entities:import` (T9) copies the CRM's
 *      legal details into version 1 (idempotent; skipped when both entities already have a version);
 *   2. both entities COMPLETE (AC-1.2): where a required value is missing or a value invalid, one registry save by the admin
 *      fixture fills it (nothing already valid is replaced; an entity in order gets no new version);
 *   3. a `welld_ch`-conditioned manager and a no-grant user, next to the admin (helpers/legalEntitiesFixtures.ts).
 *
 * It needs the stack the suite already needs (header of playwright.config.ts): `auth` with ENABLE_TEST_AUTH=true and its
 * migrations and seed applied (`cd auth && bun run db:release`), and, only on a database whose registry is still empty, the
 * compose Postgres with the CRM's database (the import reads it). It fails the whole run, naming what to run, when the registry
 * cannot be brought to that state: a journey that starts from an unseeded registry would fail for the wrong reason.
 *
 * `E2E_SKIP_LEGAL_ENTITIES_SETUP=1` skips it, for a run of specs that touch neither the registry nor an offer. It says so on
 * stderr; a run that skips it proves nothing about the registry.
 *
 * It also PREPARES ACCOUNTING and RELEASES refund accounting (specs/20261118-refund-accounting-export, T12; specs/20261119-accounting,
 * T40). The reference data (ledger accounts, VAT codes, rates) lives in accounting-api, and refund-api refuses every approval
 * (409 `accounting_release_pending`) until `bun run accounting:release` has run once against its database, so the refund journeys
 * that approve a request would all fail without both. In this order:
 *
 *   1. HEALTH PRE-CHECK: `GET <E2E_ACCOUNTING_API_URL>/health` (default http://localhost:8089) must answer 200 from accounting-api.
 *      Otherwise the run stops here, naming the command that starts it, because the two steps below (and every Accounting
 *      journey) would fail for the wrong reason. Skipped only when both steps below are skipped.
 *   2. SEED: `direnv exec . bun run seed:welld-ch` in `accounting-api/` loads WellD CH's signed-off list of accounts and VAT codes.
 *      Idempotent (a second run adds nothing, and never touches an entry that exists). `E2E_SKIP_ACCOUNTING_SEED=1` skips it.
 *   3. RELEASE: the three-step release of specs/20261124-receipt-numbers-from-the-register (plan § e2e and local), in `refund-api/`,
 *      under `direnv exec`. It READS Accounting first (the seed above, through refund-api's own `ACCOUNTING_INTERNAL_URL`, which
 *      must name the same accounting-api as step 1), and seeds Refund's fourteen type defaults from
 *      `scripts/data/accounting-defaults.welld-ch.json`. Idempotent: on a database already released, step (a) prints "already
 *      completed" and the setup stops there, having written nothing. `E2E_SKIP_REFUND_ACCOUNTING_RELEASE=1` skips it, for a run of
 *      specs that never approve a refund request.
 *        (a) PROPOSE   `accounting:release --dry-run --register <committed header-only workbook> --propose <tmp>/pairing.csv`;
 *        (b) CONFIRM   in this file's own code, every `proposed` worker / line / row record becomes `confirmed` (a row is
 *                      `acknowledged`). An `unresolved` record fails the run, naming the command that shows it: the dev database
 *                      holds lines or employees that need a person's decision, and no default is guessed;
 *        (c) CODES     the release refuses (exit 9) to issue a number to an employee who shares a prefix and holds no receipt
 *                      code. A dev database that ran journeys with the release skipped holds many e2e accounts with the same
 *                      initials ("E2E Employee …" = EE), so every `@operai.test` employee the receipt-code list flags as sharing a
 *                      prefix without a code gets an unused one through refund-api's own route (`PUT /accounting/receipt-codes`,
 *                      as a seeded admin). Only test accounts: a real person who shares a prefix still stops the release;
 *        (d) RUN       `accounting:release --register <same workbook> --pairing <tmp>/pairing.csv`.
 *      The workbook is `refund-api/scripts/fixtures/synthetic-register-header-only.xlsx`: committed, the header row only, no data,
 *      so the release reads it as "no employee has a hand-issued 2026 number" and every receipt number a journey sees starts at 001.
 *      The pairing file names employees: it lives in a directory of its own under the OS temp directory (mode 0700, never inside
 *      the repository), the file is mode 0600, and the directory is removed when the step ends, whatever its outcome.
 *
 * WHICH DATABASE THE SCRIPTS WRITE TO. Both run under `direnv exec`, the way `mise run dev` starts those services, so each reaches
 * the database its own `.envrc` names: that is the shared dev Postgres, whatever a `DATABASE_URL` already in your shell says
 * (direnv sets it afresh). To run the setup against ANOTHER database, set, in the shell that runs `pnpm e2e`:
 *
 *   E2E_ACCOUNTING_DATABASE_URL=postgresql://...   the database the `seed:welld-ch` script writes to (accounting-api's)
 *   E2E_REFUND_DATABASE_URL=postgresql://...       the database the `accounting:release` script writes to (refund-api's)
 *
 * When set, the value replaces `DATABASE_URL` for that one script only, after direnv has loaded its environment. It must be
 * the database the RUNNING service uses (start that service with the same URL), or the journeys will not see what the setup
 * wrote. The value is passed through the environment, never on a command line, and is never printed; a value that is not a
 * `postgres://` or `postgresql://` URL fails the run. The other fixtures that shell out (`auth/scripts/e2e-invite-fixtures.ts`
 * and the legal-entity import) keep following their own `.envrc`.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ACCOUNTING_API_URL } from './helpers/accountingFixtures'
import { seedAdminSession } from './helpers/adminSession'
import { freshToken, listReceiptCodeRows, putReceiptCode, unusedReceiptCodes } from './helpers/refundFixtures'
import { seedRegistry, setUpLegalEntityPeople, ENTITIES } from './helpers/legalEntitiesFixtures'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const ACCOUNTING_API_DIR = path.join(REPO_ROOT, 'accounting-api')
const REFUND_API_DIR = path.join(REPO_ROOT, 'refund-api')

/** Environment variable naming the database a setup script writes to, in place of the one the service's `.envrc` names. */
const ACCOUNTING_DATABASE_OVERRIDE = 'E2E_ACCOUNTING_DATABASE_URL'
const REFUND_DATABASE_OVERRIDE = 'E2E_REFUND_DATABASE_URL'

/** Hands the override to the script through the environment (see {@link runUnderDirenv}). */
const PASSED_DATABASE_VARIABLE = 'E2E_SETUP_DATABASE_URL'

/** Never let a connection string, or any URL with credentials in it, reach a log line or an error. */
function scrub(text: string): string {
  return text.replace(/postgres(?:ql)?:\/\/[^\s'"`]+/gi, 'postgresql://***')
}

const ALLOW_REMOTE_DATABASE = 'E2E_ALLOW_REMOTE_DB'
const LOCAL_DATABASE_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])

/**
 * The release step auto-confirms every proposal against the database it is pointed at, so it refuses a host that is not this
 * machine unless `E2E_ALLOW_REMOTE_DB=1`. Only the host is judged; the URL (credentials included) is never in the error.
 */
export function assertLocalDatabase(url: string, variable: string, env: NodeJS.ProcessEnv = process.env): void {
  if (env[ALLOW_REMOTE_DATABASE] === '1') return
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '')
  } catch {
    throw new Error(`[global-setup] ${variable} is not a URL this setup can read the host of (its value is not shown)`)
  }
  if (LOCAL_DATABASE_HOSTS.has(host)) return
  throw new Error(
    `[global-setup] ${variable} names a database that is not on this machine: the release step confirms every proposal on its own and ` +
      `writes the release marker there. Point it at a local database, or set ${ALLOW_REMOTE_DATABASE}=1 if you mean it (its value is not shown)`,
  )
}

/**
 * The database a setup script must write to instead of its service's `.envrc`'s, or `undefined` for "the `.envrc`'s". A value that is
 * set but not a Postgres URL stops the run: a typo must not silently fall back to the shared database. The value is never echoed.
 */
function databaseOverride(variable: string): string | undefined {
  const value = process.env[variable]?.trim()
  if (!value) return undefined
  if (!/^postgres(?:ql)?:\/\/\S+$/i.test(value)) {
    throw new Error(
      `[global-setup] ${variable} is set but is not a postgres:// or postgresql:// URL (its value is not shown)`,
    )
  }
  return value
}

/**
 * Runs `bun run <script> [...args]` in `dir` under `direnv exec .`. With an `override`, the script sees it as `DATABASE_URL`: it is
 * exported by a one-line wrapper that runs AFTER direnv has loaded `.envrc` (which would otherwise win), and it travels in the
 * child's environment, so it appears in neither the process list nor an error message.
 */
function runUnderDirenv(
  dir: string,
  script: string,
  override: string | undefined,
  scriptArgs: readonly string[] = [],
): string {
  const wrapper = `if [ -n "$${PASSED_DATABASE_VARIABLE}" ]; then export DATABASE_URL="$${PASSED_DATABASE_VARIABLE}"; fi; exec "$@"`
  const env = { ...process.env }
  delete env[PASSED_DATABASE_VARIABLE]
  // `mise run dev` defaults it the same way (refund-api's direnv file does not set it): the URL of the accounting-api the setup checked
  if (!env['ACCOUNTING_INTERNAL_URL']?.trim()) env['ACCOUNTING_INTERNAL_URL'] = ACCOUNTING_API_URL
  if (override) env[PASSED_DATABASE_VARIABLE] = override
  return execFileSync('direnv', ['exec', '.', 'sh', '-c', wrapper, 'sh', 'bun', 'run', script, ...scriptArgs], {
    cwd: dir,
    encoding: 'utf-8',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/** The committed workbook the release reads: the header row of the register and no data (refund-api/scripts/fixtures). */
const HEADER_ONLY_REGISTER = path.join(REFUND_API_DIR, 'scripts', 'fixtures', 'synthetic-register-header-only.xlsx')

/** What a successful propose run prints when the marker is already there (`formatReport`, refund-api/scripts/accounting-release.ts). */
const ALREADY_COMPLETED = /already completed/i

/**
 * A private directory for the pairing file: `mkdtemp` creates it under the OS temp directory with mode 0700 and a name nobody can
 * guess. Only what this function created is removed.
 */
function makePrivateDir(): { dir: string; remove: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), 'operai-e2e-release-'))
  return { dir, remove: () => rmSync(dir, { recursive: true, force: true }) }
}

/** Splits CSV text into rows of cells (RFC 4180 quoting; a leading BOM is dropped). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  const input = text.replace(/^\uFEFF/, '')
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!
    if (quoted) {
      if (c === '"' && input[i + 1] === '"') {
        cell += '"'
        i++
      } else if (c === '"') quoted = false
      else cell += c
    } else if (c === '"') quoted = true
    else if (c === ',') {
      row.push(cell)
      cell = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && input[i + 1] === '\n') i++
      row.push(cell)
      cell = ''
      if (row.some((x) => x !== '')) rows.push(row)
      row = []
    } else cell += c
  }
  row.push(cell)
  if (row.some((x) => x !== '')) rows.push(row)
  return rows
}

const csvCell = (cell: string): string => (/[",\r\n]|^\s|\s$/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell)

/** Thrown when the proposed pairing file holds records only a person can decide. */
class PairingNeedsDecision extends Error {}

/**
 * The text of the proposed pairing file with every `proposed` worker, line and row record set to `confirmed` (a row is also
 * `acknowledged`): what the operator does with a file that has nothing to decide. Throws {@link PairingNeedsDecision}, naming the
 * record kinds and ids (never a person), when a record is `unresolved`.
 */
export function confirmProposedPairing(csv: string): string {
  const rows = parseCsv(csv)
  const header = (rows[0] ?? []).map((c) => c.trim())
  const [kind, id, state, decision] = ['record', 'id', 'state', 'decision'].map((name) => header.indexOf(name)) as [
    number,
    number,
    number,
    number,
  ]
  if (kind < 0 || id < 0 || state < 0 || decision < 0)
    throw new Error('the proposed pairing file has no header with record, id, state and decision')
  const open: string[] = []
  const rewritten = rows.map((row, index) => {
    if (index === 0) return row
    const cells = [...row]
    const type = cells[kind]
    if (type !== 'worker' && type !== 'line' && type !== 'row') return cells
    const current = cells[state]?.trim().toLowerCase()
    if (current === 'unresolved') {
      open.push(`${type} ${cells[id]}`)
      return cells
    }
    if (current === 'proposed') cells[state] = 'confirmed'
    if (type === 'row') cells[decision] = 'acknowledged'
    return cells
  })
  if (open.length > 0) throw new PairingNeedsDecision(`records to decide: ${open.join(', ')}`)
  return `\uFEFF${rewritten.map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`
}

/** The last line of a script's report (counts, never an employee), or `''`. */
function lastLine(output: string): string {
  return (
    output
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .at(-1) ?? ''
  )
}

/** What failed, from the child's exit status or spawn error and its stderr tail, with every connection string scrubbed. */
function describeFailure(error: unknown): string {
  if (typeof error !== 'object' || error === null) return scrub(String(error))
  const { status, code, stderr } = error as { status?: number | null; code?: unknown; stderr?: unknown }
  if (typeof code === 'string') return scrub(`${code} while starting \`direnv\`: is it installed and on the PATH?`) // spawn failed: nothing ran
  const tail = String(stderr ?? '')
    .trim()
    .split('\n')
    .slice(-8)
    .join('\n')
  return scrub(`exit ${status ?? 'unknown'}${tail ? `\n${tail}` : ''}`)
}

const skipSeed = (): boolean => process.env['E2E_SKIP_ACCOUNTING_SEED'] === '1'
const skipRelease = (): boolean => process.env['E2E_SKIP_REFUND_ACCOUNTING_RELEASE'] === '1'

/** accounting-api answers `/health` with 200 and says it is accounting-api; otherwise the run stops, naming the command. */
async function checkAccountingApi(): Promise<void> {
  const start =
    'Start it with `mise run dev` (or `cd accounting-api && direnv exec . bun run dev`; ACCOUNTING_FX_SOURCE=off for the e2e), ' +
    'or set E2E_ACCOUNTING_API_URL to where it runs'
  let status: number
  let service: unknown
  try {
    const res = await fetch(`${ACCOUNTING_API_URL}/health`, { signal: AbortSignal.timeout(5_000) })
    status = res.status
    service = ((await res.json().catch(() => null)) as { service?: unknown } | null)?.service
  } catch (error) {
    const reason = error instanceof Error ? error.name : 'error'
    throw new Error(
      `[global-setup] accounting-api does not answer at ${ACCOUNTING_API_URL}/health (${reason}). ${start}.`,
    )
  }
  if (status !== 200 || service !== 'accounting-api') {
    throw new Error(
      `[global-setup] ${ACCOUNTING_API_URL}/health answered ${status}${service === 'accounting-api' ? ' (accounting-api, but not healthy: is its database up and migrated? `mise run db:migrate`)' : ' and is not accounting-api'}. ${start}.`,
    )
  }
}

/** Loads WellD CH's reference data into Accounting (idempotent), so the release below has something to read and the journeys a known base. */
function seedAccounting(): void {
  if (skipSeed()) {
    console.error('[global-setup] E2E_SKIP_ACCOUNTING_SEED=1: Accounting is NOT seeded with the WellD CH list')
    return
  }
  const override = databaseOverride(ACCOUNTING_DATABASE_OVERRIDE)
  try {
    const output = runUnderDirenv(ACCOUNTING_API_DIR, 'seed:welld-ch', override)
    // the report names counts and account numbers, never a person
    const last = lastLine(output)
    console.log(
      `[global-setup] accounting seeded${override ? ` (database from ${ACCOUNTING_DATABASE_OVERRIDE})` : ''}${last ? ` (${last})` : ''}`,
    )
  } catch (error) {
    throw new Error(
      `[global-setup] accounting could not be seeded: ${describeFailure(error)}\n` +
        'Run `cd accounting-api && direnv exec . bun run seed:welld-ch --dry-run` against the database accounting-api uses (its migrations applied: ' +
        '`bun run db:deploy`), or set E2E_SKIP_ACCOUNTING_SEED=1 when accounting enters the list by hand.',
    )
  }
}

/** E2E accounts only: every fixture seeds its people under this domain. */
const TEST_ACCOUNT = /@operai\.test$/i

/**
 * Step (c) of the header: gives every `@operai.test` employee who shares a prefix and has no receipt code an unused code, so the
 * release does not stop on test accounts (exit 9). Returns how many were set. A real person is never touched.
 */
async function settleTestAccountPrefixes(): Promise<number> {
  const admin = await seedAdminSession('e2e-setup-receipt-codes@operai.test', 'E2E Setup Receipt Codes')
  const token = await freshToken(admin.cookieHeader)
  const pending = (await listReceiptCodeRows(token)).filter(
    (row) => row.sharesPrefix && row.code === null && TEST_ACCOUNT.test(row.email),
  )
  if (pending.length === 0) return 0
  const codes = await unusedReceiptCodes(token, pending.length)
  for (const [index, row] of pending.entries()) {
    const res = await putReceiptCode(token, row.userId, codes[index]!)
    if (res.status !== 200)
      throw new Error(
        `a test account's receipt code could not be set (PUT /accounting/receipt-codes answered ${res.status})`,
      )
  }
  return pending.length
}

/**
 * Runs refund-api's release once, in its steps (see the header): propose, confirm `proposed` records, codes for test accounts that
 * share a prefix, real run. The marker it writes is what lets approvals through. It reads Accounting first.
 */
async function releaseRefundAccounting(): Promise<void> {
  if (skipRelease()) {
    console.error(
      '[global-setup] E2E_SKIP_REFUND_ACCOUNTING_RELEASE=1: refund accounting is NOT released, approvals will answer 409',
    )
    return
  }
  const override = databaseOverride(REFUND_DATABASE_OVERRIDE)
  if (override) assertLocalDatabase(override, REFUND_DATABASE_OVERRIDE)
  const where = override ? ` (database from ${REFUND_DATABASE_OVERRIDE})` : ''
  const inspect =
    'Run `cd refund-api && direnv exec . bun run accounting:release --dry-run --register scripts/fixtures/synthetic-register-header-only.xlsx ' +
    '--propose <new file outside the repository>` against the database refund-api uses and read its report'
  const failures =
    'exit 2 means Accounting could not be read (ACCOUNTING_INTERNAL_URL must name the accounting-api that is running), exit 4 that auth ' +
    'could not be read for the names, exit 5 that an input was not given, exit 6 that an input could not be read, exit 7 that the lines ' +
    'changed since the pairing file was written, exit 8 that the pairing is not fully decided, exit 9 that a new number would go to an ' +
    'employee who shares a prefix and has no receipt code'
  const tmp = makePrivateDir()
  const pairing = path.join(tmp.dir, 'pairing.csv')
  let step = 'propose'
  try {
    const proposed = runUnderDirenv(REFUND_API_DIR, 'accounting:release', override, [
      '--dry-run',
      '--register',
      HEADER_ONLY_REGISTER,
      '--propose',
      pairing,
    ])
    if (ALREADY_COMPLETED.test(proposed)) {
      console.log(`[global-setup] refund accounting was already released: nothing to do${where}`)
      return
    }
    step = 'confirm'
    if (!existsSync(pairing)) throw new Error('the propose step wrote no pairing file')
    writeFileSync(pairing, confirmProposedPairing(readFileSync(pairing, 'utf-8')), { encoding: 'utf-8', mode: 0o600 })
    step = 'codes'
    const settled = await settleTestAccountPrefixes()
    if (settled > 0) console.log(`[global-setup] receipt codes set for ${settled} e2e account(s) that shared a prefix`)
    step = 'run'
    const output = runUnderDirenv(REFUND_API_DIR, 'accounting:release', override, [
      '--register',
      HEADER_ONLY_REGISTER,
      '--pairing',
      pairing,
    ])
    // the script's report names counts, never an employee: print its last line only
    const last = lastLine(output)
    console.log(`[global-setup] refund accounting released${where}${last ? ` (${last})` : ''}`)
  } catch (error) {
    if (error instanceof PairingNeedsDecision) {
      throw new Error(
        `[global-setup] refund accounting could not be released: the development database holds lines or employees that need a person's decision (${error.message}). ` +
          `${inspect}, decide there, or set E2E_SKIP_REFUND_ACCOUNTING_RELEASE=1 for specs that never approve a refund request.`,
      )
    }
    const reason = error instanceof Error && !('status' in error) ? scrub(error.message) : describeFailure(error)
    throw new Error(
      `[global-setup] refund accounting could not be released (step: ${step}): ${reason}\n` +
        `${inspect} (its migrations applied: \`bun run db:deploy\`; ${failures}), ` +
        'or set E2E_SKIP_REFUND_ACCOUNTING_RELEASE=1 for specs that never approve a refund request.',
    )
  } finally {
    tmp.remove()
  }
}

export default async function globalSetup(): Promise<void> {
  if (!skipSeed() || !skipRelease()) await checkAccountingApi()
  seedAccounting()
  await releaseRefundAccounting()
  if (process.env['E2E_SKIP_LEGAL_ENTITIES_SETUP'] === '1') {
    console.error(
      '[global-setup] E2E_SKIP_LEGAL_ENTITIES_SETUP=1: the legal-entity registry and its people are NOT prepared',
    )
    return
  }
  const people = await setUpLegalEntityPeople()
  const seeded = await seedRegistry(people.admin)
  const summary = ENTITIES.map((entity) => `${entity} v${seeded[entity].version}`).join(', ')
  // names and versions only: no legal value is ever printed
  console.log(`[global-setup] legal-entity registry in order: ${summary}`)
}
