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
 *   3. RELEASE: `direnv exec . bun run accounting:release --offsets <file>` in `refund-api/`. It READS Accounting first (the seed
 *      above, through refund-api's own `ACCOUNTING_INTERNAL_URL`, which must name the same accounting-api as step 1), seeds
 *      Refund's fourteen type defaults (accounts only) from `scripts/data/accounting-defaults.welld-ch.json` (its `--defaults`
 *      flag defaults to that file; the old `--seed` is gone), numbers and classifies what exists, and writes the release
 *      marker. Idempotent. `E2E_SKIP_REFUND_ACCOUNTING_RELEASE=1` skips it, for a run of specs that never approve a refund request.
 *
 *      `--offsets` IS REQUIRED since the 2026-11-19 sign-off (20261118 SO-13, AC-7.4): the list of the last receipt numbers
 *      issued by hand in the 2026 register, and without it the release writes nothing and exits 3. The e2e has no hand-issued
 *      numbers: every receipt number a journey sees starts at 001. So the setup passes a file that holds ONLY THE HEADER LINE
 *      (`email,year,lastIssuedSeq`), which the release reads as the explicit statement "no employee has a hand-issued 2026
 *      number". The file is written to a directory of its own under the OS temp directory (mode 0700, never inside the
 *      repository, where the release script would warn that a file naming employees may be committed) and removed when the
 *      step ends, whatever its outcome. It names nobody.
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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ACCOUNTING_API_URL } from './helpers/accountingFixtures'
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

/**
 * The database a setup script must write to instead of its service's `.envrc`'s, or `undefined` for "the `.envrc`'s". A value that is
 * set but not a Postgres URL stops the run: a typo must not silently fall back to the shared database. The value is never echoed.
 */
function databaseOverride(variable: string): string | undefined {
  const value = process.env[variable]?.trim()
  if (!value) return undefined
  if (!/^postgres(?:ql)?:\/\/\S+$/i.test(value)) {
    throw new Error(`[global-setup] ${variable} is set but is not a postgres:// or postgresql:// URL (its value is not shown)`)
  }
  return value
}

/**
 * Runs `bun run <script> [...args]` in `dir` under `direnv exec .`. With an `override`, the script sees it as `DATABASE_URL`: it is
 * exported by a one-line wrapper that runs AFTER direnv has loaded `.envrc` (which would otherwise win), and it travels in the
 * child's environment, so it appears in neither the process list nor an error message.
 */
function runUnderDirenv(dir: string, script: string, override: string | undefined, scriptArgs: readonly string[] = []): string {
  const wrapper = `if [ -n "$${PASSED_DATABASE_VARIABLE}" ]; then export DATABASE_URL="$${PASSED_DATABASE_VARIABLE}"; fi; exec "$@"`
  const env = { ...process.env }
  delete env[PASSED_DATABASE_VARIABLE]
  if (override) env[PASSED_DATABASE_VARIABLE] = override
  return execFileSync('direnv', ['exec', '.', 'sh', '-c', wrapper, 'sh', 'bun', 'run', script, ...scriptArgs], {
    cwd: dir,
    encoding: 'utf-8',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/** The header line of the offsets file the release reads (`email,year,lastIssuedSeq`): on its own it says "no hand-issued number". */
export const BASELINE_HEADER = 'email,year,lastIssuedSeq'

/**
 * Writes the e2e's baseline list, a file with the header line and no row, to a new directory under the OS temp directory, and
 * returns its path and a function that removes the directory. `mkdtemp` creates it with mode 0700 and a name nobody can guess; the
 * file is mode 0600. Only what this function created is removed.
 */
function writeHeaderOnlyBaseline(): { file: string; remove: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), 'operai-e2e-baseline-'))
  const file = path.join(dir, 'receipt-baseline.csv')
  writeFileSync(file, `${BASELINE_HEADER}\n`, { encoding: 'utf-8', mode: 0o600 })
  return { file, remove: () => rmSync(dir, { recursive: true, force: true }) }
}

