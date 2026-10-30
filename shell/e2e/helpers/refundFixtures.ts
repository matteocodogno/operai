/**
 * Test-only fixture bridge for specs/007-refund-service e2e (T21, QE pass).
 *
 * Refund permissions are deliberately admin-assigned, never automatic for
 * the built-in `employee` role (spec.md Constraints — "holding `employee`
 * does not by itself grant refund access"), and accounting review is
 * entity-scoped via the `user.entity` attribute (ADR-0015). There is no
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
