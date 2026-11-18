/**
 * Integration tests for the exchange-rate routes (T10, specs/20261118-refund-
 * accounting-export, plan § API contracts "Exchange rates").
 *
 * Real Postgres, jwt/authz mocked, the source FAKE (no network). AC coverage:
 * 5.2 (origin and history), 5.3 (a correction wins, history keeps the fetched
 * value), 5.4 (a later fetch never overrides a correction; no discrepancy field),
 * 5.5 (missing), 5.6 (a source failure is a 200 `failed`, lastFetch with `at`),
 * 5.7 (403 on PUT and POST), IS-6 (0 < rate < 1000).
 */

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import type { ResolveResponse } from "../authz/resolveClient";
import { setupTestAuth } from "../test-support/testAuth";
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

const harness = setupTestAuth();
await harness.init();

const { createFxRouter, formatRate, parseRateMicros } = await import("./fx.routes");
const { createFxService, FX_THROTTLE_MS } = await import("./fx.service");
const { db } = await import("../lib/db");
const { __resetAuthzCacheForTests } = await import("../auth/authz.middleware");

const NOW = new Date("2026-11-19T10:00:00.000Z");
let clock = NOW;

const grants = (...actions: ("read" | "manage")[]): ResolveResponse => ({
  sub: "",
  epoch: 1,
  permissions: actions.map((action) => ({ resource: "settings", action, conditions: null })),
  entity: null,
  jobTitle: null,
});
const NONE = grants();
const READ = grants("read");
const MANAGE = grants("manage");
const BOTH = grants("read", "manage");

let source: { eur: string; fail: "none" | "http" | "wrongMonth" | "throw" };
let calls: string[];
const fetcher: FxFetcher = async (url) => {
  calls.push(url);
  const month = `${/j=(\d{4})/.exec(url)![1]}-${/m=(\d{2})/.exec(url)![1]}`;
  if (source.fail === "throw") throw new Error("down");
  if (source.fail === "http") return new Response("no", { status: 503 });
  const echoed = source.fail === "wrongMonth" ? "2020-01" : month;
  return new Response(
    `<monatsmittelkurs><monat>${echoed}</monat>` +
      `<devise code="eur"><waehrung>1 EUR</waehrung><kurs>${source.eur}</kurs></devise>` +
      `<devise code="usd"><waehrung>1 USD</waehrung><kurs>0.7808</kurs></devise>` +
      `<devise code="gbp"><waehrung>1 GBP</waehrung><kurs>1.0635</kurs></devise></monatsmittelkurs>`,
  );
};

function makeRouter(mode: "bazg" | "off" = "bazg") {
  return createFxRouter(createFxService({ mode, fetcher, now: () => clock }), () => clock);
}
let router = makeRouter();

