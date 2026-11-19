/**
 * The exchange-rate service against real Postgres (the `accounting` database) with a FAKE source (T11,
 * specs/20261119-accounting; moved from refund-api's fx.service.test.ts and adapted: per entity, the triggers
 * `manager` and `consumer`, the consumer rates, the two budgets). AC-2.1, AC-2.2, AC-2.4, AC-2.6, AC-2.8, AC-2.10,
 * AC-2.11; plan G5, G10, R2, R4, R6, D4. No test touches the network.
 */

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import "../test-support/testAuth"; // the environment of the suite (ACCOUNTING_FX_SOURCE=off, NODE_ENV=test) as an import side effect
import { truncateAccountingTables } from "../test-support/dbCleanup";
import { fakeSource, hangingFetcher, recordedMarch2026Xml, xmlFor } from "../test-support/fakeSource";
import type { FxFetcher } from "./bazgSource";

const { db } = await import("../lib/db");
const {
  CONSUMER_FETCH_BUDGET_MS,
  createRatesService,
  currenciesOf,
  FX_FETCH_BUDGET_MS,
  FX_MAX_MONTHS_PER_TRIGGER,
  FX_THROTTLE_MS,
  NoRateSourceError,
} = await import("./rates.service");
const { appendCorrection, insertFetchedRate, monthToDate } = await import("./rates.repo");

const NOW = new Date("2026-11-19T10:00:00.000Z"); // October is the newest fetchable month
const ADMIN = { userId: "admin-1" };
const CONSUMER = { userId: "system:refund-api" };
const CH = "welld_ch" as const;
const IT = "welld_it" as const;

let clock = NOW;
const service = (fetcher: FxFetcher, over: Partial<Parameters<typeof createRatesService>[0]> = {}) =>
  createRatesService({ mode: "bazg", fetcher, now: () => clock, ...over });

beforeEach(async () => {
  await truncateAccountingTables();
  clock = NOW;
});
afterAll(async () => {
  await truncateAccountingTables();
});

const entries = () => db.exchangeRateEntry.findMany({ orderBy: [{ createdAt: "asc" }, { currency: "asc" }] });
const attempts = () => db.exchangeRateFetchAttempt.findMany({ orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
const actor = { userId: "a", email: "a@welld.ch" };

describe("the constants (ADR 20261119-on-demand-outbound-work-..., plan D4)", () => {
  it("fixes the two budgets, the throttle and the month limit", () => {
    expect(FX_FETCH_BUDGET_MS).toBe(10_000);
    expect(CONSUMER_FETCH_BUDGET_MS).toBe(6_000);
    expect(CONSUMER_FETCH_BUDGET_MS).toBeLessThan(FX_FETCH_BUDGET_MS);
    expect(FX_THROTTLE_MS).toBe(15 * 60 * 1000);
    expect(FX_MAX_MONTHS_PER_TRIGGER).toBe(6);
  });

  it("converts EUR, USD and GBP for welld_ch and nothing for welld_it (D19)", () => {
    expect(currenciesOf(CH)).toEqual(["EUR", "USD", "GBP"]);
    expect(currenciesOf(IT)).toEqual([]);
  });
});

describe("fetchMonths: recording (AC-2.1)", () => {
  it("records EUR, USD and GBP for the entity with the source URL, the time and the system actor, and logs the attempt", async () => {
    const { fetcher, urls } = fakeSource();
    const res = await service(fetcher).fetchMonths(CH, ["2026-03"], "manager", ADMIN);
    expect(res.results).toEqual([
      { month: "2026-03", outcome: "ok", errorCode: null, recorded: { EUR: 924600, USD: 780800, GBP: 1063500 } },
    ]);
    expect(urls).toEqual(["https://www.backend-rates.bazg.admin.ch/api/xmlavgmonth?j=2026&m=03"]);
    const rows = await entries();
    expect(rows.map((r) => [r.entity, r.currency, r.rateMicros, r.origin]).sort()).toEqual([
      ["welld_ch", "EUR", 924600, "fetched"],
      ["welld_ch", "GBP", 1063500, "fetched"],
      ["welld_ch", "USD", 780800, "fetched"],
    ]);
    for (const row of rows) {
      expect(row).toMatchObject({
        sourceUrl: urls[0],
        sourceMonth: "2026-03",
        replacesRateMicros: null,
        createdByUserId: "system:rates-fetch",
        createdByEmail: "system-rates-fetch@welld.ch",
      });
      expect(row.fetchedAt?.toISOString()).toBe(NOW.toISOString());
      expect(row.month.toISOString()).toBe("2026-03-01T00:00:00.000Z");
    }
    const log = await attempts();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ entity: "welld_ch", outcome: "ok", trigger: "manager", actorUserId: "admin-1", errorCode: null, discrepancies: null });
    expect(log[0]!.recorded).toEqual({ EUR: 924600, USD: 780800, GBP: 1063500 });
  });

  it("reads the real recorded 2026-03 answer", async () => {
    const { fetcher } = fakeSource(() => new Response(recordedMarch2026Xml()));
    const res = await service(fetcher).fetchMonths(CH, ["2026-03"], "manager", ADMIN);
    expect(res.results[0]!.recorded).toEqual({ EUR: 924600, USD: 780800, GBP: 1063500 });
  });

  it("rateInEffect is the fetched rate; unknown is null", async () => {
    const svc = service(fakeSource().fetcher);
    await svc.fetchMonths(CH, ["2026-03"], "manager", ADMIN);
    expect((await svc.rateInEffect(CH, "EUR", "2026-03"))?.rateMicros).toBe(924600);
    expect(await svc.rateInEffect(CH, "EUR", "2026-04")).toBeNull();
  });
});

