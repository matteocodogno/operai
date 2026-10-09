/**
 * Closed-year guard and entity lock (T9, specs/015-hardware-inventory; AC-1.7).
 * Real Postgres: the lock and the boundary read are database behaviour, and a
 * mock would only prove that the mock was called.
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { db } from "../lib/db";
import { ProblemError } from "../lib/problem";
import { truncateInventoryTables } from "../test-support/dbCleanup";
import {
  assertYearOpen,
  isClosed,
  lastClosedYear,
  lockEntity,
  yearOf,
  type Tx,
} from "./guard";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type EntityName = "welld_ch" | "welld_it";

async function closeYear(entity: EntityName, year: number, tx: Tx | typeof db = db) {
  return tx.fiscalYear.create({
    data: {
      entity,
      year,
      openingCents: 0,
      disposalsCents: 0,
      purchasesCents: 0,
      depreciationCents: 0,
      closingCents: 0,
      source: "closed",
      closedByUserId: "accountant-1",
    },
  });
}

const inTx = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> =>
  db.$transaction(fn) as Promise<T>;

beforeEach(async () => {
  await truncateInventoryTables();
});
afterAll(async () => {
  await truncateInventoryTables();
});

describe("isClosed / lastClosedYear", () => {
  it("nothing is closed while the entity has no fiscal_year row", async () => {
    expect(await inTx((tx) => lastClosedYear(tx, "welld_ch"))).toBeNull();
    expect(await inTx((tx) => isClosed(tx, "welld_ch", 1999))).toBe(false);
    expect(await inTx((tx) => isClosed(tx, "welld_ch", 2100))).toBe(false);
  });

  it("year <= the latest closed year is closed; the next one is open", async () => {
    await closeYear("welld_ch", 2024);
    await closeYear("welld_ch", 2025);
    expect(await inTx((tx) => lastClosedYear(tx, "welld_ch"))).toBe(2025);
    expect(await inTx((tx) => isClosed(tx, "welld_ch", 2023))).toBe(true);
    expect(await inTx((tx) => isClosed(tx, "welld_ch", 2024))).toBe(true);
    expect(await inTx((tx) => isClosed(tx, "welld_ch", 2025))).toBe(true);
    expect(await inTx((tx) => isClosed(tx, "welld_ch", 2026))).toBe(false);
  });

  it("is per entity: closing welld_ch says nothing about welld_it", async () => {
    await closeYear("welld_ch", 2025);
    expect(await inTx((tx) => isClosed(tx, "welld_it", 2025))).toBe(false);
    expect(await inTx((tx) => lastClosedYear(tx, "welld_it"))).toBeNull();
  });
});

describe("assertYearOpen", () => {
  it("does nothing for an open year", async () => {
    await closeYear("welld_ch", 2025);
    await inTx((tx) => assertYearOpen(tx, "welld_ch", 2026));
  });

  it("throws the fiscal_year_closed problem, with the offending year at the top level", async () => {
    await closeYear("welld_ch", 2025);
    const error = await inTx((tx) => assertYearOpen(tx, "welld_ch", 2024)).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ProblemError);
    const problem = error as ProblemError;
    expect(problem.status).toBe(409);
    expect(problem.code).toBe("fiscal_year_closed");
    const body = (await problem.toResponse("/assets").json()) as Record<string, unknown>;
    expect(body["code"]).toBe("fiscal_year_closed");
    expect(body["year"]).toBe(2024);
    expect(body).not.toHaveProperty("extras");
  });

  it("the boundary year itself is closed", async () => {
    await closeYear("welld_ch", 2025);
    await expect(inTx((tx) => assertYearOpen(tx, "welld_ch", 2025))).rejects.toBeInstanceOf(
      ProblemError,
    );
  });

  it("another entity's close does not block this one", async () => {
    await closeYear("welld_it", 2025);
    await inTx((tx) => assertYearOpen(tx, "welld_ch", 2025));
  });
});

describe("yearOf", () => {
  it("reads the UTC year, so 1 January is that year in any timezone", () => {
    expect(yearOf(new Date("2026-01-01T00:00:00.000Z"))).toBe(2026);
    expect(yearOf(new Date("2025-12-31T00:00:00.000Z"))).toBe(2025);
  });
});

describe("lockEntity", () => {
  it("two transactions on one entity serialise: the second waits for the first to finish", async () => {
    const events: string[] = [];

    const first = inTx(async (tx) => {
      await lockEntity(tx, "welld_ch");
      events.push("A locked");
      await sleep(300);
      events.push("A done");
    });
    await sleep(60); // let A take the lock first
    const second = inTx(async (tx) => {
      events.push("B waiting");
      await lockEntity(tx, "welld_ch");
      events.push("B locked");
    });

    await Promise.all([first, second]);
    expect(events).toEqual(["A locked", "B waiting", "A done", "B locked"]);
  });

  it("the other entity is not blocked", async () => {
    const events: string[] = [];

    const first = inTx(async (tx) => {
      await lockEntity(tx, "welld_ch");
      events.push("CH locked");
      await sleep(300);
      events.push("CH done");
    });
    await sleep(60);
    const second = inTx(async (tx) => {
      await lockEntity(tx, "welld_it");
      events.push("IT locked");
    });

    await Promise.all([first, second]);
    expect(events).toEqual(["CH locked", "IT locked", "CH done"]);
  });

  it("is released when the transaction rolls back, not leaked", async () => {
    await expect(
      inTx(async (tx) => {
        await lockEntity(tx, "welld_ch");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    // Would hang (and hit the test timeout) if the lock had leaked.
    await inTx((tx) => lockEntity(tx, "welld_ch"));
  });

  it("is re-entrant within one transaction", async () => {
    await inTx(async (tx) => {
      await lockEntity(tx, "welld_ch");
      await lockEntity(tx, "welld_ch");
    });
  });

  it("a backdated write cannot slip in under a close that is running (lock, then read)", async () => {
    // The close takes the lock, is slow to commit its fiscal_year row, and a
    // dated write for the same entity arrives meanwhile. The write must wait
    // for the close to commit and then be refused — not read the boundary
    // before the close landed and succeed.
    const close = inTx(async (tx) => {
      await lockEntity(tx, "welld_ch");
      await sleep(300);
      await closeYear("welld_ch", 2025, tx);
    });
    await sleep(60);

    const backdatedWrite = inTx(async (tx) => {
      await lockEntity(tx, "welld_ch");
      await assertYearOpen(tx, "welld_ch", 2025);
    });

    const [, outcome] = await Promise.all([
      close,
      backdatedWrite.then(
        () => "accepted",
        (e: unknown) => (e instanceof ProblemError ? e.code : "other error"),
      ),
    ]);
    expect(outcome).toBe("fiscal_year_closed");
  });

  it("without the lock the same race is lost (proves the test above can fail)", async () => {
    const close = inTx(async (tx) => {
      await lockEntity(tx, "welld_ch");
      await sleep(300);
      await closeYear("welld_ch", 2025, tx);
    });
    await sleep(60);

    const unguardedWrite = inTx(async (tx) => {
      // no lockEntity
      await assertYearOpen(tx, "welld_ch", 2025);
    });

    const [, outcome] = await Promise.all([
      close,
      unguardedWrite.then(
        () => "accepted",
        () => "refused",
      ),
    ]);
    expect(outcome).toBe("accepted");
  });
});
