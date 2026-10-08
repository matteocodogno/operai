/**
 * Shared test-only cleanup helper (T2, specs/015-hardware-inventory).
 *
 * TRUNCATE, not DELETE: TRUNCATE does not fire the row-level `BEFORE DELETE`
 * trigger on the four append-only tables (depreciation_rule, fiscal_year,
 * asset_year_figure, asset_event — ADR-0018/0024/0046), so cleanup is never
 * blocked by the very guarantee under test elsewhere in the suite. Mirrors
 * `refund-api/src/test-support/dbCleanup.ts`.
 *
 * Every table is listed explicitly rather than left to CASCADE: asset_event,
 * asset_year_figure and assignment carry no foreign key to asset, so
 * truncating "asset" alone would leave them behind.
 *
 * `depreciation_rule` is the one table that is NOT simply emptied: the two
 * launch rules (AC-6.6) are migration data, and every schedule resolves its
 * rule from that table (ADR-0046), so a test database with no rules would turn
 * every later route test into "no rule in force". The cleanup therefore
 * truncates it and puts the two launch rows straight back, with the same ids
 * and values as the initial migration. `immutability.test.ts` asserts those
 * values, so a drift between this copy and the migration fails there.
 */

import { db } from "../lib/db";

/** The launch rules of AC-6.6, exactly as the initial migration seeds them. */
export const LAUNCH_RULES = [
  {
    id: "rule_launch_welld_ch",
    entity: "welld_ch",
    usefulLifeYears: 3,
    firstYearShare: "full",
    lowValueThresholdCents: null,
    residualCents: 100,
  },
  {
    id: "rule_launch_welld_it",
    entity: "welld_it",
    usefulLifeYears: 5,
    firstYearShare: "half",
    lowValueThresholdCents: 51646,
    residualCents: 0,
  },
] as const;

export const LAUNCH_RULE_ACTOR = "system:launch-seed";
export const LAUNCH_RULE_EFFECTIVE_FROM = "2000-01-01";

export async function truncateInventoryTables(): Promise<void> {
  await db.$executeRawUnsafe(
    'TRUNCATE TABLE "asset_event", "asset_year_figure", "fiscal_year", "depreciation_rule", "assignment", "asset", "invoice_file" RESTART IDENTITY CASCADE',
  );
  for (const rule of LAUNCH_RULES) {
    await db.$executeRawUnsafe(
      `INSERT INTO "depreciation_rule"
         ("id", "entity", "effectiveFrom", "usefulLifeYears", "firstYearShare",
          "lowValueThresholdCents", "residualCents", "createdByUserId", "createdByEmail")
       VALUES ($1, $2::"Entity", DATE '${LAUNCH_RULE_EFFECTIVE_FROM}', $3, $4::"FirstYearShare", $5, $6, $7, $7)`,
      rule.id,
      rule.entity,
      rule.usefulLifeYears,
      rule.firstYearShare,
      rule.lowValueThresholdCents,
      rule.residualCents,
      LAUNCH_RULE_ACTOR,
    );
  }
}
