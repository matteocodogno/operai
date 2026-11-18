/**
 * The exchange-rate service against real Postgres with a FAKE source (T9,
 * specs/20261118-refund-accounting-export; AC-5.1, AC-5.4, AC-5.6, plan G6,
 * R10). No test touches the network.
 */

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { truncateRefundTables } from "../test-support/dbCleanup";
import type { FxFetcher } from "./bazgSource";

process.env["ALLOWED_ORIGINS"] = "http://localhost:5173";
process.env["AUTH_JWKS_URL"] = "http://localhost:3001/auth/jwks";
process.env["AUTH_ISSUER"] = "http://localhost:3001";
process.env["AUTH_BASE_URL"] = "http://localhost:3001";
process.env["AUTH_AUDIENCE"] = "operai-suite";
process.env["NODE_ENV"] = "test";
process.env["NOTIFY_INTERNAL_URL"] = "http://localhost:8081";
process.env["SERVICE_CLIENT_ID"] = "refund-api";
process.env["SERVICE_CLIENT_SECRET"] = "test-service-client-secret-at-least-32-characters";
process.env["REFUND_S3_ENDPOINT"] = "https://test.s3.railway-eu-amsterdam.example.com";
process.env["REFUND_S3_REGION"] = "auto";
process.env["REFUND_S3_EU_ENDPOINT_HOSTS"] = "s3.railway-eu-amsterdam.example.com";
process.env["REFUND_S3_BUCKET"] = "test-bucket";
process.env["REFUND_S3_ACCESS_KEY_ID"] = "test-key";
process.env["REFUND_S3_SECRET_ACCESS_KEY"] = "test-secret";
process.env["REFUND_APP_BASE_URL"] = "http://localhost:5173";

const { db } = await import("../lib/db");
const { createFxService, FX_MAX_MONTHS_PER_TRIGGER, FX_THROTTLE_MS } = await import("./fx.service");
const { appendCorrection, insertFetchedRate, monthToDate } = await import("./fx.repo");

const NOW = new Date("2026-11-19T10:00:00.000Z"); // October is the newest fetchable month
const ADMIN = { userId: "admin-1" };

const fixtureXml = readFileSync(new URL("./fixtures/bazg-xmlavgmonth-2026-03.xml", import.meta.url), "utf8");

function xmlFor(month: string, eur = "0.9246", usd = "0.7808", gbp = "1.0635"): string {
  return `<?xml version="1.0"?><monatsmittelkurs><monat>${month}</monat>
    <devise code="eur"><waehrung>1 EUR</waehrung><kurs>${eur}</kurs></devise>
    <devise code="usd"><waehrung>1 USD</waehrung><kurs>${usd}</kurs></devise>
    <devise code="gbp"><waehrung>1 GBP</waehrung><kurs>${gbp}</kurs></devise></monatsmittelkurs>`;
}

/** A fake source that answers each requested month from `answer`, and records the URLs it was asked. */
function fakeSource(answer: (month: string) => Response | Promise<Response> = (m) => new Response(xmlFor(m))) {
  const urls: string[] = [];
  const fetcher: FxFetcher = async (url, init) => {
    urls.push(url);
    const month = `${/j=(\d{4})/.exec(url)![1]}-${/m=(\d{2})/.exec(url)![1]}`;
    if (init.signal.aborted) throw new Error("aborted");
    return answer(month);
  };
  return { fetcher, urls };
}

let clock = NOW;
const service = (fetcher: FxFetcher, over: Partial<Parameters<typeof createFxService>[0]> = {}) =>
  createFxService({ mode: "bazg", fetcher, now: () => clock, ...over });

beforeEach(async () => {
  await truncateRefundTables();
  clock = NOW;
});
afterAll(async () => {
  await truncateRefundTables();
});

const entries = () => db.exchangeRateEntry.findMany({ orderBy: [{ createdAt: "asc" }, { currency: "asc" }] });
const attempts = () => db.exchangeRateFetchAttempt.findMany({ orderBy: [{ createdAt: "asc" }, { id: "asc" }] });

