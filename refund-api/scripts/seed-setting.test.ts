/**
 * Integration test for the cutover seed script (T5, specs/011-refund-settings,
 * plan.md D7, AC-4.2).
 *
 * AC coverage
 * ───────────
 * AC-4.2 `settings:seed` appends when empty; a second run is idempotent
 *        (no duplicate row, no error, no changed value)
 */

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { db } from "../src/lib/db";
import { truncateRefundTables } from "../src/test-support/dbCleanup";
import {
  CUTOVER_ACTOR_EMAIL,
  CUTOVER_ACTOR_USER_ID,
  seedAccountingDistributionEmail,
} from "./seed-setting";

const KEY = "accounting-distribution-email";

beforeEach(async () => {
  await truncateRefundTables();
});

afterAll(async () => {
  await truncateRefundTables();
});

describe("seedAccountingDistributionEmail (T5, specs/011-refund-settings)", () => {
  it("(AC-4.2) appends the initial row when the key has no rows yet", async () => {
    const result = await seedAccountingDistributionEmail("accounting@welld.ch");
    expect(result.outcome).toBe("seeded");

    const rows = await db.refundSetting.findMany({ where: { key: KEY } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.value).toBe("accounting@welld.ch");
    expect(rows[0]?.createdByUserId).toBe(CUTOVER_ACTOR_USER_ID);
    expect(rows[0]?.createdByEmail).toBe(CUTOVER_ACTOR_EMAIL);
  });

  it("(AC-4.2) a second run is idempotent — no duplicate row, existing value untouched", async () => {
    await seedAccountingDistributionEmail("accounting@welld.ch");

    const second = await seedAccountingDistributionEmail("different@welld.ch");
    expect(second.outcome).toBe("already-configured");

    const rows = await db.refundSetting.findMany({ where: { key: KEY } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.value).toBe("accounting@welld.ch"); // unchanged — the second value never persisted
  });

  it("rejects a malformed value without persisting anything", async () => {
    const result = await seedAccountingDistributionEmail("not-an-email");
    expect(result.outcome).toBe("invalid");
    expect(await db.refundSetting.count({ where: { key: KEY } })).toBe(0);
  });

  it("a pre-existing row from a real admin PUT also short-circuits the seed (idempotent regardless of provenance)", async () => {
    await db.refundSetting.create({
      data: {
        key: KEY,
        value: "admin-set@welld.ch",
        createdByUserId: "admin-1",
        createdByEmail: "admin@welld.ch",
      },
    });

    const result = await seedAccountingDistributionEmail("accounting@welld.ch");
    expect(result.outcome).toBe("already-configured");

    const rows = await db.refundSetting.findMany({ where: { key: KEY } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.value).toBe("admin-set@welld.ch");
  });
});
