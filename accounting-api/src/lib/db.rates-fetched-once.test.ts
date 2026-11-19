/**
 * "A fetched rate is recorded once" at the database (T5, specs/20261119-accounting; AC-2.2, AC-2.6;
 * ADR 20261118-monthly-exchange-rates-are-fetched-on-demand-…). Modelled on refund-api's
 * `db.fx-fetched-once.test.ts`, which stays there until T24, with the entity added to the key.
 *
 * The partial unique index `exchange_rate_fetched_once` on (entity, currency, month) WHERE
 * origin = 'fetched' is the last wall behind the rates service's `ON CONFLICT DO NOTHING` (T11):
 * whatever the application does, a second `fetched` row for the same entity, currency and month
 * cannot exist, and a `corrected` row is never limited. These tests go through RAW SQL, so no
 * application code can be what is being tested, and they add what `db.checks.test.ts` does not: the
 * exact violation (SQLSTATE 23505 on that index), a RACE of concurrent inserts, and the order of a
 * correction and a fetch.
 *
 * Real Postgres, no mocking. Cleanup is TRUNCATE (triggers do not fire).
 */

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { db } from "./db";
import { SQLSTATE, truncateAccountingTables, violation } from "../test-support/dbCleanup";

type Entity = "welld_ch" | "welld_it";
type Origin = "fetched" | "corrected";
type RateCurrency = "EUR" | "USD" | "GBP" | "CHF";

let n = 0;
/** One raw INSERT into `exchange_rate_entry`. `month` is `YYYY-MM-DD`. */
function rawInsert(
  origin: Origin,
  o: { entity?: Entity; currency?: RateCurrency; month?: string; rateMicros?: number; sourceUrl?: string } = {},
) {
  const id = `rate-${++n}`;
  const entity = o.entity ?? "welld_ch";
  const currency = o.currency ?? "EUR";
  const month = o.month ?? "2026-03-01";
  const rateMicros = o.rateMicros ?? 924_600;
  const isFetched = origin === "fetched";
  return db.$executeRaw`
    INSERT INTO "exchange_rate_entry"
      ("id", "entity", "currency", "month", "rateMicros", "origin", "sourceUrl", "sourceMonth", "fetchedAt", "createdByUserId", "createdByEmail")
    VALUES
      (${id}, ${entity}::"Entity", ${currency}::"Currency", ${month}::date, ${rateMicros}, ${origin}::"RateOrigin",
       ${isFetched ? (o.sourceUrl ?? "https://example.test/x") : null}, ${isFetched ? month.slice(0, 7) : null},
       ${isFetched ? new Date() : null},
       ${isFetched ? "system:rates-fetch" : "admin-1"}, ${isFetched ? "system-rates-fetch@welld.ch" : "admin@welld.ch"})`;
}

const count = (where: { entity?: Entity; currency?: RateCurrency; origin?: Origin; month?: string } = {}) =>
  db.exchangeRateEntry.count({
    where: {
      ...(where.entity ? { entity: where.entity } : {}),
      ...(where.currency ? { currency: where.currency } : {}),
      ...(where.origin ? { origin: where.origin } : {}),
      ...(where.month ? { month: new Date(`${where.month}T00:00:00.000Z`) } : {}),
    },
  });

beforeEach(truncateAccountingTables);
afterAll(truncateAccountingTables);

