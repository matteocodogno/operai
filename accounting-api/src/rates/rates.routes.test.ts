/**
 * Integration tests of the exchange-rate user routes (T12, specs/20261119-accounting; moved from refund-api's
 * fx.routes.test.ts and adapted: per entity, entity coverage instead of `settings:*`, the G5 fetch shape, the minimal
 * projection of D18). Real Postgres (the `accounting` database), `jwt` and `auth GET /authz/resolve` through the shared
 * harness, the source a FAKE (no network).
 *
 * AC coverage: 2.3 (window, newest first, origin, an earlier month once it has an entry or an attempt), 2.4 (a correction
 * is in effect, the fetched row stays, who and `replacesRateMicros`), 2.5 (0, -1, 1000, 1.1234567 refused; 999.999999
 * accepted; the current month; the own currency; nothing recorded), 2.6 (a later fetch never replaces a correction),
 * 2.7 (missing, with neighbours present), 2.8 (a failure is a 200 `failed`, visible to a reader), 2.9 (the fetch shape of
 * G5 with `recorded`, `deferredMonths` and the five outcomes; a reader is 403 with no attempt row), 2.11 (WellD Italia:
 * `source: null`, fetch 422 `no_rate_source`, a WellD CH write changes none of its rows), 3.4 (a reader writes nothing),
 * 3.5 (an uncovered entity is not found), 3.6 (no grant, no data).
 */

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { fakeSource, xmlFor } from "../test-support/fakeSource";
import { fakeResolve, PERSONAS, type Persona } from "../test-support/fakeResolve";
import { truncateAccountingTables } from "../test-support/dbCleanup";
import { setupTestAuth } from "../test-support/testAuth";

const harness = setupTestAuth();
await harness.init();

const { OpenAPIHono } = await import("@hono/zod-openapi");
const { createRatesRouter, formatRate, parseRateMicros } = await import("./rates.routes");
const { createRatesService, FX_THROTTLE_MS } = await import("./rates.service");
const { ListRatesResponseSchema, FetchRatesResponseSchema, MonthRowSchema } = await import("./rates.schemas");
const { insertFetchedRate, monthToDate } = await import("./rates.repo");
const { handleProblemError, problem, validationHook } = await import("../lib/problem");
const { db } = await import("../lib/db");
const { __resetAuthzCacheForTests } = await import("../authz/authz.middleware");

const NOW = new Date("2026-11-19T10:00:00.000Z"); // October is the newest completed (and fetchable) month
let clock = NOW;

let state: { eur: string; fail: "none" | "http" | "wrongMonth" | "throw" };
let source = fakeSource();
const answer = (month: string): Response => {
  if (state.fail === "throw") throw new Error("down");
  if (state.fail === "http") return new Response("no", { status: 503 });
  const echoed = state.fail === "wrongMonth" ? "2020-01" : month;
  return new Response(xmlFor(echoed, state.eur));
};

/** The router under test inside an app with the same error rendering as `index.ts` (the gates throw `ProblemError`). */
function makeApp(mode: "bazg" | "off" = "bazg") {
  const app = new OpenAPIHono({ defaultHook: validationHook });
  app.route("/", createRatesRouter(createRatesService({ mode, fetcher: source.fetcher, now: () => clock }), () => clock));
  app.onError((err, c) => handleProblemError(err, c.req.path) ?? problem({ status: 500, detail: "unexpected" }, c.req.path));
  app.notFound((c) => problem({ status: 404, detail: "no route" }, c.req.path));
  return app;
}
let app = makeApp();

interface CallOptions {
  readonly body?: unknown;
  readonly raw?: string;
  readonly as?: Persona;
  readonly email?: string;
  readonly token?: boolean;
}