describe("one entity never changes another (AC-2.11)", () => {
  it("a welld_ch fetch writes nothing for welld_it: no rate row, no attempt row", async () => {
    const svc = service(fakeSource().fetcher);
    await svc.fetchMonths(CH, ["2026-03", "2026-04"], "manager", ADMIN);
    expect(await db.exchangeRateEntry.count({ where: { entity: IT } })).toBe(0);
    expect(await db.exchangeRateFetchAttempt.count({ where: { entity: IT } })).toBe(0);
    expect(await db.exchangeRateEntry.count({ where: { entity: CH } })).toBe(6);
  });

  it("a welld_it fetch is refused before anything is asked or written", async () => {
    const { fetcher, urls } = fakeSource();
    await expect(service(fetcher).fetchMonths(IT, ["2026-03"], "manager", ADMIN)).rejects.toBeInstanceOf(NoRateSourceError);
    await expect(service(fetcher).fetchMonths(IT, ["2026-03"], "consumer", CONSUMER)).rejects.toBeInstanceOf(NoRateSourceError);
    expect(urls).toHaveLength(0);
    expect(await db.exchangeRateEntry.count()).toBe(0);
    expect(await db.exchangeRateFetchAttempt.count()).toBe(0);
  });

  it("a rate of welld_it for the same currency and month is another key: the fetched-once index is per entity", async () => {
    await db.exchangeRateEntry.create({
      data: {
        entity: IT, currency: "USD", month: monthToDate("2026-03"), rateMicros: 555000, origin: "corrected",
        createdByUserId: "m", createdByEmail: "m@welld.it",
      },
    });
    const svc = service(fakeSource().fetcher);
    await svc.fetchMonths(CH, ["2026-03"], "manager", ADMIN);
    expect((await svc.rateInEffect(CH, "USD", "2026-03"))?.rateMicros).toBe(780800);
    expect((await svc.rateInEffect(IT, "USD", "2026-03"))?.rateMicros).toBe(555000);
  });

  it("a correction of welld_ch leaves welld_it alone, and the other way round", async () => {
    await appendCorrection(CH, { currency: "USD", month: "2026-03", rateMicros: 800000, actor });
    await appendCorrection(IT, { currency: "USD", month: "2026-03", rateMicros: 900000, actor });
    const svc = service(fakeSource().fetcher);
    expect((await svc.rateInEffect(CH, "USD", "2026-03"))?.rateMicros).toBe(800000);
    expect((await svc.rateInEffect(IT, "USD", "2026-03"))?.rateMicros).toBe(900000);
    expect(await svc.monthsNeedingFetch(IT)).toEqual([]);
    expect(await svc.fetchDue(IT)).toBe(false);
  });
});

