/**
 * The release gate reader (T8, specs/20261118-refund-accounting-export, plan D6).
 */

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { db } from "../lib/db";
import { truncateRefundTables } from "../test-support/dbCleanup";
import { isAccountingReleased, RELEASE_MARKER_KEY } from "./release";

const actor = { createdByUserId: "system:accounting-release", createdByEmail: "system-accounting-release@welld.ch" };

beforeEach(async () => {
  await truncateRefundTables();
});
afterAll(async () => {
  await truncateRefundTables();
});

describe("isAccountingReleased", () => {
  it("is false until the marker exists", async () => {
    expect(await db.$transaction((tx) => isAccountingReleased(tx))).toBe(false);
  });

  it("is true once the marker has a value, and reads other keys as nothing", async () => {
    await db.refundSetting.create({ data: { key: "accounting-distribution-email", value: "a@b.ch", ...actor } });
    expect(await db.$transaction((tx) => isAccountingReleased(tx))).toBe(false);
    await db.refundSetting.create({ data: { key: RELEASE_MARKER_KEY, value: "2026-11-19T10:00:00.000Z", ...actor } });
    expect(await db.$transaction((tx) => isAccountingReleased(tx))).toBe(true);
  });

  it("an empty or null latest value counts as not released", async () => {
    await db.refundSetting.create({ data: { key: RELEASE_MARKER_KEY, value: null, ...actor } });
    expect(await db.$transaction((tx) => isAccountingReleased(tx))).toBe(false);
  });

  it("the marker is the key the plan names", () => {
    expect(RELEASE_MARKER_KEY).toBe("accounting-release-completed-at");
  });
});