describe("fetchMonths: recording (AC-5.1)", () => {
  it("records EUR, USD and GBP with the source URL, the time and the system actor, and logs the attempt", async () => {
    const { fetcher, urls } = fakeSource();
    const res = await service(fetcher).fetchMonths(["2026-03"], "admin", ADMIN);
    expect(res.results).toEqual([
      { month: "2026-03", outcome: "ok", errorCode: null, recorded: { EUR: 924600, USD: 780800, GBP: 1063500 } },
    ]);
    expect(urls).toEqual(["https://www.backend-rates.bazg.admin.ch/api/xmlavgmonth?j=2026&m=03"]);
    const rows = await entries();
    expect(rows.map((r) => [r.currency, r.rateMicros, r.origin]).sort()).toEqual([
      ["EUR", 924600, "fetched"],
      ["GBP", 1063500, "fetched"],
      ["USD", 780800, "fetched"],
    ]);
    for (const row of rows) {
      expect(row).toMatchObject({
        sourceUrl: urls[0],
        sourceMonth: "2026-03",
        createdByUserId: "system:fx-fetch",
        createdByEmail: "system-fx-fetch@welld.ch",
      });
      expect(row.fetchedAt?.toISOString()).toBe(NOW.toISOString());
      expect(row.month.toISOString()).toBe("2026-03-01T00:00:00.000Z");
    }
    const log = await attempts();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ outcome: "ok", trigger: "admin", actorUserId: "admin-1", errorCode: null, discrepancies: null });
    expect(log[0]!.recorded).toEqual({ EUR: 924600, USD: 780800, GBP: 1063500 });
  });

  it("reads the real recorded 2026-03 answer", async () => {
    const { fetcher } = fakeSource(() => new Response(fixtureXml));
    const res = await service(fetcher).fetchMonths(["2026-03"], "admin", ADMIN);
    expect(res.results[0]!.recorded).toEqual({ EUR: 924600, USD: 780800, GBP: 1063500 });
  });

  it("rateInEffect is the fetched rate; unknown is null", async () => {
    const svc = service(fakeSource().fetcher);
    await svc.fetchMonths(["2026-03"], "admin", ADMIN);
    expect((await svc.rateInEffect("EUR", "2026-03"))?.rateMicros).toBe(924600);
    expect(await svc.rateInEffect("EUR", "2026-04")).toBeNull();
  });
});