describe("corrections and discrepancies (AC-2.2, AC-2.4, AC-2.6)", () => {
  it("a correction wins over the fetched rate and over a LATER fetch, whose different value is logged only as a discrepancy", async () => {
    let value = "0.9246";
    const { fetcher } = fakeSource((m) => new Response(xmlFor(m, value)));
    const svc = service(fetcher);
    await svc.fetchMonths(CH, ["2026-03"], "manager", ADMIN);
    const outcome = await appendCorrection(CH, { currency: "EUR", month: "2026-03", rateMicros: 930000, actor });
    expect(outcome.kind).toBe("recorded");
    expect((await svc.rateInEffect(CH, "EUR", "2026-03"))?.rateMicros).toBe(930000);

    clock = new Date(NOW.getTime() + FX_THROTTLE_MS + 1000);
    value = "0.9500";
    const again = await svc.fetchMonths(CH, ["2026-03"], "manager", ADMIN);
    expect(again.results[0]).toMatchObject({ outcome: "ok", recorded: {} });

    expect((await svc.rateInEffect(CH, "EUR", "2026-03"))?.rateMicros).toBe(930000);
    expect((await entries()).filter((e) => e.currency === "EUR")).toHaveLength(2); // fetched + corrected, nothing added
    const last = (await attempts()).at(-1)!;
    expect(last.discrepancies).toEqual({ EUR: { fetched: 924600, inEffect: 930000, sourceNow: 950000 } });
    expect(last.recorded).toBeNull();
  });

  it("the correction carries the value it replaced: the fetched one first, then each earlier correction", async () => {
    const svc = service(fakeSource().fetcher);
    await svc.fetchMonths(CH, ["2026-03"], "manager", ADMIN);
    await appendCorrection(CH, { currency: "EUR", month: "2026-03", rateMicros: 930000, actor });
    await appendCorrection(CH, { currency: "EUR", month: "2026-03", rateMicros: 935000, actor });
    const rows = (await entries()).filter((e) => e.currency === "EUR");
    expect(rows.map((r) => [r.origin, r.rateMicros, r.replacesRateMicros])).toEqual([
      ["fetched", 924600, null],
      ["corrected", 930000, 924600],
      ["corrected", 935000, 930000],
    ]);
  });

  it("a correction made before any fetch replaces nothing, and the fetch that comes later does not displace it", async () => {
    await appendCorrection(CH, { currency: "EUR", month: "2026-03", rateMicros: 930000, actor });
    const svc = service(fakeSource().fetcher);
    await svc.fetchMonths(CH, ["2026-03"], "manager", ADMIN);
    const eur = (await entries()).filter((e) => e.currency === "EUR");
    // (a fetched row is stamped with the injected clock, a correction with the real one: compare without order)
    expect(eur.map((r) => [r.origin, r.replacesRateMicros]).sort()).toEqual([["corrected", null], ["fetched", null]]);
    expect(await svc.rateInEffect(CH, "EUR", "2026-03")).toMatchObject({ origin: "corrected", rateMicros: 930000 });
  });

  it("an unchanged source value is not a discrepancy", async () => {
    const svc = service(fakeSource().fetcher);
    await svc.fetchMonths(CH, ["2026-03"], "manager", ADMIN);
    clock = new Date(NOW.getTime() + FX_THROTTLE_MS + 1000);
    await svc.fetchMonths(CH, ["2026-03"], "manager", ADMIN);
    expect((await attempts()).at(-1)!.discrepancies).toBeNull();
    expect(await entries()).toHaveLength(3);
  });

  it("a fetched rate is never overwritten: a second insert is a no-op, and the database refuses a raw one", async () => {
    const input = { currency: "EUR" as const, rateMicros: 900000, month: "2026-03", sourceUrl: "u", sourceMonth: "2026-03", fetchedAt: NOW };
    expect(await insertFetchedRate(db, CH, input)).toBe(true);
    expect(await insertFetchedRate(db, CH, { ...input, rateMicros: 910000 })).toBe(false);
    const rows = await db.exchangeRateEntry.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.rateMicros).toBe(900000);
  });

  it("appendCorrection suppresses a no-op, orders its rows strictly, and keeps the whole history", async () => {
    const base = { currency: "USD" as const, month: "2026-03", actor };
    expect((await appendCorrection(CH, { ...base, rateMicros: 800000 })).kind).toBe("recorded");
    expect((await appendCorrection(CH, { ...base, rateMicros: 800000 })).kind).toBe("unchanged");
    expect((await appendCorrection(CH, { ...base, rateMicros: 810000 })).kind).toBe("recorded");
    expect((await appendCorrection(CH, { ...base, rateMicros: 800000 })).kind).toBe("recorded"); // back to an earlier value is a real change
    const rows = await db.exchangeRateEntry.findMany({ orderBy: { createdAt: "asc" } });
    expect(rows.map((r) => r.rateMicros)).toEqual([800000, 810000, 800000]);
    expect(rows.map((r) => r.replacesRateMicros)).toEqual([null, 800000, 810000]);
    expect(new Set(rows.map((r) => r.createdAt.getTime())).size).toBe(3);
    expect((await service(fakeSource().fetcher).rateInEffect(CH, "USD", "2026-03"))?.rateMicros).toBe(800000);
  });

  it("concurrent identical corrections write exactly one row", async () => {
    const results = await Promise.all(
      [1, 2, 3, 4].map(() => appendCorrection(CH, { currency: "GBP", month: "2026-03", rateMicros: 1_100_000, actor })),
    );
    expect(results.filter((r) => r.kind === "recorded")).toHaveLength(1);
    expect(await db.exchangeRateEntry.count()).toBe(1);
  });

  it("records the manager as the actor of a correction, with the entity", async () => {
    await appendCorrection(CH, { currency: "EUR", month: "2026-03", rateMicros: 930000, actor: { userId: "mgr-1", email: "m@welld.ch" } });
    expect(await db.exchangeRateEntry.findFirstOrThrow()).toMatchObject({
      entity: "welld_ch", origin: "corrected", createdByUserId: "mgr-1", createdByEmail: "m@welld.ch", sourceUrl: null, fetchedAt: null,
    });
  });
});

