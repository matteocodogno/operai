/**
 * "A fetched rate is recorded once" at the database (T19, specs/20261118-refund-
 * accounting-export; AC-5.1, AC-5.4; ADR 20261118-monthly-exchange-rates-are-
 * fetched-on-demand-...; plan § Test strategy "Extra tests", row 2).
 *
 * The partial unique index `exchange_rate_fetched_once` (currency, month) WHERE
 * origin = 'fetched' is the last wall behind the service's `ON CONFLICT DO NOTHING`:
 * whatever the application does, a second `fetched` row for the same currency and
 * month cannot exist, and a `corrected` row is never limited. These tests go
 * through RAW SQL, so no application code can be what is being tested, and they
 * add what `db.accounting-immutability.test.ts` does not: the exact violation
 * (SQLSTATE 23505 on that index), a RACE of concurrent inserts, the fx repo's own
 * insert under the same race, and the order of a correction and a fetch.
 *
 * Real Postgres, no mocking. Cleanup uses TRUNCATE (triggers do not fire).
 */

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { db } from "./db";
import { truncateRefundTables } from "../test-support/dbCleanup";

process.env["ALLOWED_ORIGINS"] = "http://localhost:5173";
process.env["AUTH_JWKS_URL"] = "http://localhost:3001/auth/jwks";
process.env["AUTH_ISSUER"] = "http://localhost:3001";
process.env["AUTH_BASE_URL"] = "http://localhost:3001";
process.env["AUTH_AUDIENCE"] = "operai-suite";
process.env["NODE_ENV"] = "test";

const { insertFetchedRate, effectiveEntry, listEntriesFor } = await import("../fx/fx.repo");

type Origin = "fetched" | "corrected";
type RateCurrency = "EUR" | "USD" | "GBP";

let n = 0;
/** One raw INSERT into `exchange_rate_entry`. `month` is `YYYY-MM-DD`. */
function rawInsert(origin: Origin, o: { currency?: RateCurrency; month?: string; rateMicros?: number; sourceUrl?: string } = {}) {
  const id = `rate-${++n}`;
  const currency = o.currency ?? "EUR";
  const month = o.month ?? "2026-03-01";
  const rateMicros = o.rateMicros ?? 924_600;
  return db.$executeRaw`
    INSERT INTO "exchange_rate_entry"
      ("id", "currency", "month", "rateMicros", "origin", "sourceUrl", "sourceMonth", "fetchedAt", "createdByUserId", "createdByEmail")
    VALUES
      (${id}, ${currency}::"Currency", ${month}::date, ${rateMicros}, ${origin}::"ExchangeRateOrigin",
       ${origin === "fetched" ? (o.sourceUrl ?? "https://example.test/x") : null}, ${origin === "fetched" ? month.slice(0, 7) : null},
       ${origin === "fetched" ? new Date() : null},
       ${origin === "fetched" ? "system:fx-fetch" : "admin-1"}, ${origin === "fetched" ? "system-fx-fetch@welld.ch" : "admin@welld.ch"})`;
}

/** The Postgres error behind a failed raw query: SQLSTATE and message. */
async function violation(promise: PromiseLike<unknown>): Promise<{ code: string; message: string }> {
  try {
    await promise;
  } catch (error) {
    const cause = (error as { meta?: { driverAdapterError?: { cause?: { originalCode?: string; originalMessage?: string } } } }).meta
      ?.driverAdapterError?.cause;
    return { code: cause?.originalCode ?? "?", message: cause?.originalMessage ?? String(error) };
  }
  throw new Error("expected the insert to be refused, but it succeeded");
}

const count = (where: { currency?: RateCurrency; origin?: Origin; month?: string } = {}) =>
  db.exchangeRateEntry.count({
    where: {
      ...(where.currency ? { currency: where.currency } : {}),
      ...(where.origin ? { origin: where.origin } : {}),
      ...(where.month ? { month: new Date(`${where.month}T00:00:00.000Z`) } : {}),
    },
  });

beforeEach(async () => {
  await truncateRefundTables();
});
afterAll(async () => {
  await truncateRefundTables();
});