async function call(method: string, path: string, opts: CallOptions = {}) {
  __resetAuthzCacheForTests();
  const as = opts.as ?? PERSONAS.accountingCh;
  harness.setResolve(fakeResolve(as));
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.token !== false) {
    headers["Authorization"] = `Bearer ${await harness.signToken({ sub: as.sub, email: opts.email ?? `${as.sub}@welld.ch` })}`;
  }
  const res = await app.request(path, {
    method,
    headers,
    ...(opts.raw !== undefined ? { body: opts.raw } : opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
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

const RATES = (entity = "welld_ch") => `/v1/entities/${entity}/exchange-rates`;
const list = (qs = "", opts: CallOptions & { entity?: string } = {}) => call("GET", `${RATES(opts.entity)}${qs}`, opts);
const fetchNow = (body?: unknown, opts: CallOptions & { entity?: string } = {}) =>
  call("POST", `${RATES(opts.entity)}/fetch`, body === undefined ? opts : { ...opts, body });
const correct = (month: string, currency: string, rate: string, opts: CallOptions & { entity?: string } = {}) =>
  call("PUT", `${RATES(opts.entity)}/${month}/${currency}`, { ...opts, body: { rate } });
const row = (res: { body: Record<string, any> }, month: string) => (res.body["months"] as any[]).find((m) => m.month === month);
const afterThrottle = () => {
  clock = new Date(clock.getTime() + FX_THROTTLE_MS + 1000);
};

const counts = async (entity: "welld_ch" | "welld_it") => ({
  entries: await db.exchangeRateEntry.count({ where: { entity } }),
  attempts: await db.exchangeRateFetchAttempt.count({ where: { entity } }),
});

beforeEach(async () => {
  await truncateAccountingTables();
  __resetAuthzCacheForTests();
  clock = NOW;
  state = { eur: "0.9246", fail: "none" };
  source = fakeSource(answer);
  app = makeApp();
});
afterAll(async () => {
  await truncateAccountingTables();
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

describe("GET /v1/entities/{entity}/exchange-rates (AC-2.3, AC-2.7, AC-2.8, AC-2.11)", () => {
  it("lists every completed month from 2026-01, newest first, all missing before any fetch", async () => {
    const res = await list();
    expect(res.status).toBe(200);
    expect(ListRatesResponseSchema.safeParse(res.body).success).toBe(true);
    expect(res.body).toMatchObject({ entity: "welld_ch", ownCurrency: "CHF", currencies: ["EUR", "USD", "GBP"], source: { name: "bazg" } });
    expect((res.body["months"] as any[]).map((m) => m.month)).toEqual([
      "2026-10", "2026-09", "2026-08", "2026-07", "2026-06", "2026-05", "2026-04", "2026-03", "2026-02", "2026-01",
    ]);
    for (const m of res.body["months"] as any[]) {
      expect(m.rates).toEqual({ EUR: { status: "missing" }, USD: { status: "missing" }, GBP: { status: "missing" } });
    }
    expect(res.body["lastFetch"]).toBeNull();
    expect(res.body["fetchDue"]).toBe(true);
  });

  it("shows the origin and the rate of a fetched month and nothing else about it (D18, G13)", async () => {
    await fetchNow({ months: ["2026-03"] });
    const m = row(await list(), "2026-03");
    expect(m.rates.EUR).toEqual({ status: "fetched", rateMicros: 924600, rate: "0.9246" });
    expect(m.rates.USD).toEqual({ status: "fetched", rateMicros: 780800, rate: "0.7808" });
    expect(m.rates.GBP).toEqual({ status: "fetched", rateMicros: 1063500, rate: "1.0635" });
    expect(row(await list(), "2026-04").rates.EUR).toEqual({ status: "missing" });
  });

  it("(AC-2.7) a month and currency with no row is missing even when its neighbours have rates", async () => {
    for (const month of ["2026-02", "2026-04"]) {
      await insertFetchedRate(db, "welld_ch", {
        currency: "EUR", month, rateMicros: 920000, sourceUrl: "https://example.test/x", sourceMonth: month, fetchedAt: NOW,
      });
    }
    const res = await list();
    expect(row(res, "2026-03").rates).toEqual({ EUR: { status: "missing" }, USD: { status: "missing" }, GBP: { status: "missing" } });
    expect(row(res, "2026-02").rates.EUR.status).toBe("fetched");
    expect(row(res, "2026-04").rates).toEqual({
      EUR: { status: "fetched", rateMicros: 920000, rate: "0.9200" },
      USD: { status: "missing" },
      GBP: { status: "missing" },
    });
  });

  it("(AC-2.3) lists an earlier month once it has an entry or an attempt, and no month that is not completed or belongs to another entity", async () => {
    await insertFetchedRate(db, "welld_ch", {
      currency: "EUR", month: "2025-12", rateMicros: 950000, sourceUrl: "https://example.test/x", sourceMonth: "2025-12", fetchedAt: NOW,
    });
    await db.exchangeRateFetchAttempt.create({
      data: { entity: "welld_ch", month: monthToDate("2025-06"), trigger: "consumer", outcome: "failed", errorCode: "timeout", actorUserId: "system:refund-api", createdAt: NOW },
    });
    await db.exchangeRateFetchAttempt.create({
      data: { entity: "welld_ch", month: monthToDate("2026-11"), trigger: "manager", outcome: "not_fetchable", actorUserId: "u", createdAt: NOW },
    });
    await insertFetchedRate(db, "welld_it", {
      currency: "USD", month: "2025-03", rateMicros: 900000, sourceUrl: "https://example.test/x", sourceMonth: "2025-03", fetchedAt: NOW,
    });
    const months = ((await list()).body["months"] as any[]).map((m) => m.month);
    expect(months.slice(-3)).toEqual(["2026-01", "2025-12", "2025-06"]);
    for (const absent of ["2026-11", "2025-03"]) expect(months).not.toContain(absent);
    expect(row(await list(), "2025-12").rates.EUR).toMatchObject({ status: "fetched", rate: "0.9500" });
  });

  it("from and to narrow the window", async () => {
    const res = await list("?from=2026-03&to=2026-05");
    expect((res.body["months"] as any[]).map((m) => m.month)).toEqual(["2026-05", "2026-04", "2026-03"]);
    expect((await list("?from=2026-3")).status).toBe(422);
    expect((await list("?to=oops")).status).toBe(422);
    expect((await list("?from=1999-12")).status).toBe(422);
  });

  it("fetchDue is false when the source is off, and true again only while a fetchable month lacks a rate", async () => {
    app = makeApp("off");
    expect((await list()).body["fetchDue"]).toBe(false);
    app = makeApp();
    await fetchNow({});
    afterThrottle();
    await fetchNow({});
    expect((await list()).body["fetchDue"]).toBe(false);
  });

  it("(AC-2.8) the last fetch is visible to a reader, with its outcome, error code, month and time", async () => {
    state.fail = "http";
    await fetchNow({ months: ["2026-03"] });
    const res = await list("", { as: PERSONAS.readerCh });
    expect(res.status).toBe(200);
    expect(res.body["lastFetch"]).toEqual({ at: NOW.toISOString(), outcome: "failed", errorCode: "http_503", month: "2026-03" });
  });

  it("(AC-2.11) WellD Italia: no source, no currencies, no months, nothing to fetch", async () => {
    const res = await list("", { entity: "welld_it", as: PERSONAS.admin });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      entity: "welld_it", ownCurrency: "EUR", currencies: [], source: null, months: [], lastFetch: null, fetchDue: false,
    });
  });
});

describe("POST /v1/entities/{entity}/exchange-rates/fetch (AC-2.1, AC-2.8, AC-2.9, G5)", () => {
  it("fetches the months asked and reports one attempt each, with what was recorded", async () => {
    const res = await fetchNow({ months: ["2026-03", "2026-04"] });
    expect(res.status).toBe(200);
    expect(FetchRatesResponseSchema.safeParse(res.body).success).toBe(true);
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
    afterThrottle();
    const next = await fetchNow(undefined, { raw: "" });
    expect((next.body["attempts"] as any[]).map((a) => a.month)).toEqual(["2026-04", "2026-03", "2026-02", "2026-01"]);
    expect((await list()).body["fetchDue"]).toBe(false);
  });

  it("(AC-2.9) asks only for the months that have no recorded rate", async () => {
    await fetchNow({ months: ["2026-10", "2026-09"] });
    afterThrottle();
    const res = await fetchNow({});
    expect((res.body["attempts"] as any[]).map((a) => a.month)).toEqual(["2026-08", "2026-07", "2026-06", "2026-05", "2026-04", "2026-03"]);
  });

  it("the trigger is `manager` and the actor the caller's JWT sub, whatever the caller sends", async () => {
    await fetchNow({ months: ["2026-03"] }, { as: PERSONAS.accountingCh });
    const log = await db.exchangeRateFetchAttempt.findMany();
    expect(log.map((l) => [l.entity, l.trigger, l.actorUserId])).toEqual([["welld_ch", "manager", PERSONAS.accountingCh.sub]]);
  });

  it("refuses a `trigger` (or any other member) in the body with 422 and writes and asks nothing", async () => {
    for (const body of [{ trigger: "consumer" }, { months: ["2026-03"], trigger: "manager" }, { months: ["2026-03"], extra: 1 }]) {
      const res = await fetchNow(body);
      expect(res.status).toBe(422);
      expect(res.body["code"]).toBe("invalid_request");
    }
    expect(await db.exchangeRateFetchAttempt.count()).toBe(0);
    expect(source.urls).toHaveLength(0);
  });

  it("(AC-2.8) a source failure is a 200 `failed`: no rate changes, and lastFetch says what and when", async () => {
    for (const [fail, code] of [["http", "http_503"], ["throw", "network"], ["wrongMonth", "month_mismatch"]] as const) {
      await truncateAccountingTables();
      clock = NOW;
      source = fakeSource(answer);
      app = makeApp();
      state.fail = fail;
      const res = await fetchNow({ months: ["2026-03"] });
      expect(res.status).toBe(200);
      expect(res.body["attempts"]).toEqual([{ month: "2026-03", outcome: "failed", errorCode: code, recorded: null }]);
      expect(res.body["lastFetch"]).toEqual({ at: NOW.toISOString(), outcome: "failed", errorCode: code, month: "2026-03" });
      expect(await db.exchangeRateEntry.count()).toBe(0);
      expect((await list()).body["lastFetch"]).toMatchObject({ outcome: "failed", errorCode: code });
    }
  });

  it("(AC-2.8) the failure stays the last fetch until a later fetch succeeds", async () => {
    state.fail = "http";
    await fetchNow({ months: ["2026-03"] });
    expect((await list()).body["lastFetch"].outcome).toBe("failed");
    afterThrottle();
    state.fail = "none";
    await fetchNow({ months: ["2026-03"] });
    expect((await list()).body["lastFetch"]).toMatchObject({ outcome: "ok", errorCode: null });
  });

  it("a month that is not fetchable yet is reported as such, with no call to the source", async () => {
    const res = await fetchNow({ months: ["2026-11"] });
    expect(res.body["attempts"]).toEqual([{ month: "2026-11", outcome: "not_fetchable", errorCode: null, recorded: null }]);
    expect(source.urls).toHaveLength(0);
  });

  it("an immediate second request is throttled and writes nothing", async () => {
    await fetchNow({ months: ["2026-03"] });
    const attemptsBefore = await db.exchangeRateFetchAttempt.count();
    const again = await fetchNow({ months: ["2026-03"] });
    expect(again.body["attempts"]).toEqual([{ month: "2026-03", outcome: "throttled", errorCode: null, recorded: null }]);
    expect(source.urls).toHaveLength(1);
    expect(await db.exchangeRateFetchAttempt.count()).toBe(attemptsBefore);
  });

  it("with the source off every attempt is `disabled`", async () => {
    app = makeApp("off");
    const res = await fetchNow({ months: ["2026-03"] });
    expect(res.body["attempts"]).toEqual([{ month: "2026-03", outcome: "disabled", errorCode: null, recorded: null }]);
    expect(source.urls).toHaveLength(0);
  });

  it("refuses a malformed body with 422 and asks the source for nothing", async () => {
    const bad: unknown[] = [{ months: ["2026-3"] }, { months: "2026-03" }, { months: Array(25).fill("2026-03") }, { months: ["0000-01"] }, { months: ["1999-12"] }, [], "x"];
    for (const body of bad) expect((await fetchNow(body)).status).toBe(422);
    expect((await fetchNow(undefined, { raw: "{nope" })).status).toBe(422);
    expect(source.urls).toHaveLength(0);
    expect(await db.exchangeRateFetchAttempt.count()).toBe(0);
  });

  it("(AC-2.11) WellD Italia: 422 `no_rate_source`, nothing attempted, nothing logged", async () => {
    for (const body of [undefined, {}, { months: ["2026-03"] }]) {
      const res = await fetchNow(body, { entity: "welld_it", as: PERSONAS.accountingIt });
      expect(res.status).toBe(422);
      expect(res.body["code"]).toBe("no_rate_source");
    }
    expect(source.urls).toHaveLength(0);
    expect(await counts("welld_it")).toEqual({ entries: 0, attempts: 0 });
  });
});

describe("PUT /v1/entities/{entity}/exchange-rates/{month}/{currency} (AC-2.4, AC-2.5, AC-2.6)", () => {
  it("(AC-2.4) a correction is in effect at once, the fetched row stays, and the row names who and the value it replaced", async () => {
    await fetchNow({ months: ["2026-03"] });
    const res = await correct("2026-03", "EUR", "0.93", { email: "carla@welld.ch" });
    expect(res.status).toBe(200);
    expect(MonthRowSchema.safeParse(res.body).success).toBe(true);
    expect(res.body["month"]).toBe("2026-03");
    expect(res.body["rates"].EUR).toEqual({ status: "corrected", rateMicros: 930000, rate: "0.9300" });
    expect(res.body["rates"].USD.status).toBe("fetched");
    expect(row(await list(), "2026-03").rates.EUR.rate).toBe("0.9300");
    const rows = await db.exchangeRateEntry.findMany({ where: { currency: "EUR" }, orderBy: { createdAt: "asc" } });
    expect(rows.map((r) => [r.origin, r.rateMicros, r.replacesRateMicros])).toEqual([["fetched", 924600, null], ["corrected", 930000, 924600]]);
    expect(rows[1]).toMatchObject({ entity: "welld_ch", createdByUserId: PERSONAS.accountingCh.sub, createdByEmail: "carla@welld.ch" });
  });

  it("a month with no row can be filled by hand, and then reads as corrected", async () => {
    const res = await correct("2026-02", "GBP", "1.1");
    expect(res.status).toBe(200);
    expect(res.body["rates"].GBP).toEqual({ status: "corrected", rateMicros: 1100000, rate: "1.1000" });
    expect(res.body["rates"].EUR).toEqual({ status: "missing" });
    expect((await db.exchangeRateEntry.findFirstOrThrow()).replacesRateMicros).toBeNull();
  });

  it("(AC-2.6) a later fetch with another value never replaces a correction, and no response says anything about a discrepancy", async () => {
    await fetchNow({ months: ["2026-03"] });
    await correct("2026-03", "EUR", "0.93");
    afterThrottle();
    state.eur = "0.9500";
    const fetched = await fetchNow({ months: ["2026-03"] });
    expect(fetched.body["attempts"][0]).toEqual({ month: "2026-03", outcome: "ok", errorCode: null, recorded: {} });
    expect(row(await list(), "2026-03").rates.EUR).toEqual({ status: "corrected", rateMicros: 930000, rate: "0.9300" });
    expect(JSON.stringify([fetched.body, await list()])).not.toMatch(/discrepan|sourceNow/i);
    const last = (await db.exchangeRateFetchAttempt.findMany({ orderBy: { createdAt: "asc" } })).at(-1)!;
    expect(last.discrepancies).toEqual({ EUR: { fetched: 924600, inEffect: 930000, sourceNow: 950000 } });
  });

  it("a rate equal to the one in effect writes no row and answers 200 with the month row (one shape)", async () => {
    await fetchNow({ months: ["2026-03"] });
    const same = await correct("2026-03", "EUR", "0.9246");
    expect(same.status).toBe(200);
    expect(same.body["rates"].EUR).toEqual({ status: "fetched", rateMicros: 924600, rate: "0.9246" });
    expect(await db.exchangeRateEntry.count({ where: { origin: "corrected" } })).toBe(0);
    await correct("2026-03", "EUR", "0.95");
    const again = await correct("2026-03", "EUR", "0.950000");
    expect(again.status).toBe(200);
    expect(again.body["rates"].EUR.status).toBe("corrected");
    expect(await db.exchangeRateEntry.count({ where: { origin: "corrected" } })).toBe(1);
  });

  it("(AC-2.5) accepts 999.999999 and 0.000001, and refuses 1000, 0, -1 and 1.1234567 with 422 invalid_rate, recording nothing", async () => {
    const top = await correct("2026-03", "EUR", "999.999999");
    expect(top.status).toBe(200);
    expect(top.body["rates"].EUR).toEqual({ status: "corrected", rateMicros: 999999999, rate: "999.999999" });
    const low = await correct("2026-03", "USD", "0.000001");
    expect(low.body["rates"].USD.rateMicros).toBe(1);
    const entriesBefore = await db.exchangeRateEntry.count();
    const attemptsBefore = await db.exchangeRateFetchAttempt.count();
    for (const bad of ["1000", "1000.000000", "0", "0.000000", "-1", "1e2", ".5", "0.1234567", "1.1234567", "", "abc", "99999", "1,5", " "]) {
      const res = await correct("2026-04", "EUR", bad);
      expect(res.status).toBe(422);
      expect(res.body["code"]).toBe("invalid_rate");
    }
    expect((await call("PUT", `${RATES()}/2026-04/EUR`, { body: { rate: 1.5 } })).body["code"]).toBe("invalid_rate");
    expect((await call("PUT", `${RATES()}/2026-04/EUR`, { body: {} })).body["code"]).toBe("invalid_rate");
    expect((await call("PUT", `${RATES()}/2026-04/EUR`, { body: { rate: null } })).body["code"]).toBe("invalid_rate");
    expect(await db.exchangeRateEntry.count()).toBe(entriesBefore);
    expect(await db.exchangeRateFetchAttempt.count()).toBe(attemptsBefore);
  });

  it("(AC-2.5) the own currency, a currency the entity does not convert, and any currency of an entity with no source are 422 currency_not_convertible", async () => {
    for (const currency of ["CHF", "chf", "JPY", "XXXXXX"]) {
      const res = await correct("2026-03", currency, "1");
      expect(res.status).toBe(422);
      expect(res.body["code"]).toBe("currency_not_convertible");
    }
    for (const currency of ["EUR", "USD"]) {
      const res = await correct("2026-03", currency, "1", { entity: "welld_it", as: PERSONAS.accountingIt });
      expect(res.status).toBe(422);
      expect(res.body["code"]).toBe("currency_not_convertible");
    }
    expect(await db.exchangeRateEntry.count()).toBe(0);
  });

  it("a currency in lower case is the same currency", async () => {
    const res = await correct("2026-03", "eur", "0.9");
    expect(res.status).toBe(200);
    expect(res.body["rates"].EUR.status).toBe("corrected");
  });

  it("(AC-2.5) 422 month_not_completed for the current and a future month; 422 invalid_month for a malformed one or one before 2000-01", async () => {
    for (const month of ["2026-11", "2026-12", "2027-03"]) {
      const res = await correct(month, "EUR", "0.9");
      expect(res.status).toBe(422);
      expect(res.body["code"]).toBe("month_not_completed");
    }
    expect((await correct("2026-10", "EUR", "0.9")).status).toBe(200); // the last completed month needs no grace days to be CORRECTED
    for (const month of ["2026-3", "2026-13", "march", "0000-01", "1999-12"]) {
      expect((await correct(month, "EUR", "0.9")).body["code"]).toBe("invalid_month");
    }
    expect(await db.exchangeRateEntry.count()).toBe(1);
  });

  it("takes the actor from the JWT, never from the body", async () => {
    await call("PUT", `${RATES()}/2026-03/EUR`, { body: { rate: "0.9", createdByEmail: "evil@x.ch" }, email: "real@welld.ch" });
    expect((await db.exchangeRateEntry.findFirstOrThrow()).createdByEmail).toBe("real@welld.ch");
  });
});

describe("(AC-2.11) rates are per entity", () => {
  it("a WellD CH fetch and correction leave every WellD Italia row and attempt as they were", async () => {
    await insertFetchedRate(db, "welld_it", {
      currency: "USD", month: "2026-03", rateMicros: 900000, sourceUrl: "https://example.test/x", sourceMonth: "2026-03", fetchedAt: NOW,
    });
    await db.exchangeRateFetchAttempt.create({
      data: { entity: "welld_it", month: monthToDate("2026-03"), trigger: "manager", outcome: "failed", errorCode: "timeout", actorUserId: "u", createdAt: NOW },
    });
    const before = await counts("welld_it");
    await fetchNow({ months: ["2026-03", "2026-04"] });
    await correct("2026-03", "USD", "0.8");
    expect(await counts("welld_it")).toEqual(before);
    expect(await counts("welld_ch")).toEqual({ entries: 7, attempts: 2 });
    expect((await list("", { entity: "welld_it", as: PERSONAS.admin })).body["months"]).toEqual([]);
  });
});

describe("authorization (AC-3.4, AC-3.5, AC-3.6)", () => {
  it("no token is 401 on all three routes", async () => {
    expect((await list("", { token: false })).status).toBe(401);
    expect((await fetchNow({}, { token: false })).status).toBe(401);
    expect((await correct("2026-03", "EUR", "0.9", { token: false })).status).toBe(401);
  });

  it("(AC-3.6) a caller with no grant gets 403 accounting_forbidden and no data, on all three routes", async () => {
    for (const as of [PERSONAS.outsider, PERSONAS.noEntity, PERSONAS.unknownCondition]) {
      for (const res of [await list("", { as }), await fetchNow({}, { as }), await correct("2026-03", "EUR", "0.9", { as })]) {
        expect(res.status).toBe(403);
        expect(res.body["code"]).toBe("accounting_forbidden");
        expect(Object.keys(res.body).sort()).toEqual(["code", "detail", "instance", "status", "title", "type"]);
      }
    }
  });

  it("(AC-2.9, AC-3.4) a reader reads, but POST fetch and PUT are 403 accounting_manage_required, checked before the body, with no row and no call to the source", async () => {
    const as = PERSONAS.readerCh;
    expect((await list("", { as })).status).toBe(200);
    for (const res of [
      await fetchNow({}, { as }),
      await fetchNow({ months: "nope" }, { as }),
      await fetchNow({ trigger: "consumer" }, { as }),
      await correct("2026-03", "EUR", "0.9", { as }),
      await call("PUT", `${RATES()}/2026-03/EUR`, { as, body: {} }),
      await correct("2026-03", "EUR", "oops", { as }),
    ]) {
      expect(res.status).toBe(403);
      expect(res.body["code"]).toBe("accounting_manage_required");
    }
    expect(source.urls).toHaveLength(0);
    expect(await db.exchangeRateEntry.count()).toBe(0);
    expect(await db.exchangeRateFetchAttempt.count()).toBe(0);
  });

  it("a manage-only holder reads and manages (manage includes read)", async () => {
    const as = PERSONAS.managerOnlyCh;
    expect((await list("", { as })).status).toBe(200);
    expect((await correct("2026-03", "EUR", "0.9", { as })).status).toBe(200);
  });

  it("(AC-3.5) an uncovered or unknown entity is 404 with one body, on all three routes, and nothing is written", async () => {
    const results = [];
    for (const entity of ["welld_it", "welld_xx", "__proto__"]) {
      results.push(await list("", { entity }));
      results.push(await fetchNow({}, { entity }));
      results.push(await correct("2026-03", "EUR", "0.9", { entity }));
    }
    for (const res of results) {
      expect(res.status).toBe(404);
      expect(res.body["code"]).toBe("not_found");
      expect(res.body["detail"]).toBe("Not found");
    }
    expect(new Set(results.map((r) => JSON.stringify({ ...r.body, instance: "" }))).size).toBe(1);
    expect(await db.exchangeRateEntry.count()).toBe(0);
    expect(await db.exchangeRateFetchAttempt.count()).toBe(0);
  });

  it("PUT on the list or the month and DELETE anywhere are 404 (no such route), PATCH too", async () => {
    expect((await call("DELETE", `${RATES()}/2026-03/EUR`)).status).toBe(404);
    expect((await call("PATCH", `${RATES()}/2026-03/EUR`, { body: { rate: "1" } })).status).toBe(404);
    expect((await call("PUT", `${RATES()}/2026-03`, { body: { rate: "1" } })).status).toBe(404);
    expect((await call("PUT", RATES(), { body: { rate: "1" } })).status).toBe(404);
    expect(await db.exchangeRateEntry.count()).toBe(0);
  });
});

describe("the assembled app (../index)", () => {
  it("mounts the routes behind the same gates: a reader's fetch is 403 and writes nothing, a manager's is a `disabled` attempt with the source off", async () => {
    const { app: assembled } = await import("../index");
    const send = async (as: Persona, method: string, path: string, body?: unknown) => {
      __resetAuthzCacheForTests();
      harness.setResolve(fakeResolve(as));
      const token = await harness.signToken({ sub: as.sub, email: `${as.sub}@welld.ch` });
      const res = await assembled.request(path, {
        method,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      return { status: res.status, body: (await res.json()) as Record<string, any> };
    };
    const denied = await send(PERSONAS.readerCh, "POST", `${RATES()}/fetch`, { months: ["2026-03"] });
    expect(denied.status).toBe(403);
    expect(await db.exchangeRateFetchAttempt.count()).toBe(0);

    const read = await send(PERSONAS.readerCh, "GET", RATES());
    expect(read.status).toBe(200);
    expect(read.body["source"]).toEqual({ name: "bazg" });

    const ok = await send(PERSONAS.accountingCh, "POST", `${RATES()}/fetch`, { months: ["2026-03"] });
    expect(ok.status).toBe(200);
    expect(ok.body["attempts"]).toEqual([{ month: "2026-03", outcome: "disabled", errorCode: null, recorded: null }]);
    expect((await db.exchangeRateFetchAttempt.findFirstOrThrow()).trigger).toBe("manager");
  });
});
