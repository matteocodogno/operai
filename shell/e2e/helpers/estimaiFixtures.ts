/**
 * Test-only fixture bridge for specs/013-estimate-sharing e2e (T25, QE pass).
 *
 * Mirrors `refundFixtures.ts` exactly: EstimAI's `(estimai, access)` grant is
 * NOT on the baseline `employee` role assigned at sign-up (verified against
 * `auth/src/authz/seed.ts` — nothing grants it by default; `estimai` is
 * deliberately excluded from `SUITE_APPS`'s bare-access seeding because it
 * declares its own full catalog), yet T2's `auth POST /authz/app-access-check`
 * (ADR-0035) requires it on BOTH sides of a collaborator-add call: the owner
 * (caller gate) and the target collaborator (the eligibility decision
 * itself). There is no test-only "make me EstimAI-eligible" endpoint (nor
 * should there be, for the same reason `inviteFixtures.ts`'s `grantRole` and
 * `refundFixtures.ts`'s `grantRefundEmployee` have none) — this shells out to
 * `auth/scripts/e2e-invite-fixtures.ts`'s `grant-estimai-access` command
 * (added by this same pass) via `direnv exec .`, writing the real
 * Role/PermissionRule/UserRole rows so `auth`'s live resolver resolves these
 * test users through the exact same code path a real admin-granted user
 * would.
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
  throw new Error(`[estimaiFixtures] no JSON output from fixture script (args: ${args.join(' ')})\n${output}`)
}

/** Grants the (already test-auth-seeded) user at `email` `(estimai, access)`. */
export function grantEstimaiAccess(email: string): void {
  runFixtureScript(['grant-estimai-access', email])
}