describe("failures change no rate (AC-2.8)", () => {
  const cases: [string, FxFetcher, string][] = [
    ["a thrown fetch", async () => { throw new Error("boom"); }, "network"],
    ["an HTTP 500", async () => new Response("x", { status: 500 }), "http_500"],
    ["a wrong <monat>", async () => new Response(xmlFor("2026-04")), "month_mismatch"],
    ["a missing currency", async () => new Response(xmlFor("2026-03").replace(/<devise code="gbp">[\s\S]*?<\/devise>/, "")), "currency_missing"],
    ["a DOCTYPE", async () => new Response(`<!DOCTYPE x [<!ENTITY a "b">]>${xmlFor("2026-03")}`), "parse"],
    ["a kurs of 0", async () => new Response(xmlFor("2026-03", "0")), "parse"],
  ];
  for (const [label, fetcher, code] of cases) {
    it(`${label}: no rate row, a failed attempt with code ${code}`, async () => {
      const res = await service(fetcher).fetchMonths(CH, ["2026-03"], "manager", ADMIN);
      expect(res.results[0]).toEqual({ month: "2026-03", outcome: "failed", errorCode: code, recorded: null });
      expect(await entries()).toHaveLength(0);
      const log = await attempts();
      expect(log).toHaveLength(1);
      expect(log[0]).toMatchObject({ entity: "welld_ch", outcome: "failed", errorCode: code, trigger: "manager" });
    });
  }

  it("a timeout is a failed attempt coded `timeout`, and a failure does not undo what an earlier success recorded", async () => {
    const svc = service(fakeSource().fetcher);
    await svc.fetchMonths(CH, ["2026-03"], "manager", ADMIN);
    clock = new Date(NOW.getTime() + FX_THROTTLE_MS + 1000);
    const res = await service(hangingFetcher, { callTimeoutMs: 20 }).fetchMonths(CH, ["2026-03"], "manager", ADMIN);
    expect(res.results[0]).toMatchObject({ outcome: "failed", errorCode: "timeout" });
    expect(await entries()).toHaveLength(3);
  });
});

describe("throttle and single-flight", () => {
  it("a month asked again within 15 minutes is throttled: no call, no row", async () => {
    const { fetcher, urls } = fakeSource();
    const svc = service(fetcher);
    await svc.fetchMonths(CH, ["2026-03"], "manager", ADMIN);
    clock = new Date(NOW.getTime() + FX_THROTTLE_MS - 1000);
    const res = await svc.fetchMonths(CH, ["2026-03"], "manager", ADMIN);
    expect(res.results[0]).toEqual({ month: "2026-03", outcome: "throttled", errorCode: null, recorded: null });
    expect(urls).toHaveLength(1);
    expect(await attempts()).toHaveLength(1);
    clock = new Date(NOW.getTime() + FX_THROTTLE_MS + 1000);
    expect((await svc.fetchMonths(CH, ["2026-03"], "manager", ADMIN)).results[0]!.outcome).toBe("ok");
    expect(urls).toHaveLength(2);
  });

  it("a FAILED attempt throttles too, whoever asks next", async () => {
    let calls = 0;
    const svc = service(async () => { calls++; return new Response("x", { status: 503 }); });
    await svc.fetchMonths(CH, ["2026-03"], "consumer", CONSUMER);
    const second = await svc.fetchMonths(CH, ["2026-03"], "manager", ADMIN);
    expect(second.results[0]!.outcome).toBe("throttled");
    expect(calls).toBe(1);
  });

  it("throttling is per month", async () => {
    const { fetcher, urls } = fakeSource();
    const svc = service(fetcher);
    await svc.fetchMonths(CH, ["2026-03"], "manager", ADMIN);
    const res = await svc.fetchMonths(CH, ["2026-03", "2026-04"], "manager", ADMIN);
    expect(res.results.map((r) => [r.month, r.outcome])).toEqual([["2026-04", "ok"], ["2026-03", "throttled"]]);
    expect(urls).toHaveLength(2);
  });

  it("concurrent calls for one month share one fetch and one result", async () => {
    let calls = 0;
    const svc = service(async (url) => {
      calls++;
      await new Promise((r) => setTimeout(r, 40));
      return new Response(xmlFor(`${/j=(\d{4})/.exec(url)![1]}-${/m=(\d{2})/.exec(url)![1]}`));
    });
    const [a, b, c] = await Promise.all([
      svc.fetchMonths(CH, ["2026-03"], "manager", ADMIN),
      svc.fetchMonths(CH, ["2026-03"], "manager", ADMIN),
      svc.consumerRates(CH, [{ currency: "EUR", month: "2026-03" }], CONSUMER),
    ]);
    expect(calls).toBe(1);
    expect(a.results).toEqual(b.results);
    expect(a.results[0]!.outcome).toBe("ok");
    expect(c[0]).toMatchObject({ status: "in_effect", rateMicros: 924600, attempted: true }); // it waited for the same fetch
    expect(await entries()).toHaveLength(3);
    expect(await attempts()).toHaveLength(1);
  });

  it("a caller that JOINS a slower fetch waits no longer than its own budget, and writes nothing itself", async () => {
    // The nesting rule: a consumer (6 s budget in production) never waits for a manager's fetch beyond its own budget.
    const { fetcher } = fakeSource(async (month) => {
      await new Promise((r) => setTimeout(r, 400));
      return new Response(xmlFor(month));
    });
    // One shared instance is what single flight is about, so the joiner is a second call on the SAME service.
    const shared = service(fetcher, { budgetMs: { consumer: 60 } });
    const started = shared.fetchMonths(CH, ["2026-03"], "manager", ADMIN);
    await new Promise((r) => setTimeout(r, 20));
    const t0 = Date.now();
    const joined = await shared.fetchMonths(CH, ["2026-03"], "consumer", CONSUMER);
    expect(Date.now() - t0).toBeLessThan(300);
    expect(joined.results).toEqual([{ month: "2026-03", outcome: "failed", errorCode: "timeout", recorded: null }]);
    const first = await started;
    expect(first.results[0]!.outcome).toBe("ok");
    const log = await attempts();
    expect(log).toHaveLength(1); // the manager's own; the joiner wrote none
    expect(log[0]).toMatchObject({ trigger: "manager", actorUserId: "admin-1", outcome: "ok" });
  });
});