/** The last line of a script's report (counts, never an employee), or `''`. */
function lastLine(output: string): string {
  return output.split('\n').map((l) => l.trim()).filter(Boolean).at(-1) ?? ''
}

/** What failed, from the child's exit status or spawn error and its stderr tail, with every connection string scrubbed. */
function describeFailure(error: unknown): string {
  if (typeof error !== 'object' || error === null) return scrub(String(error))
  const { status, code, stderr } = error as { status?: number | null; code?: unknown; stderr?: unknown }
  if (typeof code === 'string') return scrub(`${code} while starting \`direnv\`: is it installed and on the PATH?`) // spawn failed: nothing ran
  const tail = String(stderr ?? '').trim().split('\n').slice(-8).join('\n')
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
    throw new Error(`[global-setup] accounting-api does not answer at ${ACCOUNTING_API_URL}/health (${reason}). ${start}.`)
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
    console.log(`[global-setup] accounting seeded${override ? ` (database from ${ACCOUNTING_DATABASE_OVERRIDE})` : ''}${last ? ` (${last})` : ''}`)
  } catch (error) {
    throw new Error(
      `[global-setup] accounting could not be seeded: ${describeFailure(error)}\n` +
        'Run `cd accounting-api && direnv exec . bun run seed:welld-ch --dry-run` against the database accounting-api uses (its migrations applied: ' +
        '`bun run db:deploy`), or set E2E_SKIP_ACCOUNTING_SEED=1 when accounting enters the list by hand.',
    )
  }
}

/** Runs refund-api's release script once; the marker it writes is what lets approvals through. It reads Accounting first. */
function releaseRefundAccounting(): void {
  if (skipRelease()) {
    console.error('[global-setup] E2E_SKIP_REFUND_ACCOUNTING_RELEASE=1: refund accounting is NOT released, approvals will answer 409')
    return
  }
  const override = databaseOverride(REFUND_DATABASE_OVERRIDE)
  const baseline = writeHeaderOnlyBaseline()
  try {
    const output = runUnderDirenv(REFUND_API_DIR, 'accounting:release', override, ['--offsets', baseline.file])
    // the script's report names counts, never an employee: print its last line only
    const last = lastLine(output)
    console.log(`[global-setup] refund accounting released${override ? ` (database from ${REFUND_DATABASE_OVERRIDE})` : ''}${last ? ` (${last})` : ''}`)
  } catch (error) {
    throw new Error(
      `[global-setup] refund accounting could not be released: ${describeFailure(error)}\n` +
        'Run `cd refund-api && direnv exec . bun run accounting:release --dry-run --offsets <file>` (a file holding only the header line ' +
        `"${BASELINE_HEADER}") against the database refund-api uses (its migrations applied: ` +
        '`bun run db:deploy`; ACCOUNTING_INTERNAL_URL naming the accounting-api that is running; exit 2 means Accounting could not be read, ' +
        'exit 3 that the baseline list was not given or not read), ' +
        'or set E2E_SKIP_REFUND_ACCOUNTING_RELEASE=1 for specs that never approve a refund request.',
    )
  } finally {
    baseline.remove()
  }
}

export default async function globalSetup(): Promise<void> {
  if (!skipSeed() || !skipRelease()) await checkAccountingApi()
  seedAccounting()
  releaseRefundAccounting()
  if (process.env['E2E_SKIP_LEGAL_ENTITIES_SETUP'] === '1') {
    console.error('[global-setup] E2E_SKIP_LEGAL_ENTITIES_SETUP=1: the legal-entity registry and its people are NOT prepared')
    return
  }
  const people = await setUpLegalEntityPeople()
  const seeded = await seedRegistry(people.admin)
  const summary = ENTITIES.map((entity) => `${entity} v${seeded[entity].version}`).join(', ')
  // names and versions only: no legal value is ever printed
  console.log(`[global-setup] legal-entity registry in order: ${summary}`)
}
