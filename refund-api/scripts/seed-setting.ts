/**
 * Cutover seed script (T5, specs/011-refund-settings, plan.md D7).
 *
 * A one-time, OPERATOR-RUN maintenance command — never a server startup env
 * read, never a schema migration carrying the value (AC-4.1 stays strictly
 * honored: the RUNNING `refund-api` process never touches
 * `REFUND_ACCOUNTING_DISTRIBUTION_EMAIL`). Appends the initial
 * `accounting-distribution-email` `refund_setting` row IFF the key has no
 * rows yet — idempotent: a second run (accidental re-run, redeploy, CI
 * retry) is a guaranteed no-op, never a duplicate row.
 *
 * Usage:
 *   bun run settings:seed <email>
 *
 * Run this ONCE, immediately post-deploy, passing the value currently
 * deployed as `REFUND_ACCOUNTING_DISTRIBUTION_EMAIL` — see
 * `infra/README.md` § "Cutover — accounting-distribution-email setting" for
 * the full runbook (read the current env value BEFORE removing it from the
 * platform, run this, verify via `GET /settings/accounting-distribution-email`,
 * THEN remove the env var).
 *
 * The seeded row's actor is the documented, non-spoofable
 * `createdByUserId:"system:settings-cutover"` /
 * `createdByEmail:"system-cutover@welld.ch"` (D7) — never attributed to a
 * real admin who didn't actually make the change, and distinguishable from
 * every subsequent admin-driven change (T3's `PUT /settings/:key`, which
 * always takes its actor from the caller's verified JWT).
 */

import { db } from "../src/lib/db";
import { getSettingDescriptor, ACCOUNTING_DISTRIBUTION_EMAIL_KEY } from "../src/settings/registry";

export const CUTOVER_ACTOR_USER_ID = "system:settings-cutover";
export const CUTOVER_ACTOR_EMAIL = "system-cutover@welld.ch";

export type SeedAccountingDistributionEmailResult =
  | { readonly outcome: "seeded"; readonly rowId: string }
  | { readonly outcome: "already-configured"; readonly existingCount: number }
  | { readonly outcome: "invalid"; readonly message: string };

/**
 * The testable core (no `process.argv`/`process.exit`/console I/O) — the CLI
 * `main()` below is a thin wrapper around this. Idempotent: appends the
 * initial row IFF the key has zero existing rows; any existing row (however
 * it got there — this script, or a real admin `PUT`) makes this a no-op.
 */
export async function seedAccountingDistributionEmail(
  value: string,
): Promise<SeedAccountingDistributionEmailResult> {
  const descriptor = getSettingDescriptor(ACCOUNTING_DISTRIBUTION_EMAIL_KEY);
  // Unreachable in practice (the key is always registered) — defense in
  // depth against a future refactor accidentally dropping the registry entry.
  if (!descriptor) {
    return { outcome: "invalid", message: `Unknown setting key "${ACCOUNTING_DISTRIBUTION_EMAIL_KEY}"` };
  }

  const validationError = descriptor.validate(value);
  if (validationError) {
    return { outcome: "invalid", message: validationError };
  }

  const existingCount = await db.refundSetting.count({
    where: { key: ACCOUNTING_DISTRIBUTION_EMAIL_KEY },
  });
  if (existingCount > 0) {
    return { outcome: "already-configured", existingCount };
  }

  const row = await db.refundSetting.create({
    data: {
      key: ACCOUNTING_DISTRIBUTION_EMAIL_KEY,
      value,
      createdByUserId: CUTOVER_ACTOR_USER_ID,
      createdByEmail: CUTOVER_ACTOR_EMAIL,
    },
  });
  return { outcome: "seeded", rowId: row.id };
}

async function main(): Promise<void> {
  const value = process.argv[2];

  if (!value) {
    console.error("Usage: bun run settings:seed <email>");
    process.exitCode = 1;
    return;
  }

  const result = await seedAccountingDistributionEmail(value);

  if (result.outcome === "invalid") {
    console.error(`Invalid value for "${ACCOUNTING_DISTRIBUTION_EMAIL_KEY}": ${result.message}`);
    process.exitCode = 1;
    return;
  }

  if (result.outcome === "already-configured") {
    console.log(
      `"${ACCOUNTING_DISTRIBUTION_EMAIL_KEY}" already has ${result.existingCount} row(s) — ` +
        "nothing to do (idempotent no-op). If you intended to CHANGE the " +
        "value, use PUT /settings/accounting-distribution-email (Admin > " +
        "Refund) instead — this script seeds the INITIAL cutover row only.",
    );
    return;
  }

  console.log(
    `Seeded "${ACCOUNTING_DISTRIBUTION_EMAIL_KEY}" = "${value}" (row id ${result.rowId}, ` +
      `actor ${CUTOVER_ACTOR_EMAIL}). Verify via ` +
      "GET /settings/accounting-distribution-email, then remove " +
      "REFUND_ACCOUNTING_DISTRIBUTION_EMAIL from the platform.",
  );
}

// Only run the CLI entrypoint when this file is executed directly (`bun run
// settings:seed` / `bun run scripts/seed-setting.ts`) — NOT when imported by
// a test (`seed-setting.test.ts` imports `seedAccountingDistributionEmail`
// directly, without triggering a second CLI run or an unwanted `$disconnect`
// of the shared `db` client mid-test-suite).
if (import.meta.main) {
  main()
    .catch((error) => {
      console.error("settings:seed failed:", error instanceof Error ? error.message : error);
      process.exitCode = 1;
    })
    .finally(async () => {
      await db.$disconnect();
    });
}