describe("what may be asked", () => {
  it("never the current month, nor a future one: a not_fetchable attempt for a manager, no call", async () => {
    const { fetcher, urls } = fakeSource();
    const res = await service(fetcher).fetchMonths(CH, ["2026-11", "2026-12"], "manager", ADMIN);
    expect(res.results.map((r) => r.outcome)).toEqual(["not_fetchable", "not_fetchable"]);
    expect(urls).toHaveLength(0);
    expect((await attempts()).map((a) => [a.outcome, a.trigger])).toEqual([["not_fetchable", "manager"], ["not_fetchable", "manager"]]);
  });

  it("a consumer asking for such a month gets the outcome but writes NO row (G5)", async () => {
    const { fetcher, urls } = fakeSource();
    const res = await service(fetcher).fetchMonths(CH, ["2026-11", "2026-12"], "consumer", CONSUMER);
    expect(res.results.map((r) => r.outcome)).toEqual(["not_fetchable", "not_fetchable"]);
    expect(urls).toHaveLength(0);
    expect(await attempts()).toHaveLength(0);
  });

  it("not a month that has ended less than 5 days ago", async () => {
    clock = new Date("2026-11-04T10:00:00.000Z");
    const { fetcher } = fakeSource();
    expect((await service(fetcher).fetchMonths(CH, ["2026-10"], "manager", ADMIN)).results[0]!.outcome).toBe("not_fetchable");
  });

  it("ACCOUNTING_FX_SOURCE=off: a `disabled` attempt, and the fetcher is never called", async () => {
    const { fetcher, urls } = fakeSource();
    const svc = service(fetcher, { mode: "off" });
    const res = await svc.fetchMonths(CH, ["2026-03"], "manager", ADMIN);
    expect(res.results[0]).toEqual({ month: "2026-03", outcome: "disabled", errorCode: null, recorded: null });
    expect(urls).toHaveLength(0);
    expect((await attempts())[0]).toMatchObject({ outcome: "disabled", entity: "welld_ch" });
    expect(svc.enabled).toBe(false);
    expect(await svc.fetchDue(CH)).toBe(false);
  });

  it(`at most ${FX_MAX_MONTHS_PER_TRIGGER} months per call, newest first; the rest are deferred`, async () => {
    const { fetcher, urls } = fakeSource();
    const months = ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08"];
    const res = await service(fetcher).fetchMonths(CH, months, "manager", ADMIN);
    expect(res.results.map((r) => r.month)).toEqual(["2026-08", "2026-07", "2026-06", "2026-05", "2026-04", "2026-03"]);
    expect(res.deferred).toEqual(["2026-02", "2026-01"]);
    expect(urls).toHaveLength(6);
  });
});