describe("corrections and discrepancies (AC-5.3, AC-5.4)", () => {
  it("a correction wins over the fetched rate and over a LATER fetch, whose different value is logged only as a discrepancy", async () => {
    let value = "0.9246";
    const { fetcher } = fakeSource((m) => new Response(xmlFor(m, value)));
    const svc = service(fetcher);
    await svc.fetchMonths(["2026-03"], "admin", ADMIN);
    const outcome = await appendCorrection({ currency: "EUR", month: "2026-03", rateMicros: 930000, actor: { userId: "a", email: "a@welld.ch" } });
    expect(outcome.kind).toBe("recorded");
    expect((await svc.rateInEffect("EUR", "2026-03"))?.rateMicros).toBe(930000);

    clock = new Date(NOW.getTime() + FX_THROTTLE_MS + 1000);
    value = "0.9500";
    const again = await svc.fetchMonths(["2026-03"], "admin", ADMIN);
    expect(again.results[0]).toMatchObject({ outcome: "ok", recorded: {} });

    expect((await svc.rateInEffect("EUR", "2026-03"))?.rateMicros).toBe(930000);
    expect((await entries()).filter((e) => e.currency === "EUR")).toHaveLength(2); // fetched + corrected, nothing added
    const last = (await attempts()).at(-1)!;
    expect(last.discrepancies).toEqual({ EUR: { fetched: 924600, inEffect: 930000, sourceNow: 950000 } });
    expect(last.recorded).toBeNull();
  });

  it("an unchanged source value is not a discrepancy", async () => {
    const svc = service(fakeSource().fetcher);
    await svc.fetchMonths(["2026-03"], "admin", ADMIN);
    clock = new Date(NOW.getTime() + FX_THROTTLE_MS + 1000);
    await svc.fetchMonths(["2026-03"], "admin", ADMIN);
    expect((await attempts()).at(-1)!.discrepancies).toBeNull();
    expect(await entries()).toHaveLength(3);
  });

  it("a fetched rate is never overwritten: a second insert is a no-op", async () => {
    const input = { currency: "EUR" as const, rateMicros: 900000, month: "2026-03", sourceUrl: "u", sourceMonth: "2026-03", fetchedAt: NOW };
    expect(await insertFetchedRate(db, input)).toBe(true);
    expect(await insertFetchedRate(db, { ...input, rateMicros: 910000 })).toBe(false);
    const rows = await db.exchangeRateEntry.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.rateMicros).toBe(900000);
  });

  it("appendCorrection suppresses a no-op, orders its rows strictly, and keeps the whole history", async () => {
    const actor = { userId: "a", email: "a@welld.ch" };
    const base = { currency: "USD" as const, month: "2026-03", actor };
    expect((await appendCorrection({ ...base, rateMicros: 800000 })).kind).toBe("recorded");
    expect((await appendCorrection({ ...base, rateMicros: 800000 })).kind).toBe("unchanged");
    expect((await appendCorrection({ ...base, rateMicros: 810000 })).kind).toBe("recorded");
    expect((await appendCorrection({ ...base, rateMicros: 800000 })).kind).toBe("recorded"); // back to an earlier value is a real change
    const rows = await db.exchangeRateEntry.findMany({ orderBy: { createdAt: "asc" } });
    expect(rows.map((r) => r.rateMicros)).toEqual([800000, 810000, 800000]);
    expect(new Set(rows.map((r) => r.createdAt.getTime())).size).toBe(3);
    expect((await service(fakeSource().fetcher).rateInEffect("USD", "2026-03"))?.rateMicros).toBe(800000);
  });

  it("concurrent identical corrections write exactly one row", async () => {
    const actor = { userId: "a", email: "a@welld.ch" };
    const results = await Promise.all(
      [1, 2, 3, 4].map(() => appendCorrection({ currency: "GBP", month: "2026-03", rateMicros: 1_100_000, actor })),
    );
    expect(results.filter((r) => r.kind === "recorded")).toHaveLength(1);
    expect(await db.exchangeRateEntry.count()).toBe(1);
  });
});

describe("failures change no rate (AC-5.6)", () => {
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
      const res = await service(fetcher).fetchMonths(["2026-03"], "settings_view", ADMIN);
      expect(res.results[0]).toEqual({ month: "2026-03", outcome: "failed", errorCode: code, recorded: null });
      expect(await entries()).toHaveLength(0);
      const log = await attempts();
      expect(log).toHaveLength(1);
      expect(log[0]).toMatchObject({ outcome: "failed", errorCode: code, trigger: "settings_view" });
    });
  }

  it("a timeout is a failed attempt coded `timeout`, and a failure does not undo what an earlier success recorded", async () => {
    const svc = service(fakeSource().fetcher);
    await svc.fetchMonths(["2026-03"], "admin", ADMIN);
    clock = new Date(NOW.getTime() + FX_THROTTLE_MS + 1000);
    const hanging: FxFetcher = (_u, init) => new Promise((_r, rej) => init.signal.addEventListener("abort", () => rej(new Error("a"))));
    const res = await service(hanging, { callTimeoutMs: 20 }).fetchMonths(["2026-03"], "admin", ADMIN);
    expect(res.results[0]).toMatchObject({ outcome: "failed", errorCode: "timeout" });
    expect(await entries()).toHaveLength(3);
  });
});