describe("a second fetched row for the same (entity, currency, month) is refused (AC-2.2)", () => {
  it("raw INSERT: unique violation 23505 on exchange_rate_fetched_once, and the first row is untouched", async () => {
    await rawInsert("fetched", { rateMicros: 924_600 });
    const refused = await violation(rawInsert("fetched", { rateMicros: 999_999 }));
    expect(refused.code).toBe(SQLSTATE.unique);
    expect(refused.message).toContain("exchange_rate_fetched_once");

    const rows = await db.exchangeRateEntry.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.rateMicros).toBe(924_600);
  });

  it("whatever else differs (rate, source URL, time), it is still the same key", async () => {
    await rawInsert("fetched");
    expect((await violation(rawInsert("fetched", { rateMicros: 1, sourceUrl: "https://other.example/y" }))).code).toBe(SQLSTATE.unique);
    expect((await violation(rawInsert("fetched", { rateMicros: 924_600 }))).code).toBe(SQLSTATE.unique);
    expect(await count({ origin: "fetched" })).toBe(1);
  });

  it("another currency, another month or another ENTITY is another key", async () => {
    await rawInsert("fetched", { currency: "EUR", month: "2026-03-01" });
    await rawInsert("fetched", { currency: "USD", month: "2026-03-01" });
    await rawInsert("fetched", { currency: "GBP", month: "2026-03-01" });
    await rawInsert("fetched", { currency: "EUR", month: "2026-04-01" });
    await rawInsert("fetched", { currency: "EUR", month: "2025-03-01" });
    // The same currency and month in the other entity (a rate of welld_it is the model's, the source's absence is the service's).
    await rawInsert("fetched", { entity: "welld_it", currency: "USD", month: "2026-03-01" });
    await rawInsert("fetched", { entity: "welld_it", currency: "GBP", month: "2026-03-01" });
    expect(await count({ origin: "fetched" })).toBe(7);
    expect(await count({ entity: "welld_it" })).toBe(2);
  });

  it("a month that is not the first day cannot be used to get a second fetched row for the month (the CHECK stops it first)", async () => {
    await rawInsert("fetched", { month: "2026-03-01" });
    const refused = await violation(rawInsert("fetched", { month: "2026-03-02" }));
    expect(refused.code).toBe(SQLSTATE.check);
    expect(refused.message).toContain("exchange_rate_entry_month_first_day");
    expect(await count({ origin: "fetched" })).toBe(1);
  });

  it("an existing row cannot be turned into a second fetched row: UPDATE is refused by the immutability trigger", async () => {
    await rawInsert("fetched");
    await rawInsert("corrected", { rateMicros: 930_000 });
    const refused = await violation(
      db.$executeRaw`UPDATE "exchange_rate_entry" SET "origin" = 'fetched'::"RateOrigin" WHERE "origin" = 'corrected'::"RateOrigin"`,
    );
    expect(refused.code).toBe(SQLSTATE.raise);
    expect(refused.message).toMatch(/append-only/);
    expect(await count({ origin: "fetched" })).toBe(1);
    expect(await count({ origin: "corrected" })).toBe(1);
  });

  it("a race of concurrent inserts for one key: exactly one wins, the others are refused with 23505", async () => {
    const attempts = Array.from({ length: 12 }, (_, i) =>
      Promise.resolve(rawInsert("fetched", { rateMicros: 900_000 + i })).then(
        () => "inserted" as const,
        (error: unknown) =>
          (error as { meta?: { driverAdapterError?: { cause?: { originalCode?: string } } } }).meta?.driverAdapterError?.cause?.originalCode ?? "other",
      ),
    );
    const outcomes = await Promise.all(attempts);
    expect(outcomes.filter((o) => o === "inserted")).toHaveLength(1);
    expect(outcomes.filter((o) => o === SQLSTATE.unique)).toHaveLength(11);
    expect(await count({ origin: "fetched" })).toBe(1);
  });

  it("`INSERT … ON CONFLICT DO NOTHING` (what the rates service will do) inserts once and reports the rest as 0 rows", async () => {
    const insert = (i: number) =>
      db.$executeRaw`
        INSERT INTO "exchange_rate_entry"
          ("id", "entity", "currency", "month", "rateMicros", "origin", "sourceUrl", "sourceMonth", "fetchedAt", "createdByUserId", "createdByEmail")
        VALUES (${`race-${i}`}, 'welld_ch'::"Entity", 'EUR'::"Currency", '2026-03-01'::date, ${924_600 + i}, 'fetched'::"RateOrigin",
                'https://example.test/x', '2026-03', now(), 'system:rates-fetch', 'system-rates-fetch@welld.ch')
        ON CONFLICT ("entity", "currency", "month") WHERE "origin" = 'fetched' DO NOTHING`;
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => Promise.resolve(insert(i))));
    expect(results.filter((r) => r === 1)).toHaveLength(1);
    expect(results.filter((r) => r === 0)).toHaveLength(11);
    expect(await count({ origin: "fetched" })).toBe(1);
  });
});

describe("a corrected row is never limited (AC-2.4, AC-2.6)", () => {
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
    expect((await violation(rawInsert("fetched", { rateMicros: 940_000 }))).code).toBe(SQLSTATE.unique);
  });

  it("a fetch that arrives after a correction is recorded and the correction stays the latest row (the service picks it as in effect)", async () => {
    await rawInsert("corrected", { rateMicros: 930_000 });
    await rawInsert("fetched", { rateMicros: 924_600 });
    const rows = await db.exchangeRateEntry.findMany({ where: { entity: "welld_ch", currency: "EUR" }, orderBy: { createdAt: "asc" } });
    expect(rows.map((r) => r.origin)).toEqual(["corrected", "fetched"]);
    expect(rows.find((r) => r.origin === "corrected")!.rateMicros).toBe(930_000);
  });
});

describe("the index itself", () => {
  it("is partial and unique, on (entity, currency, month) and nothing else", async () => {
    const rows = await db.$queryRawUnsafe<{ indexdef: string }[]>(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'exchange_rate_fetched_once'`,
    );
    expect(rows).toHaveLength(1);
    const def = rows[0]!.indexdef;
    expect(def).toMatch(/CREATE UNIQUE INDEX/);
    expect(def).toMatch(/\(entity, currency, month\)/);
    expect(def).toMatch(/WHERE \(origin = 'fetched'::"RateOrigin"\)/);
  });
});