describe("parallel under one budget (G6, R10)", () => {
  it("runs the months in parallel", async () => {
    const svc = service(async (url) => {
      await new Promise((r) => setTimeout(r, 100));
      return new Response(xmlFor(`${/j=(\d{4})/.exec(url)![1]}-${/m=(\d{2})/.exec(url)![1]}`));
    });
    const started = Date.now();
    const res = await svc.fetchMonths(CH, ["2026-03", "2026-04", "2026-05", "2026-06"], "manager", ADMIN);
    expect(res.results.every((r) => r.outcome === "ok")).toBe(true);
    expect(Date.now() - started).toBeLessThan(380);
  });

  it("the budget ends slow calls as failed/timeout while what already arrived is kept", async () => {
    const svc = service(
      (url, init) => {
        if (url.includes("m=03")) return Promise.resolve(new Response(xmlFor("2026-03")));
        return hangingFetcher(url, init);
      },
      { budgetMs: { manager: 80 }, callTimeoutMs: 5000 },
    );
    const started = Date.now();
    const res = await svc.fetchMonths(CH, ["2026-03", "2026-04", "2026-05"], "manager", ADMIN);
    expect(Date.now() - started).toBeLessThan(1500);
    expect(res.results.map((r) => [r.month, r.outcome, r.errorCode])).toEqual([
      ["2026-05", "failed", "timeout"],
      ["2026-04", "failed", "timeout"],
      ["2026-03", "ok", null],
    ]);
    expect((await entries()).every((e) => e.month.toISOString().startsWith("2026-03"))).toBe(true);
    expect((await attempts()).filter((a) => a.errorCode === "timeout")).toHaveLength(2);
  });

  it("the consumer has its own, shorter budget", async () => {
    const svc = service(hangingFetcher, { budgetMs: { manager: 5000, consumer: 60 }, callTimeoutMs: 5000 });
    const t0 = Date.now();
    const res = await svc.fetchMonths(CH, ["2026-03"], "consumer", CONSUMER);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(res.results[0]).toMatchObject({ outcome: "failed", errorCode: "timeout" });
    expect((await attempts())[0]).toMatchObject({ trigger: "consumer", actorUserId: "system:refund-api", outcome: "failed" });
  });
});

describe("the real budgets: 6 s for a consumer, 10 s for a manager (ADR 20261119-on-demand-outbound-work-..., R6)", () => {
  it(
    "a source that never answers: a consumer is told `missing` in under 7 s whatever the per-call timeout, a manager's fetch ends at 10 s",
    async () => {
      // Three real-time cases at once, on three different months and services, so that the suite waits for the longest only.
      const consumerBudget = service(hangingFetcher, { callTimeoutMs: 60_000 }); // only the budget can end it
      const consumerDefault = service(hangingFetcher); // the 5 s per-call timeout ends it first
      const manager = service(hangingFetcher, { callTimeoutMs: 60_000 });
      const timed = async <T>(run: () => Promise<T>) => {
        const t0 = Date.now();
        const value = await run();
        return { value, ms: Date.now() - t0 };
      };
      const [bound, perCall, mgr] = await Promise.all([
        timed(() => consumerBudget.consumerRates(CH, [{ currency: "EUR", month: "2026-03" }], CONSUMER)),
        timed(() => consumerDefault.consumerRates(CH, [{ currency: "USD", month: "2026-04" }], CONSUMER)),
        timed(() => manager.fetchMonths(CH, ["2026-05"], "manager", ADMIN)),
      ]);

      for (const run of [bound, perCall]) {
        expect(run.ms).toBeLessThan(7_000);
        expect(run.value).toHaveLength(1);
        expect(run.value[0]).toMatchObject({ status: "missing", reason: "fetch_failed", attempted: true });
      }
      expect(bound.ms).toBeGreaterThanOrEqual(CONSUMER_FETCH_BUDGET_MS - 100); // it is the budget that ended it
      expect(perCall.ms).toBeLessThan(CONSUMER_FETCH_BUDGET_MS); // the 5 s per-call timeout ended it first
      expect(mgr.value.results[0]).toMatchObject({ outcome: "failed", errorCode: "timeout" });
      expect(mgr.ms).toBeGreaterThanOrEqual(FX_FETCH_BUDGET_MS - 100);
      expect(mgr.ms).toBeLessThan(FX_FETCH_BUDGET_MS + 1_500);
      expect(await entries()).toHaveLength(0);
      expect((await attempts()).every((a) => a.outcome === "failed" && a.errorCode === "timeout")).toBe(true);
    },
    20_000,
  );
});

describe("what is due", () => {
  it("monthsNeedingFetch lists fetchable months from 2026-01 with a missing currency, newest first", async () => {
    const svc = service(fakeSource().fetcher);
    expect(await svc.monthsNeedingFetch(CH)).toEqual([
      "2026-10", "2026-09", "2026-08", "2026-07", "2026-06", "2026-05", "2026-04", "2026-03", "2026-02", "2026-01",
    ]);
    expect(await svc.fetchDue(CH)).toBe(true);
    await svc.fetchMonths(CH, ["2026-10", "2026-09", "2026-08", "2026-07", "2026-06", "2026-05"], "manager", ADMIN);
    // a month with one currency recorded still needs the other two
    await insertFetchedRate(db, CH, { currency: "EUR", rateMicros: 1, month: "2026-04", sourceUrl: "u", sourceMonth: "2026-04", fetchedAt: NOW });
    expect(await svc.monthsNeedingFetch(CH)).toEqual(["2026-04", "2026-03", "2026-02", "2026-01"]);
  });

  it("nothing is due for an entity with no source, nor when fetching is off", async () => {
    expect(await service(fakeSource().fetcher).monthsNeedingFetch(IT)).toEqual([]);
    expect(await service(fakeSource().fetcher).fetchDue(IT)).toBe(false);
    expect(await service(fakeSource().fetcher, { mode: "off" }).fetchDue(CH)).toBe(false);
  });
});