describe("a second fetched row for the same (currency, month) is refused (AC-5.1, AC-5.4)", () => {
  it("raw INSERT: unique violation 23505 on exchange_rate_fetched_once, and the first row is untouched", async () => {
    await rawInsert("fetched", { rateMicros: 924_600 });
    const refused = await violation(rawInsert("fetched", { rateMicros: 999_999 }));
    expect(refused.code).toBe("23505");
    expect(refused.message).toContain("exchange_rate_fetched_once");

    const rows = await db.exchangeRateEntry.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.rateMicros).toBe(924_600);
  });

  it("whatever else differs (rate, source URL, time), it is still the same key", async () => {
    await rawInsert("fetched");
    expect((await violation(rawInsert("fetched", { rateMicros: 1, sourceUrl: "https://other.example/y" }))).code).toBe("23505");
    expect((await violation(rawInsert("fetched", { rateMicros: 924_600 }))).code).toBe("23505");
    expect(await count({ origin: "fetched" })).toBe(1);
  });

  it("another currency, or another month, is another key", async () => {
    await rawInsert("fetched", { currency: "EUR", month: "2026-03-01" });
    await rawInsert("fetched", { currency: "USD", month: "2026-03-01" });
    await rawInsert("fetched", { currency: "GBP", month: "2026-03-01" });
    await rawInsert("fetched", { currency: "EUR", month: "2026-04-01" });
    await rawInsert("fetched", { currency: "EUR", month: "2025-03-01" });
    expect(await count({ origin: "fetched" })).toBe(5);
  });

  it("a month that is not the first day cannot be used to get a second fetched row for the month (the CHECK)", async () => {
    await rawInsert("fetched", { month: "2026-03-01" });
    const refused = await violation(rawInsert("fetched", { month: "2026-03-02" }));
    expect(refused.code).toBe("23514"); // check_violation, not a unique one: the CHECK stops it first
    expect(await count({ origin: "fetched" })).toBe(1);
  });

  it("an existing row cannot be turned into a second fetched row: UPDATE is refused by the immutability trigger", async () => {
    await rawInsert("fetched");
    await rawInsert("corrected", { rateMicros: 930_000 });
    const refused = await violation(db.$executeRaw`UPDATE "exchange_rate_entry" SET "origin" = 'fetched'::"ExchangeRateOrigin" WHERE "origin" = 'corrected'::"ExchangeRateOrigin"`);
    expect(refused.message).toMatch(/immutable|append-only|exchange_rate_entry/i);
    expect(await count({ origin: "fetched" })).toBe(1);
    expect(await count({ origin: "corrected" })).toBe(1);
  });

  it("a race of concurrent inserts for one key: exactly one wins, the others are refused with 23505", async () => {
    const attempts = Array.from({ length: 12 }, (_, i) =>
      Promise.resolve(rawInsert("fetched", { rateMicros: 900_000 + i })).then(
        () => "inserted" as const,
        (error: unknown) =>
          (error as { meta?: { driverAdapterError?: { cause?: { originalCode?: string } } } }).meta?.driverAdapterError?.cause?.originalCode ??
          "other",
      ),
    );
    const outcomes = await Promise.all(attempts);
    expect(outcomes.filter((o) => o === "inserted")).toHaveLength(1);
    expect(outcomes.filter((o) => o === "23505")).toHaveLength(11);
    expect(await count({ origin: "fetched" })).toBe(1);
  });

  it("the fx repo's own insert under the same race: one `true`, the rest `false`, nothing thrown, one row", async () => {
    const input = (i: number) => ({
      currency: "EUR" as const,
      month: "2026-03",
      rateMicros: 924_600 + i,
      sourceUrl: "https://example.test/x",
      sourceMonth: "2026-03",
      fetchedAt: new Date("2026-04-10T08:00:00.000Z"),
    });
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => insertFetchedRate(db, input(i))));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await count({ origin: "fetched" })).toBe(1);
    // The winner is whoever got there first; what matters is that the stored value is one of the offered ones, unchanged by the losers.
    const [row] = await db.exchangeRateEntry.findMany();
    const stored = row!.rateMicros;
    expect(stored).toBeGreaterThanOrEqual(924_600);
    expect(stored).toBeLessThan(924_612);
    expect(await insertFetchedRate(db, input(500))).toBe(false);
    expect((await db.exchangeRateEntry.findMany())[0]!.rateMicros).toBe(stored);
  });
});

describe("a corrected row is never limited", () => {
  it("any number of corrections are accepted for the same key, before or after the fetched row", async () => {
    await rawInsert("corrected", { rateMicros: 910_000 }); // a correction can come before any fetch
    await rawInsert("fetched", { rateMicros: 924_600 });
    await rawInsert("corrected", { rateMicros: 930_000 });
    await rawInsert("corrected", { rateMicros: 931_000 });
    await rawInsert("corrected", { rateMicros: 931_000 }); // even an identical value: the table does not judge, the service does
    expect(await count({ origin: "corrected" })).toBe(4);
    expect(await count({ origin: "fetched" })).toBe(1);
  });

  it("a second fetched row is refused even when corrections already exist", async () => {
    await rawInsert("fetched");
    await rawInsert("corrected", { rateMicros: 930_000 });
    expect((await violation(rawInsert("fetched", { rateMicros: 940_000 }))).code).toBe("23505");
  });

  it("the correction stays in effect when the fetch arrives after it (AC-5.4)", async () => {
    await rawInsert("corrected", { rateMicros: 930_000 });
    expect(
      await insertFetchedRate(db, {
        currency: "EUR",
        month: "2026-03",
        rateMicros: 924_600,
        sourceUrl: "https://example.test/x",
        sourceMonth: "2026-03",
        fetchedAt: new Date("2026-04-10T08:00:00.000Z"),
      }),
    ).toBe(true);
    const inEffect = effectiveEntry(await listEntriesFor(db, "EUR", "2026-03"));
    expect(inEffect).toMatchObject({ origin: "corrected", rateMicros: 930_000 });
  });
});