describe("throttle and single-flight", () => {
  it("a month asked again within 15 minutes is throttled: no call, no row", async () => {
    const { fetcher, urls } = fakeSource();
    const svc = service(fetcher);
    await svc.fetchMonths(["2026-03"], "admin", ADMIN);
    clock = new Date(NOW.getTime() + FX_THROTTLE_MS - 1000);
    const res = await svc.fetchMonths(["2026-03"], "admin", ADMIN);
    expect(res.results[0]).toEqual({ month: "2026-03", outcome: "throttled", errorCode: null, recorded: null });
    expect(urls).toHaveLength(1);
    expect(await attempts()).toHaveLength(1);
    clock = new Date(NOW.getTime() + FX_THROTTLE_MS + 1000);
    expect((await svc.fetchMonths(["2026-03"], "admin", ADMIN)).results[0]!.outcome).toBe("ok");
    expect(urls).toHaveLength(2);
  });

  it("a FAILED attempt throttles too", async () => {
    let calls = 0;
    const svc = service(async () => { calls++; return new Response("x", { status: 503 }); });
    await svc.fetchMonths(["2026-03"], "admin", ADMIN);
    const second = await svc.fetchMonths(["2026-03"], "admin", ADMIN);
    expect(second.results[0]!.outcome).toBe("throttled");
    expect(calls).toBe(1);
  });

  it("throttling is per month", async () => {
    const { fetcher, urls } = fakeSource();
    const svc = service(fetcher);
    await svc.fetchMonths(["2026-03"], "admin", ADMIN);
    const res = await svc.fetchMonths(["2026-03", "2026-04"], "admin", ADMIN);
    expect(res.results.map((r) => [r.month, r.outcome])).toEqual([["2026-04", "ok"], ["2026-03", "throttled"]]);
    expect(urls).toHaveLength(2);
  });

  it("concurrent triggers for one month share one call and one result", async () => {
    let calls = 0;
    const svc = service(async (url) => {
      calls++;
      await new Promise((r) => setTimeout(r, 40));
      return new Response(xmlFor(`${/j=(\d{4})/.exec(url)![1]}-${/m=(\d{2})/.exec(url)![1]}`));
    });
    const [a, b, c] = await Promise.all([
      svc.fetchMonths(["2026-03"], "admin", ADMIN),
      svc.fetchMonths(["2026-03"], "export", ADMIN),
      svc.fetchMonths(["2026-03"], "settings_view", ADMIN),
    ]);
    expect(calls).toBe(1);
    expect(a.results).toEqual(b.results);
    expect(b.results).toEqual(c.results);
    expect(a.results[0]!.outcome).toBe("ok");
    expect(await entries()).toHaveLength(3);
    expect(await attempts()).toHaveLength(1);
  });
});

describe("what may be asked", () => {
  it("never the current month, nor a future one: a not_fetchable attempt, no call", async () => {
    const { fetcher, urls } = fakeSource();
    const res = await service(fetcher).fetchMonths(["2026-11", "2026-12"], "admin", ADMIN);
    expect(res.results.map((r) => r.outcome)).toEqual(["not_fetchable", "not_fetchable"]);
    expect(urls).toHaveLength(0);
    expect((await attempts()).map((a) => a.outcome)).toEqual(["not_fetchable", "not_fetchable"]);
  });

  it("not a month that has ended less than 5 days ago", async () => {
    clock = new Date("2026-11-04T10:00:00.000Z");
    const { fetcher } = fakeSource();
    expect((await service(fetcher).fetchMonths(["2026-10"], "admin", ADMIN)).results[0]!.outcome).toBe("not_fetchable");
  });

  it("REFUND_FX_SOURCE=off: a `disabled` attempt, and the fetcher is never called", async () => {
    const { fetcher, urls } = fakeSource();
    const svc = service(fetcher, { mode: "off" });
    const res = await svc.fetchMonths(["2026-03"], "admin", ADMIN);
    expect(res.results[0]).toEqual({ month: "2026-03", outcome: "disabled", errorCode: null, recorded: null });
    expect(urls).toHaveLength(0);
    expect((await attempts())[0]).toMatchObject({ outcome: "disabled" });
    expect(svc.enabled).toBe(false);
    expect(await svc.fetchDue()).toBe(false);
  });

  it(`at most ${FX_MAX_MONTHS_PER_TRIGGER} months per trigger, newest first; the rest are deferred`, async () => {
    const { fetcher, urls } = fakeSource();
    const months = ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08"];
    const res = await service(fetcher).fetchMonths(months, "admin", ADMIN);
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
    const res = await svc.fetchMonths(["2026-03", "2026-04", "2026-05", "2026-06"], "export", ADMIN);
    expect(res.results.every((r) => r.outcome === "ok")).toBe(true);
    expect(Date.now() - started).toBeLessThan(380);
  });

  it("the budget ends slow calls as failed/timeout while what already arrived is kept", async () => {
    const svc = service(
      (url, init) => {
        if (url.includes("m=03")) return Promise.resolve(new Response(xmlFor("2026-03")));
        return new Promise((_r, rej) => init.signal.addEventListener("abort", () => rej(new Error("a"))));
      },
      { budgetMs: 80, callTimeoutMs: 5000 },
    );
    const started = Date.now();
    const res = await svc.fetchMonths(["2026-03", "2026-04", "2026-05"], "export", ADMIN);
    expect(Date.now() - started).toBeLessThan(1500);
    expect(res.results.map((r) => [r.month, r.outcome, r.errorCode])).toEqual([
      ["2026-05", "failed", "timeout"],
      ["2026-04", "failed", "timeout"],
      ["2026-03", "ok", null],
    ]);
    expect((await entries()).every((e) => e.month.toISOString().startsWith("2026-03"))).toBe(true);
    expect((await attempts()).filter((a) => a.errorCode === "timeout")).toHaveLength(2);
  });
});

