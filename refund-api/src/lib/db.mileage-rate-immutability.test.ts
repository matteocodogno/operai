/**
 * Mileage-rate immutability integration tests (T7, specs/009-mileage-rate,
 * AC-4.7, AC-5.2, ADR-0018) — mirrors `db.audit-immutability.test.ts`
 * verbatim in structure.
 *
 * Strategy
 * ────────
 * - Real Postgres (compose, `refund` database) — no DB mocking. Exercises
 *   the actual `20260720170000_mileage_rate` migration's raw-SQL trigger,
 *   not application code (there IS no application code for rate mutation —
 *   the whole point is that even a direct-SQL / direct-Prisma-client write
 *   is refused at the database layer; no update/delete route exists at all,
 *   T4).
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
 * AC-4.7/5.2  a raw-SQL UPDATE and a raw-SQL DELETE on "mileage_rate" both
 *             fail, and the row is provably untouched afterward
 * AC-4.7/5.2  the trigger also blocks the Prisma client's own update()/
 *             delete() calls, not just raw SQL
 * (control)   a plain INSERT still succeeds — the trigger only blocks
 *             UPDATE/DELETE, never append
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { db } from "./db";
import { truncateRefundTables } from "../test-support/dbCleanup";

const asPromise = <T>(value: PromiseLike<T>): Promise<T> => Promise.resolve(value);

async function makeRateEntry() {
  return db.mileageRate.create({
    data: {
      entity: "welld_ch",
      currency: "CHF",
      ratePerKmMicros: 700000,
      validFrom: new Date("2026-01-01T00:00:00.000Z"),
      createdByUserId: "admin-1",
      createdByEmail: "admin@welld.ch",
    },
  });
}

describe("MileageRate immutability (specs/009-mileage-rate, ADR-0018)", () => {
  beforeEach(async () => {
    await truncateRefundTables();
  });

  afterAll(async () => {
    await truncateRefundTables();
  });

  it("(AC-4.7/5.2) a raw-SQL UPDATE on mileage_rate is rejected by the trigger", async () => {
    const entry = await makeRateEntry();

    await expect(
      asPromise(
        db.$executeRawUnsafe(
          `UPDATE "mileage_rate" SET "ratePerKmMicros" = 1 WHERE id = $1`,
          entry.id,
        ),
      ),
    ).rejects.toThrow(/append-only/);

    // Prove the row is genuinely untouched, not merely that the promise rejected.
    const reread = await db.mileageRate.findUniqueOrThrow({ where: { id: entry.id } });
    expect(reread.ratePerKmMicros).toBe(700000);
  });

  it("(AC-4.7/5.2) a raw-SQL DELETE on mileage_rate is rejected by the trigger", async () => {
    const entry = await makeRateEntry();

    await expect(
      asPromise(db.$executeRawUnsafe(`DELETE FROM "mileage_rate" WHERE id = $1`, entry.id)),
    ).rejects.toThrow(/append-only/);

    await expect(
      asPromise(db.mileageRate.findUniqueOrThrow({ where: { id: entry.id } })),
    ).resolves.toBeTruthy();
  });

  it("(AC-4.7/5.2) the trigger also blocks the Prisma client's own update()/delete() calls, not just raw SQL", async () => {
    const entry = await makeRateEntry();

    // refund-api exposes no update/delete route for mileage_rate rows at all
    // (T4+ never add one) — this proves that even if a future bug called the
    // Prisma client directly, the database-level trigger still refuses it.
    await expect(
      asPromise(
        db.mileageRate.update({
          where: { id: entry.id },
          data: { ratePerKmMicros: 1 },
        }),
      ),
    ).rejects.toThrow();

    await expect(
      asPromise(db.mileageRate.delete({ where: { id: entry.id } })),
    ).rejects.toThrow();

    const reread = await db.mileageRate.findUniqueOrThrow({ where: { id: entry.id } });
    expect(reread.ratePerKmMicros).toBe(700000);
  });

  it("(control) appending a NEW entry always succeeds — the trigger only blocks UPDATE/DELETE", async () => {
    await makeRateEntry();
    await expect(
      asPromise(
        db.mileageRate.create({
          data: {
            entity: "welld_ch",
            currency: "CHF",
            ratePerKmMicros: 720000,
            validFrom: new Date("2026-06-01T00:00:00.000Z"),
            createdByUserId: "admin-1",
            createdByEmail: "admin@welld.ch",
          },
        }),
      ),
    ).resolves.toBeTruthy();

    expect(await db.mileageRate.count()).toBe(2);
  });
});
