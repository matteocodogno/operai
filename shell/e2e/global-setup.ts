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
 * It also RELEASES refund accounting (specs/20261118-refund-accounting-export, T12): refund-api refuses every approval
 * (409 `accounting_release_pending`) until `bun run accounting:release` has run once against its database, so the refund
 * journeys that approve a request would all fail without it. The script is idempotent (a second run changes nothing), seeds
 * the accounting catalog and the type defaults WellD CH starts from, and writes the release marker. It runs through
 * `direnv exec .` in `refund-api/`, the way `mise run dev` starts that service, so it reaches the same database the running
 * refund-api uses. `E2E_SKIP_REFUND_ACCOUNTING_RELEASE=1` skips it, for a run of specs that never approve a refund request.
 */
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { seedRegistry, setUpLegalEntityPeople, ENTITIES } from './helpers/legalEntitiesFixtures'

const REFUND_API_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../refund-api')

/** Runs refund-api's release script once; the marker it writes is what lets approvals through. */
function releaseRefundAccounting(): void {
  if (process.env['E2E_SKIP_REFUND_ACCOUNTING_RELEASE'] === '1') {
    console.error('[global-setup] E2E_SKIP_REFUND_ACCOUNTING_RELEASE=1: refund accounting is NOT released, approvals will answer 409')
    return
  }
  try {
    const output = execFileSync('direnv', ['exec', '.', 'bun', 'run', 'accounting:release'], {
      cwd: REFUND_API_DIR,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    // the script's report names counts, never an employee: print its last line only
    const last = output.split('\n').map((l) => l.trim()).filter(Boolean).at(-1) ?? ''
    console.log(`[global-setup] refund accounting released${last ? ` (${last})` : ''}`)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(
      `[global-setup] refund accounting could not be released: ${detail}\n` +
        'Run `cd refund-api && direnv exec . bun run accounting:release` against the database refund-api uses (its migrations applied: ' +
        '`bun run db:deploy`), or set E2E_SKIP_REFUND_ACCOUNTING_RELEASE=1 for specs that never approve a refund request.',
    )
  }
}

export default async function globalSetup(): Promise<void> {
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