describe("what is due, and what the export needs", () => {
  it("monthsNeedingFetch lists fetchable months from 2026-01 with a missing currency, newest first", async () => {
    const svc = service(fakeSource().fetcher);
    expect(await svc.monthsNeedingFetch()).toEqual([
      "2026-10", "2026-09", "2026-08", "2026-07", "2026-06", "2026-05", "2026-04", "2026-03", "2026-02", "2026-01",
    ]);
    expect(await svc.fetchDue()).toBe(true);
    await svc.fetchMonths(["2026-10", "2026-09", "2026-08", "2026-07", "2026-06", "2026-05"], "admin", ADMIN);
    // a hand-typed correction counts as "having a rate" only together with the other two currencies
    await insertFetchedRate(db, { currency: "EUR", rateMicros: 1, month: "2026-04", sourceUrl: "u", sourceMonth: "2026-04", fetchedAt: NOW });
    expect(await svc.monthsNeedingFetch()).toEqual(["2026-04", "2026-03", "2026-02", "2026-01"]);
  });

  it("ensureRates fetches only the months a needed pair is missing from, and says whether the source was asked", async () => {
    const { fetcher, urls } = fakeSource();
    const svc = service(fetcher);
    await svc.fetchMonths(["2026-03"], "admin", ADMIN);
    const noCall = await svc.ensureRates([{ currency: "EUR", month: "2026-03" }], "export", ADMIN);
    expect(noCall).toEqual({ attempted: false, results: [] });
    expect(urls).toHaveLength(1);

    const res = await svc.ensureRates(
      [{ currency: "EUR", month: "2026-03" }, { currency: "USD", month: "2026-05" }, { currency: "GBP", month: "2026-05" }, { currency: "EUR", month: "2026-11" }],
      "export",
      ADMIN,
    );
    expect(res.attempted).toBe(true);
    expect(res.results.map((r) => r.month)).toEqual(["2026-05"]);
    expect(urls).toHaveLength(2);
    expect((await attempts()).at(-1)).toMatchObject({ trigger: "export", month: monthToDate("2026-05") });
  });

  it("ensureRates reports attempted:false when the source is off or the call is throttled", async () => {
    const off = service(fakeSource().fetcher, { mode: "off" });
    expect((await off.ensureRates([{ currency: "EUR", month: "2026-03" }], "export", ADMIN)).attempted).toBe(false);
    const failing = service(async () => new Response("x", { status: 500 }));
    expect((await failing.ensureRates([{ currency: "EUR", month: "2026-03" }], "export", ADMIN)).attempted).toBe(true);
    expect((await failing.ensureRates([{ currency: "EUR", month: "2026-03" }], "export", ADMIN)).attempted).toBe(false);
  });
});