describe("consumerRates (AC-2.10, plan G10)", () => {
  const eur = (month: string) => ({ currency: "EUR" as const, month });

  it("answers a recorded pair in_effect with no call and no row, `attempted` false", async () => {
    const { fetcher, urls } = fakeSource();
    const svc = service(fetcher);
    await svc.fetchMonths(CH, ["2026-03"], "manager", ADMIN);
    urls.length = 0;
    const rows = await attempts();
    const answer = await svc.consumerRates(CH, [eur("2026-03"), { currency: "GBP", month: "2026-03" }], CONSUMER);
    expect(answer).toEqual([
      { currency: "EUR", month: "2026-03", status: "in_effect", rateMicros: 924600, origin: "fetched", attempted: false },
      { currency: "GBP", month: "2026-03", status: "in_effect", rateMicros: 1063500, origin: "fetched", attempted: false },
    ]);
    expect(urls).toHaveLength(0);
    expect(await attempts()).toHaveLength(rows.length);
  });

  it("fetches a published month with no rate, records it as the consumer, and answers it in_effect, attempted", async () => {
    const { fetcher, urls } = fakeSource();
    const answer = await service(fetcher).consumerRates(CH, [eur("2026-03"), { currency: "USD", month: "2026-03" }], CONSUMER);
    expect(answer).toEqual([
      { currency: "EUR", month: "2026-03", status: "in_effect", rateMicros: 924600, origin: "fetched", attempted: true },
      { currency: "USD", month: "2026-03", status: "in_effect", rateMicros: 780800, origin: "fetched", attempted: true },
    ]);
    expect(urls).toHaveLength(1);
    expect((await entries()).every((e) => e.entity === "welld_ch" && e.createdByUserId === "system:rates-fetch")).toBe(true);
    const log = await attempts();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ entity: "welld_ch", trigger: "consumer", actorUserId: "system:refund-api", outcome: "ok" });
  });

  it("answers `missing`/`fetch_failed` when the source fails, with `attempted` true and a failed attempt of the consumer", async () => {
    const { fetcher } = fakeSource(() => new Response("x", { status: 503 }));
    const answer = await service(fetcher).consumerRates(CH, [eur("2026-03")], CONSUMER);
    expect(answer).toEqual([{ currency: "EUR", month: "2026-03", status: "missing", attempted: true, reason: "fetch_failed" }]);
    expect(await entries()).toHaveLength(0);
    expect((await attempts())[0]).toMatchObject({ trigger: "consumer", outcome: "failed", errorCode: "http_503", actorUserId: "system:refund-api" });
  });

  it("answers a month not yet published `missing`/`not_published` with no outbound call and no row", async () => {
    const { fetcher, urls } = fakeSource();
    const answer = await service(fetcher).consumerRates(CH, [eur("2026-11"), eur("2026-12")], CONSUMER);
    expect(answer).toEqual([
      { currency: "EUR", month: "2026-11", status: "missing", attempted: false, reason: "not_published" },
      { currency: "EUR", month: "2026-12", status: "missing", attempted: false, reason: "not_published" },
    ]);
    expect(urls).toHaveLength(0);
    expect(await attempts()).toHaveLength(0);
  });

  it("a month that ended less than 5 days ago is not published yet (SA-2)", async () => {
    clock = new Date("2026-11-04T10:00:00.000Z");
    const { fetcher, urls } = fakeSource();
    const [answer] = await service(fetcher).consumerRates(CH, [eur("2026-10")], CONSUMER);
    expect(answer).toMatchObject({ status: "missing", reason: "not_published", attempted: false });
    expect(urls).toHaveLength(0);
    clock = new Date("2026-11-05T00:30:00.000+01:00");
    const [later] = await service(fetcher).consumerRates(CH, [eur("2026-10")], CONSUMER);
    expect(later).toMatchObject({ status: "in_effect", attempted: true });
  });

  it("a second call within 15 minutes after a failure is throttled: `fetch_failed`, not attempted, no call, no new row", async () => {
    let calls = 0;
    const svc = service(async () => { calls++; return new Response("x", { status: 500 }); });
    await svc.consumerRates(CH, [eur("2026-03")], CONSUMER);
    clock = new Date(NOW.getTime() + 60_000);
    const [second] = await svc.consumerRates(CH, [eur("2026-03")], CONSUMER);
    expect(second).toEqual({ currency: "EUR", month: "2026-03", status: "missing", attempted: false, reason: "fetch_failed" });
    expect(calls).toBe(1);
    expect(await attempts()).toHaveLength(1);
  });

  it("36 pairs over 12 months attempt at most 6 months, the newest, in parallel; each pair is answered once, in the asked order", async () => {
    const months = ["2025-09", "2025-10", "2025-11", "2025-12", "2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08"];
    const pairs = months.flatMap((month) => (["EUR", "USD", "GBP"] as const).map((currency) => ({ currency, month })));
    expect(pairs).toHaveLength(36);
    const { fetcher, urls } = fakeSource();
    const answer = await service(fetcher).consumerRates(CH, pairs, CONSUMER);
    expect(urls).toHaveLength(6);
    expect(new Set(urls.map((u) => /j=(\d{4}).*m=(\d{2})/.exec(u)!.slice(1, 3).join("-")))).toEqual(
      new Set(["2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08"]),
    );
    expect(answer.map((a) => `${a.currency}:${a.month}`)).toEqual(pairs.map((p) => `${p.currency}:${p.month}`));
    for (const a of answer) {
      if (a.month >= "2026-03") expect(a).toMatchObject({ status: "in_effect", attempted: true });
      else expect(a).toMatchObject({ status: "missing", reason: "fetch_failed", attempted: false }); // beyond the six: not asked
    }
    expect(await attempts()).toHaveLength(6);
  });

  it("a pair already corrected is answered as it is and the month is still fetched for the pair that is missing", async () => {
    const { fetcher, urls } = fakeSource();
    await appendCorrection(CH, { currency: "EUR", month: "2026-03", rateMicros: 930000, actor });
    const answer = await service(fetcher).consumerRates(CH, [eur("2026-03"), { currency: "USD", month: "2026-03" }], CONSUMER);
    expect(urls).toHaveLength(1);
    expect(answer).toEqual([
      { currency: "EUR", month: "2026-03", status: "in_effect", rateMicros: 930000, origin: "corrected", attempted: false },
      { currency: "USD", month: "2026-03", status: "in_effect", rateMicros: 780800, origin: "fetched", attempted: true },
    ]);
  });

  it("answers a corrected rate with `origin: corrected` and asks nothing when nothing is missing", async () => {
    const { fetcher, urls } = fakeSource();
    const svc = service(fetcher);
    await svc.fetchMonths(CH, ["2026-03"], "manager", ADMIN);
    await appendCorrection(CH, { currency: "EUR", month: "2026-03", rateMicros: 930000, actor });
    urls.length = 0;
    expect(await svc.consumerRates(CH, [eur("2026-03")], CONSUMER)).toEqual([
      { currency: "EUR", month: "2026-03", status: "in_effect", rateMicros: 930000, origin: "corrected", attempted: false },
    ]);
    expect(urls).toHaveLength(0);
  });

  it("an entity with no source answers every pair `missing`/`no_source`, asks nothing and writes nothing", async () => {
    const { fetcher, urls } = fakeSource();
    const answer = await service(fetcher).consumerRates(IT, [eur("2026-03"), { currency: "USD", month: "2026-03" }], CONSUMER);
    expect(answer).toEqual([
      { currency: "EUR", month: "2026-03", status: "missing", attempted: false, reason: "no_source" },
      { currency: "USD", month: "2026-03", status: "missing", attempted: false, reason: "no_source" },
    ]);
    expect(urls).toHaveLength(0);
    expect(await db.exchangeRateEntry.count()).toBe(0);
    expect(await db.exchangeRateFetchAttempt.count()).toBe(0);
  });

  it("with fetching off: `fetch_failed`, not attempted, no call, and a `disabled` row of the consumer", async () => {
    const { fetcher, urls } = fakeSource();
    const [answer] = await service(fetcher, { mode: "off" }).consumerRates(CH, [eur("2026-03")], CONSUMER);
    expect(answer).toEqual({ currency: "EUR", month: "2026-03", status: "missing", attempted: false, reason: "fetch_failed" });
    expect(urls).toHaveLength(0);
    expect((await attempts())[0]).toMatchObject({ trigger: "consumer", outcome: "disabled", entity: "welld_ch" });
  });

  it("a source that takes 30 s: `missing`/`fetch_failed` well inside the consumer's deadline", async () => {
    // Fast version of the real-time test above: the per-call timeout stands for the 5 s one, the budget for the 6 s one.
    const slow = service(
      (url, init) => hangingFetcher(url, init),
      { callTimeoutMs: 80, budgetMs: { consumer: 200 } },
    );
    const t0 = Date.now();
    const [answer] = await slow.consumerRates(CH, [eur("2026-03")], CONSUMER);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(answer).toMatchObject({ status: "missing", reason: "fetch_failed", attempted: true });
  });
});
