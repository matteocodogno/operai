/**
 * Test-only fixture bridge for specs/006-user-invitations e2e (T14).
 *
 * Two things this feature's e2e needs have NO production-facing seam:
 *   1. Granting the `admin` role to a freshly test-auth-seeded @operai.test
 *      user — there is no "make me admin" endpoint (correctly — see
 *      auth/src/authz/seed.ts `BOOTSTRAP_ADMIN_EMAIL`, which is the ONLY
 *      admin-bootstrap mechanism, and it's an env var matched at real sign-up
 *      time, not something an e2e run can safely repoint without touching a
 *      developer's local `.env`).
 *   2. A known RAW invite-link token — `Invitation.tokenHash` is a one-way
 *      SHA-256 digest (auth/src/invitations/token.ts) by design (a DB leak
 *      alone must never disclose a usable link), and the admin API's
 *      `InvitationDetail` response never echoes the raw token either. The
 *      only place the raw token ever exists is the (stubbed, EMAIL_ENABLED=
 *      false) invite email itself, which this local harness never sends.
 *
 * Both gaps are bridged the same way `auth/src/auth/auth.config.test.ts`'s
 * own T8 integration tests bridge them: direct Prisma access against the
 * local dev DB, via `auth/scripts/e2e-invite-fixtures.ts` (a script that
 * refuses to run with NODE_ENV=production). This file just shells out to it
 * with the SAME env `auth`'s own dev/test tooling uses (`direnv exec .`,
 * loading `auth/.envrc`'s 1Password-backed DATABASE_URL) — mirrors the
 * `mise run dev`/`bun test` prerequisite already documented for this whole
 * e2e harness (playwright.config.ts's doc comment), so there is no new
 * credential surface introduced here.
 */
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const AUTH_DIR = path.resolve(__dirname, '../../../auth')

const SCRIPT_ARGS = ['run', 'scripts/e2e-invite-fixtures.ts']

/**
 * Runs the fixture script with whichever env-loading path this machine has.
 *
 * `auth` supports TWO documented local setups (CLAUDE.md "Auth service"):
 * a plain `auth/.env`, or direnv + 1Password via `auth/.envrc`. Bun auto-loads
 * `.env`, so we try plain `bun` FIRST and only fall back to `direnv exec .`.
 *
 * The previous order (direnv-only) made this harness require an unlocked
 * 1Password vault even on machines whose `auth/.env` already had everything
 * the script needs — which is why specs/012's e2e could not be executed at
 * all on 2026-08-04. Preferring `bun` costs nothing when direnv IS the setup
 * (the fallback still runs) and unblocks the machines where it isn't.
 */
function runFixtureScript(args: string[]): string {
  let output: string
  try {
    output = execFileSync('bun', [...SCRIPT_ARGS, ...args], {
      cwd: AUTH_DIR,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch {
    output = execFileSync('direnv', ['exec', '.', 'bun', ...SCRIPT_ARGS, ...args], {
      cwd: AUTH_DIR,
      encoding: 'utf-8',
    })
  }
  // The script's own stdout may be interleaved with Prisma's dev-mode query
  // logging (`auth/src/lib/db.ts` logs `query` in non-production) — the
  // fixture script's OWN result is always the single JSON object it prints
  // last, so pick the last line that parses as JSON rather than assuming
  // stdout is clean.
  const lines = output.split('\n').map((l) => l.trim()).filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (line.startsWith('{')) return line
  }
  throw new Error(`[inviteFixtures] no JSON output from fixture script (args: ${args.join(' ')})\n${output}`)
}

/** Grants `roleName` directly to the (already test-auth-seeded) user at `email`. */
export function grantRole(email: string, roleName: string): void {
  runFixtureScript(['grant-role', email, roleName])
}

/**
 * Creates a `pending` Invitation row directly (bypassing `POST
 * /admin/invitations` — this is ONLY for tests that need the raw token
 * in advance, e.g. driving `GET /invite`; tests that only need an
 * invitation to EXIST, with real roles/departments applied on accept,
 * should go through the real admin API instead, per T14's own design).
 * Returns `{ id, token }` — `token` is the raw, unhashed link token.
 */
export function seedInvitationWithKnownToken(
  email: string,
  roleNames: string[] = [],
): { id: string; token: string } {
  const json = runFixtureScript(['seed-invitation', email, ...roleNames])
  return JSON.parse(json) as { id: string; token: string }
}

/** Best-effort cleanup — deletes every user/invitation whose email contains `tag`. */
export function cleanupFixtures(tag: string): void {
  try {
    runFixtureScript(['cleanup', tag])
  } catch {
    // Best-effort: a cleanup failure must never fail the test suite itself.
  }
}
