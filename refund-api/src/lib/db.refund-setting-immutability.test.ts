/**
 * `refund_setting` immutability integration tests (T2, specs/011-refund-settings,
 * AC-5.2, ADR-0027) — mirrors `db.mileage-rate-immutability.test.ts` verbatim
 * in structure.
 *
 * Strategy
 * ────────
 * - Real Postgres (compose, `refund` database) — no DB mocking. Exercises the
 *   actual `20260722173000_add_refund_settings` migration's raw-SQL trigger,
 *   not application code (there IS no application code for settings
 *   mutation — the whole point is that even a direct-SQL / direct-Prisma-
 *   client write is refused at the database layer; no update/delete route
 *   exists at all, T3).
 * - Cleanup uses `TRUNCATE ... CASCADE` (via `truncateRefundTables`), NOT
 *   `DELETE` — TRUNCATE does not fire row-level `BEFORE DELETE` triggers, so
 *   it can safely reset fixture data without being blocked by the very
 *   immutability guarantee under test.
 * - `asPromise()`: Prisma 7's client methods return a lazy `PrismaPromise`
 *   (thenable, but NOT `instanceof Promise`) rather than a native Promise.
 *   `bun:test`'s `expect(...).resolves`/`.rejects` require a real Promise
 *   instance and throw "Expected promise" otherwise — `Promise.resolve()`
 *   normalizes any thenable into a genuine native Promise before assertion.
 *
 * AC coverage
 * ───────────
 * AC-5.2  a raw-SQL UPDATE and a raw-SQL DELETE on "refund_setting" both
 *         fail, and the row is provably untouched afterward
 * AC-5.2  the trigger also blocks the Prisma client's own update()/delete()
 *         calls, not just raw SQL
 * (control)  a plain INSERT (append) still succeeds — the trigger only
 *            blocks UPDATE/DELETE, never append
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { db } from "./db";
import { truncateRefundTables } from "../test-support/dbCleanup";

const asPromise = <T>(value: PromiseLike<T>): Promise<T> => Promise.resolve(value);

async function makeSettingRow() {
  return db.refundSetting.create({
    data: {
      key: "accounting-distribution-email",
      value: "accounting@welld.ch",
      createdByUserId: "admin-1",
      createdByEmail: "admin@welld.ch",
    },
  });
}

describe("RefundSetting immutability (specs/011-refund-settings, ADR-0027)", () => {
  beforeEach(async () => {
    await truncateRefundTables();
  });

  afterAll(async () => {
    await truncateRefundTables();
  });

  it("(AC-5.2) a raw-SQL UPDATE on refund_setting is rejected by the trigger", async () => {
    const entry = await makeSettingRow();

    await expect(
      asPromise(
        db.$executeRawUnsafe(
          `UPDATE "refund_setting" SET "value" = $1 WHERE id = $2`,
          "changed@welld.ch",
          entry.id,
        ),
      ),
    ).rejects.toThrow(/append-only/);

    // Prove the row is genuinely untouched, not merely that the promise rejected.
    const reread = await db.refundSetting.findUniqueOrThrow({ where: { id: entry.id } });
    expect(reread.value).toBe("accounting@welld.ch");
  });

  it("(AC-5.2) a raw-SQL DELETE on refund_setting is rejected by the trigger", async () => {
    const entry = await makeSettingRow();

    await expect(
      asPromise(db.$executeRawUnsafe(`DELETE FROM "refund_setting" WHERE id = $1`, entry.id)),
    ).rejects.toThrow(/append-only/);

    await expect(
      asPromise(db.refundSetting.findUniqueOrThrow({ where: { id: entry.id } })),
    ).resolves.toBeTruthy();
  });

  it("(AC-5.2) the trigger also blocks the Prisma client's own update()/delete() calls, not just raw SQL", async () => {
    const entry = await makeSettingRow();

    // refund-api exposes no update/delete route for refund_setting rows at
    // all (T3+ never add one) — this proves that even if a future bug called
    // the Prisma client directly, the database-level trigger still refuses it.
    await expect(
      asPromise(
        db.refundSetting.update({
          where: { id: entry.id },
          data: { value: "changed@welld.ch" },
        }),
      ),
    ).rejects.toThrow();

    await expect(
      asPromise(db.refundSetting.delete({ where: { id: entry.id } })),
    ).rejects.toThrow();

    const reread = await db.refundSetting.findUniqueOrThrow({ where: { id: entry.id } });
    expect(reread.value).toBe("accounting@welld.ch");
  });

  it("(control) appending a NEW row always succeeds — the trigger only blocks UPDATE/DELETE", async () => {
    await makeSettingRow();
    await expect(
      asPromise(
        db.refundSetting.create({
          data: {
            key: "accounting-distribution-email",
            value: null,
            createdByUserId: "admin-1",
            createdByEmail: "admin@welld.ch",
          },
        }),
      ),
    ).resolves.toBeTruthy();

    expect(await db.refundSetting.count()).toBe(2);
  });
});