async function call(
  method: string,
  path: string,
  opts: { body?: unknown; rawBody?: string; as?: ResolveResponse; email?: string; token?: boolean } = {},
) {
  __resetAuthzCacheForTests();
  harness.setResolve(async () => opts.as ?? BOTH);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.token !== false) {
    headers["Authorization"] = `Bearer ${await harness.signToken({ sub: "admin-1", email: opts.email ?? "admin@welld.ch" })}`;
  }
  const res = await router.request(path, {
    method,
    headers,
    ...(opts.rawBody !== undefined ? { body: opts.rawBody } : opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  const text = await res.text();
  let body: Record<string, any> = {};
  try {
    body = text ? (JSON.parse(text) as Record<string, any>) : {};
  } catch {
    body = { text };
  }
  return { status: res.status, body, text };
}

const list = (qs = "", extra: Parameters<typeof call>[2] = {}) => call("GET", `/exchange-rates${qs}`, extra);
const fetchNow = (body?: unknown, extra: Parameters<typeof call>[2] = {}) =>
  call("POST", "/exchange-rates/fetch", body === undefined ? extra : { body, ...extra });
const correct = (month: string, currency: string, rate: string, extra: Parameters<typeof call>[2] = {}) =>
  call("PUT", `/exchange-rates/${month}/${currency}`, { body: { rate }, ...extra });
const row = (res: { body: Record<string, any> }, month: string) => (res.body["months"] as any[]).find((m) => m.month === month);

beforeEach(async () => {
  await truncateRefundTables();
  clock = NOW;
  source = { eur: "0.9246", fail: "none" };
  calls = [];
  router = makeRouter();
});
afterAll(async () => {
  await truncateRefundTables();
});

describe("formatting and parsing", () => {
  it("formats micros with at least four decimals", () => {
    expect(formatRate(924600)).toBe("0.9246");
    expect(formatRate(1063500)).toBe("1.0635");
    expect(formatRate(1000000)).toBe("1.0000");
    expect(formatRate(1234567)).toBe("1.234567");
    expect(formatRate(999999999)).toBe("999.999999");
  });

  it("parses exactly and refuses 0, 1000 and malformed text", () => {
    expect(parseRateMicros("0.9246")).toBe(924600);
    expect(parseRateMicros("999.999999")).toBe(999999999);
    expect(parseRateMicros("1")).toBe(1000000);
    expect(parseRateMicros("0.000001")).toBe(1);
    for (const bad of ["0", "0.0", "0.000000", "1000", "1000.0", "-1", "1e2", ".5", "0.1234567", "", "1,5"]) {
      expect(parseRateMicros(bad)).toBeNull();
    }
  });
});

describe("GET /exchange-rates (AC-5.2, AC-5.5)", () => {
  it("lists every completed month from 2026-01, newest first, all missing before any fetch", async () => {
    const res = await list();
    expect(res.status).toBe(200);
    expect((res.body["months"] as any[]).map((m) => m.month)).toEqual([
      "2026-10", "2026-09", "2026-08", "2026-07", "2026-06", "2026-05", "2026-04", "2026-03", "2026-02", "2026-01",
    ]);
    for (const m of res.body["months"] as any[]) expect(m.rates).toEqual({ EUR: { status: "missing" }, USD: { status: "missing" }, GBP: { status: "missing" } });
    expect(res.body["lastFetch"]).toBeNull();
    expect(res.body["fetchDue"]).toBe(true);
  });

  it("shows origin, rate, time and source for a fetched month", async () => {
    await fetchNow({ months: ["2026-03"] });
    const m = row(await list(), "2026-03");
    expect(m.rates.EUR).toMatchObject({
      status: "fetched",
      rateMicros: 924600,
      rate: "0.9246",
      sourceUrl: "https://www.backend-rates.bazg.admin.ch/api/xmlavgmonth?j=2026&m=03",
      fetchedAt: NOW.toISOString(),
    });
    expect(m.rates.EUR.history).toEqual([{ origin: "fetched", rate: "0.9246", at: NOW.toISOString(), byEmail: "system-fx-fetch@welld.ch" }]);
    expect(m.rates.USD).toMatchObject({ status: "fetched", rate: "0.7808" });
    expect(m.rates.GBP).toMatchObject({ status: "fetched", rate: "1.0635" });
    expect(row(await list(), "2026-04").rates.EUR).toEqual({ status: "missing" });
  });

  it("adds an earlier completed month that a foreign-currency WellD CH line needs, and no other line", async () => {
    const mk = async (over: Record<string, unknown>, status: "approved" | "paid" | "submitted" = "approved") => {
      const r = await db.refundRequest.create({ data: { ownerUserId: "o", ownerEmail: "o@x.ch", status } });
      await db.refundLine.create({
        data: {
          requestId: r.id, date: new Date("2025-11-12"), type: "travel_train", motivo: "m", entity: "welld_ch",
          currency: "EUR", requestedAmountCents: 100, ...over,
        } as any,
      });
    };
    await mk({ date: new Date("2025-12-12") });
    await mk({ date: new Date("2025-09-12"), currency: "CHF" });
    await mk({ date: new Date("2025-08-12"), entity: "welld_it" });
    await mk({ date: new Date("2025-07-12") }, "submitted");
    await mk({ date: new Date("2025-06-12"), rejectionReason: "no", rejectedAt: new Date(), rejectedByUserId: "a", rejectedByEmail: "a@x" });
    await mk({ date: new Date("2026-11-05") }); // the current month is never listed
    const months = ((await list()).body["months"] as any[]).map((m) => m.month);
    expect(months).toContain("2025-12");
    for (const absent of ["2025-09", "2025-08", "2025-07", "2025-06", "2026-11"]) expect(months).not.toContain(absent);
    expect(months.indexOf("2025-12")).toBe(months.length - 1);
  });

  it("from and to narrow the window", async () => {
    const res = await list("?from=2026-03&to=2026-05");
    expect((res.body["months"] as any[]).map((m) => m.month)).toEqual(["2026-05", "2026-04", "2026-03"]);
    expect((await list("?from=2026-3")).status).toBe(422);
    expect((await list("?to=oops")).status).toBe(422);
  });

  it("fetchDue is false when the source is off", async () => {
    router = makeRouter("off");
    expect((await list()).body["fetchDue"]).toBe(false);
  });
});

describe("POST /exchange-rates/fetch (AC-5.1, AC-5.6)", () => {
  it("fetches the months asked and reports one attempt each, with what was recorded", async () => {
    const res = await fetchNow({ months: ["2026-03", "2026-04"] });
    expect(res.status).toBe(200);
    expect(res.body["attempts"]).toEqual([
      { month: "2026-04", outcome: "ok", errorCode: null, recorded: { EUR: 924600, USD: 780800, GBP: 1063500 } },
      { month: "2026-03", outcome: "ok", errorCode: null, recorded: { EUR: 924600, USD: 780800, GBP: 1063500 } },
    ]);
    expect(res.body["deferredMonths"]).toEqual([]);
    expect(res.body["lastFetch"]).toMatchObject({ outcome: "ok", errorCode: null });
    expect(await db.exchangeRateEntry.count()).toBe(6);
  });

  it("with no body (or an empty one) fetches the newest six months missing a rate and defers the rest", async () => {
    const res = await fetchNow();
    expect(res.status).toBe(200);
    expect((res.body["attempts"] as any[]).map((a) => a.month)).toEqual(["2026-10", "2026-09", "2026-08", "2026-07", "2026-06", "2026-05"]);
    expect(res.body["deferredMonths"]).toEqual(["2026-04", "2026-03", "2026-02", "2026-01"]);
    clock = new Date(NOW.getTime() + FX_THROTTLE_MS + 1000);
    const next = await fetchNow(undefined, { rawBody: "" });
    expect((next.body["attempts"] as any[]).map((a) => a.month)).toEqual(["2026-04", "2026-03", "2026-02", "2026-01"]);
    expect((await list()).body["fetchDue"]).toBe(false);
  });

  it("records who asked in the attempt log: admin by default, settings_view when the view says so", async () => {
    await fetchNow({ months: ["2026-03"] });
    clock = new Date(NOW.getTime() + FX_THROTTLE_MS + 1000);
    await fetchNow({ months: ["2026-03"], trigger: "settings_view" });
    const log = await db.exchangeRateFetchAttempt.findMany({ orderBy: { createdAt: "asc" } });
    expect(log.map((l) => [l.trigger, l.actorUserId])).toEqual([["admin", "admin-1"], ["settings_view", "admin-1"]]);
  });

  it("(AC-5.6) a source failure is a 200 `failed`: no rate changes, and lastFetch says what and when", async () => {
    for (const [fail, code] of [["http", "http_503"], ["throw", "network"], ["wrongMonth", "month_mismatch"]] as const) {
      await truncateRefundTables();
      clock = NOW;
      router = makeRouter();
      source.fail = fail;
      const res = await fetchNow({ months: ["2026-03"] });
      expect(res.status).toBe(200);
      expect(res.body["attempts"]).toEqual([{ month: "2026-03", outcome: "failed", errorCode: code, recorded: null }]);
      expect(res.body["lastFetch"]).toEqual({ at: NOW.toISOString(), outcome: "failed", errorCode: code, month: "2026-03" });
      expect(await db.exchangeRateEntry.count()).toBe(0);
      expect((await list()).body["lastFetch"]).toMatchObject({ outcome: "failed", errorCode: code });
    }
  });

  it("(AC-5.6) the failure stays the last fetch until a later fetch succeeds", async () => {
    source.fail = "http";
    await fetchNow({ months: ["2026-03"] });
    expect((await list()).body["lastFetch"].outcome).toBe("failed");
    clock = new Date(NOW.getTime() + FX_THROTTLE_MS + 1000);
    source.fail = "none";
    await fetchNow({ months: ["2026-03"] });
    expect((await list()).body["lastFetch"]).toMatchObject({ outcome: "ok", errorCode: null });
  });

  it("a month that is not fetchable yet is reported as such, with no call to the source", async () => {
    const res = await fetchNow({ months: ["2026-11"] });
    expect(res.body["attempts"]).toEqual([{ month: "2026-11", outcome: "not_fetchable", errorCode: null, recorded: null }]);
    expect(calls).toHaveLength(0);
  });

  it("an immediate second request is throttled and writes nothing", async () => {
    await fetchNow({ months: ["2026-03"] });
    const again = await fetchNow({ months: ["2026-03"] });
    expect(again.body["attempts"]).toEqual([{ month: "2026-03", outcome: "throttled", errorCode: null, recorded: null }]);
    expect(calls).toHaveLength(1);
  });

  it("with the source off every attempt is `disabled`", async () => {
    router = makeRouter("off");
    const res = await fetchNow({ months: ["2026-03"] });
    expect(res.body["attempts"]).toEqual([{ month: "2026-03", outcome: "disabled", errorCode: null, recorded: null }]);
    expect(calls).toHaveLength(0);
  });

  it("refuses a malformed body with 422 and asks the source for nothing", async () => {
    for (const body of [{ months: ["2026-3"] }, { months: "2026-03" }, { trigger: "export" }, { months: Array(25).fill("2026-03") }]) {
      expect((await fetchNow(body)).status).toBe(422);
    }
    expect((await fetchNow(undefined, { rawBody: "{nope" })).status).toBe(422);
    expect(calls).toHaveLength(0);
  });
});

describe("PUT /exchange-rates/{month}/{currency} (AC-5.3, AC-5.4, IS-6)", () => {
  it("(AC-5.3) a correction is in effect at once, carries who and when, and leaves the fetched value in the history", async () => {
    await fetchNow({ months: ["2026-03"] });
    const res = await correct("2026-03", "EUR", "0.93", { email: "carla@welld.ch" });
    expect(res.status).toBe(200);
    expect(res.body["month"]).toBe("2026-03");
    expect(res.body["rates"].EUR).toMatchObject({ status: "corrected", rateMicros: 930000, rate: "0.9300", correctedByEmail: "carla@welld.ch" });
    expect(res.body["rates"].EUR.history.map((h: any) => [h.origin, h.rate, h.byEmail])).toEqual([
      ["fetched", "0.9246", "system-fx-fetch@welld.ch"],
      ["corrected", "0.9300", "carla@welld.ch"],
    ]);
    expect(res.body["rates"].USD.status).toBe("fetched");
    expect(row(await list(), "2026-03").rates.EUR.rate).toBe("0.9300");
    const entry = await db.exchangeRateEntry.findFirstOrThrow({ where: { origin: "corrected" } });
    expect(entry.createdByUserId).toBe("admin-1");
  });

  it("(AC-5.5) a month with no row can be filled by hand, and then reads as corrected", async () => {
    const res = await correct("2026-02", "GBP", "1.1");
    expect(res.status).toBe(200);
    expect(res.body["rates"].GBP).toMatchObject({ status: "corrected", rate: "1.1000" });
    expect(res.body["rates"].EUR).toEqual({ status: "missing" });
  });

  it("(AC-5.4) a later fetch with another value never replaces a correction, and no response says anything about a discrepancy", async () => {
    await fetchNow({ months: ["2026-03"] });
    await correct("2026-03", "EUR", "0.93");
    clock = new Date(NOW.getTime() + FX_THROTTLE_MS + 1000);
    source.eur = "0.9500";
    const fetched = await fetchNow({ months: ["2026-03"] });
    expect(fetched.body["attempts"][0]).toEqual({ month: "2026-03", outcome: "ok", errorCode: null, recorded: {} });
    const m = row(await list(), "2026-03");
    expect(m.rates.EUR).toMatchObject({ status: "corrected", rateMicros: 930000 });
    expect(JSON.stringify([fetched.body, await list()])).not.toMatch(/discrepan|sourceNow/i);
    const last = (await db.exchangeRateFetchAttempt.findMany({ orderBy: { createdAt: "asc" } })).at(-1)!;
    expect(last.discrepancies).toEqual({ EUR: { fetched: 924600, inEffect: 930000, sourceNow: 950000 } });
  });

  it("suppresses a no-op: a rate equal to the one in effect writes no row", async () => {
    await fetchNow({ months: ["2026-03"] });
    const same = await correct("2026-03", "EUR", "0.9246");
    expect(same.status).toBe(200);
    expect(same.body["rates"].EUR.status).toBe("fetched");
    expect(await db.exchangeRateEntry.count({ where: { origin: "corrected" } })).toBe(0);
    await correct("2026-03", "EUR", "0.95");
    await correct("2026-03", "EUR", "0.950000");
    expect(await db.exchangeRateEntry.count({ where: { origin: "corrected" } })).toBe(1);
  });

  it("(IS-6) accepts 999.999999 and refuses 1000, 0 and anything malformed with 422 invalid_rate", async () => {
    const top = await correct("2026-03", "EUR", "999.999999");
    expect(top.status).toBe(200);
    expect(top.body["rates"].EUR.rateMicros).toBe(999999999);
    expect(top.body["rates"].EUR.rate).toBe("999.999999");
    const low = await correct("2026-03", "USD", "0.000001");
    expect(low.body["rates"].USD.rateMicros).toBe(1);
    const before = await db.exchangeRateEntry.count();
    for (const bad of ["1000", "1000.000000", "0", "0.000000", "-1", "1e2", ".5", "0.1234567", "", "abc", "99999", "1,5", " "]) {
      const res = await correct("2026-04", "EUR", bad);
      expect(res.status).toBe(422);
      expect(res.body["code"]).toBe("invalid_rate");
    }
    expect((await call("PUT", "/exchange-rates/2026-04/EUR", { body: { rate: 1.5 } })).body["code"]).toBe("invalid_rate");
    expect((await call("PUT", "/exchange-rates/2026-04/EUR", { body: {} })).body["code"]).toBe("invalid_rate");
    expect(await db.exchangeRateEntry.count()).toBe(before);
  });

  it("422 currency_not_convertible for CHF, 404 for a currency with no rate", async () => {
    const chf = await correct("2026-03", "CHF", "1");
    expect(chf.status).toBe(422);
    expect(chf.body["code"]).toBe("currency_not_convertible");
    expect((await correct("2026-03", "chf", "1")).body["code"]).toBe("currency_not_convertible");
    expect((await correct("2026-03", "JPY", "1")).status).toBe(404);
    expect(await db.exchangeRateEntry.count()).toBe(0);
  });

  it("422 month_not_completed for the current and for a future month; 422 invalid_month for a malformed one", async () => {
    for (const month of ["2026-11", "2026-12", "2027-03"]) {
      const res = await correct(month, "EUR", "0.9");
      expect(res.status).toBe(422);
      expect(res.body["code"]).toBe("month_not_completed");
    }
    expect((await correct("2026-10", "EUR", "0.9")).status).toBe(200); // the last completed month needs no grace days to be CORRECTED
    for (const month of ["2026-3", "2026-13", "march"]) {
      expect((await correct(month, "EUR", "0.9")).body["code"]).toBe("invalid_month");
    }
  });

  it("takes the actor from the JWT, never from the body", async () => {
    await call("PUT", "/exchange-rates/2026-03/EUR", { body: { rate: "0.9", createdByEmail: "evil@x.ch" }, email: "real@welld.ch" });
    expect((await db.exchangeRateEntry.findFirstOrThrow()).createdByEmail).toBe("real@welld.ch");
  });
});

describe("(AC-5.7) capability gates", () => {
  it("no token is 401", async () => {
    expect((await list("", { token: false })).status).toBe(401);
    expect((await fetchNow({}, { token: false })).status).toBe(401);
    expect((await correct("2026-03", "EUR", "0.9", { token: false })).status).toBe(401);
  });

  it("GET needs settings:read; manage alone is not enough", async () => {
    for (const as of [NONE, MANAGE]) expect((await list("", { as })).status).toBe(403);
    expect((await list("", { as: READ })).status).toBe(200);
  });

  it("PUT and POST need settings:manage, checked before the body, and a read grant is not enough", async () => {
    for (const as of [NONE, READ]) {
      expect((await correct("2026-03", "EUR", "0.9", { as })).status).toBe(403);
      expect((await call("PUT", "/exchange-rates/2026-03/EUR", { as, body: {} })).status).toBe(403);
      expect((await fetchNow({}, { as })).status).toBe(403);
      expect((await fetchNow({ months: "nope" }, { as })).status).toBe(403);
    }
    expect(calls).toHaveLength(0);
    expect(await db.exchangeRateEntry.count()).toBe(0);
    expect(await db.exchangeRateFetchAttempt.count()).toBe(0);
  });

  it("PUT on the month list and DELETE anywhere are 404 (no such route)", async () => {
    expect((await call("DELETE", "/exchange-rates/2026-03/EUR")).status).toBe(404);
    expect((await call("PUT", "/exchange-rates/2026-03", { body: { rate: "1" } })).status).toBe(404);
  });
});
