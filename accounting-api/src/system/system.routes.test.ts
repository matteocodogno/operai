/**
 * Integration tests of accounting-api's `/system/v1/*` routes (T13, specs/20261119-accounting): the reference data and the
 * rates a suite service (Refund) reads. Real Postgres (the `accounting` database); the service JWT is REAL (`systemAuth`
 * verifies RS256, issuer, audience, expiry, scope and `sub` against a key set the test injects); the rates source is a FAKE.
 *
 * AC coverage: 3.8 (a service JWT with the scope from `system:refund-api` reads the reader projection of the same entity;
 * ONE identical 401 for no token, a user JWT, the wrong audience, an expired token, a bad signature, a missing scope and
 * `system:crm-api`; POST, PUT and DELETE are 404; both bodies parse with `accountingWire`), 1.4 / 1.9 / 1.10 (deactivate and
 * reactivate flip `active` in the system read), 1.8, 4.1 (the entries Refund lists come from this read), 2.10 (a missing
 * published month is fetched under the consumer trigger and answered; a failure or a month not yet published is `missing`
 * with its reason; at most six months are attempted; a hung source ends in under 7 s), 1.4 (no user capability is involved).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { fakeResolve, PERSONAS } from "../test-support/fakeResolve";
import { fakeSource, hangingFetcher } from "../test-support/fakeSource";
import { truncateAccountingTables } from "../test-support/dbCleanup";
import { setupTestAuth, TEST_AUDIENCE, TEST_ISSUER, TEST_SERVICE_AUDIENCE } from "../test-support/testAuth";

const harness = setupTestAuth();
await harness.init();

const { OpenAPIHono } = await import("@hono/zod-openapi");
const { app: assembled } = await import("../index");
const { db } = await import("../lib/db");
const { __resetAuthzCacheForTests } = await import("../authz/authz.middleware");
const { __setDefaultJwksForTests } = await import("../auth/systemAuth.middleware");
const { createLedgerAccount, createVatCode, setLedgerAccountActive, setVatCodeActive } = await import("../catalog/catalog.repo");
const { appendCorrection, monthToDate } = await import("../rates/rates.repo");
const { createRatesService, CONSUMER_FETCH_BUDGET_MS } = await import("../rates/rates.service");
const { handleProblemError, problem, validationHook } = await import("../lib/problem");
const { referenceDataRouter } = await import("./referenceData.routes");
const { createSystemRatesRouter, parsePairs } = await import("./rates.routes");
const { accountingWire } = await import("./accountingWire");
const { REFERENCE_READ_SCOPE, SYSTEM_READERS } = await import("./readers");

// ─── The service credential ──────────────────────────────────────────────────

const KID = "svc-accounting-test";
let signingKey: CryptoKey;
let foreignKey: CryptoKey;
let previousJwks: ReturnType<typeof __setDefaultJwksForTests>;

interface TokenOptions {
  readonly sub?: string;
  readonly scope?: string | null;
  readonly aud?: string;
  readonly iss?: string;
  readonly exp?: string | number;
  readonly key?: CryptoKey;
}

const serviceJwt = (o: TokenOptions = {}): Promise<string> => {
  const claims: Record<string, unknown> = {};
  if (o.scope !== null) claims["scope"] = o.scope ?? REFERENCE_READ_SCOPE;
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setIssuedAt()
    .setIssuer(o.iss ?? TEST_ISSUER)
    .setAudience(o.aud ?? TEST_SERVICE_AUDIENCE)
    .setSubject(o.sub ?? "system:refund-api")
    .setExpirationTime(o.exp ?? "5m")
    .sign(o.key ?? signingKey);
};

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  signingKey = pair.privateKey;
  foreignKey = (await generateKeyPair("RS256", { extractable: true })).privateKey;
  const jwk = await exportJWK(pair.publicKey);
  previousJwks = __setDefaultJwksForTests(createLocalJWKSet({ keys: [{ ...jwk, kid: KID, alg: "RS256", use: "sig" }] }));
});

// ─── Requests ────────────────────────────────────────────────────────────────

const NOW = new Date("2026-11-19T10:00:00.000Z"); // October is the newest fetchable month
let clock = NOW;
let source = fakeSource();

/** The system routes alone, with a rates service that has a fake source and a fixed clock, rendered like `index.ts` renders. */
function makeSystemApp(over: Partial<Parameters<typeof createRatesService>[0]> = {}) {
  const app = new OpenAPIHono({ defaultHook: validationHook });
  app.route("/", referenceDataRouter);
  app.route("/", createSystemRatesRouter(createRatesService({ mode: "bazg", fetcher: source.fetcher, now: () => clock, ...over })));
  app.onError((err, c) => handleProblemError(err, c.req.path) ?? problem({ status: 500, detail: "unexpected" }, c.req.path));
  app.notFound((c) => problem({ status: 404, detail: "no route" }, c.req.path));
  return app;
}
let systemApp = makeSystemApp();

interface Reply {
  readonly status: number;
  readonly text: string;
  readonly body: Record<string, any>;
  readonly headers: Headers;
}

async function send(target: { request: (path: string, init?: RequestInit) => Response | Promise<Response> }, method: string, path: string, headers: Record<string, string> = {}): Promise<Reply> {
  const res = await target.request(path, { method, headers });
  const text = await res.text();
  let body: Record<string, any> = {};
  try {
    body = text ? (JSON.parse(text) as Record<string, any>) : {};
  } catch {
    body = {};
  }
  return { status: res.status, text, body, headers: res.headers };
}

const bearer = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });
const REF = (entity = "welld_ch") => `/system/v1/entities/${entity}/reference-data`;
const RATES = (pairs: string | null, entity = "welld_ch") =>
  `/system/v1/entities/${entity}/rates${pairs === null ? "" : `?pairs=${pairs}`}`;

/** A GET with a valid service token against `target` (the assembled app unless a test says otherwise). */
async function get(path: string, target: Parameters<typeof send>[0] = assembled, token?: string): Promise<Reply> {
  return send(target, "GET", path, bearer(token ?? (await serviceJwt())));
}

const actor = { userId: "user-seed", email: "seed@welld.ch" };
async function seedCatalog() {
  for (const [number, name] of [["5901", "Spese viaggi in treno"], ["5905", "Spese rimborsi chilometrici (viaggi)"], ["2620.1", "Conto con punto"], ["6101", "Spese materiale ufficio"]] as const) {
    await createLedgerAccount("welld_ch", { number, name }, actor);
  }
  await createLedgerAccount("welld_it", { number: "9001", name: "Conto Italia" }, actor);
  for (const [code, label, rateBasisPoints] of [["IMP81", "IVA 8.1%", 810], ["NOVAT", "Senza IVA", 0], ["IMP77", "IVA 7.7%", 770]] as const) {
    await createVatCode("welld_ch", { code, label, rateBasisPoints }, actor);
  }
  await setLedgerAccountActive("welld_ch", "6101", false, actor);
  await setVatCodeActive("welld_ch", "IMP77", false, actor);
}

const userGet = async (path: string, as = PERSONAS.readerCh) => {
  __resetAuthzCacheForTests();
  harness.setResolve(fakeResolve(as));
  const token = await harness.signToken({ sub: as.sub, email: `${as.sub}@welld.ch` });
  return send(assembled, "GET", path, bearer(token));
};

beforeEach(async () => {
  await truncateAccountingTables();
  __resetAuthzCacheForTests();
  clock = NOW;
  source = fakeSource();
  systemApp = makeSystemApp();
});
afterAll(async () => {
  __setDefaultJwksForTests(previousJwks);
  await truncateAccountingTables();
});

const entries = () => db.exchangeRateEntry.findMany({ orderBy: [{ createdAt: "asc" }, { currency: "asc" }] });
const attempts = () => db.exchangeRateFetchAttempt.findMany({ orderBy: [{ createdAt: "asc" }, { id: "asc" }] });

describe("the scope and the allow-list (D8)", () => {
  it("fixes the one scope and the one reader", () => {
    expect(REFERENCE_READ_SCOPE).toBe("accounting.reference.read");
    expect([...SYSTEM_READERS]).toEqual(["system:refund-api"]);
  });
});

describe("GET /system/v1/entities/{entity}/reference-data (AC-3.8, AC-1.4, AC-1.8, AC-1.9, AC-1.10)", () => {
  it("(AC-3.8) equals the reader projection of the user routes of the same entity, in the same order, and parses with accountingWire", async () => {
    await seedCatalog();
    const system = await get(REF());
    expect(system.status).toBe(200);
    expect(() => accountingWire.referenceData.parse(system.body)).not.toThrow();

    const accounts = await userGet("/v1/entities/welld_ch/ledger-accounts");
    const vats = await userGet("/v1/entities/welld_ch/vat-codes");
    expect(system.body).toEqual({
      entity: "welld_ch",
      ownCurrency: "CHF",
      ledgerAccounts: accounts.body["items"],
      vatCodes: (vats.body["items"] as Record<string, unknown>[]).map(({ code, label, rateBasisPoints, active }) => ({ code, label, rateBasisPoints, active })),
    });
    expect((system.body["ledgerAccounts"] as { number: string }[]).map((a) => a.number)).toEqual(["2620.1", "5901", "5905", "6101"]);
    expect(system.body["vatCodes"]).toEqual([
      { code: "IMP77", label: "IVA 7.7%", rateBasisPoints: 770, active: false },
      { code: "IMP81", label: "IVA 8.1%", rateBasisPoints: 810, active: true },
      { code: "NOVAT", label: "Senza IVA", rateBasisPoints: 0, active: true },
    ]);
  });

  it("(D18) carries no id, no who-added, no history and no display rate: exact key sets", async () => {
    await seedCatalog();
    const { body } = await get(REF());
    expect(Object.keys(body).sort()).toEqual(["entity", "ledgerAccounts", "ownCurrency", "vatCodes"]);
    for (const a of body["ledgerAccounts"]) expect(Object.keys(a).sort()).toEqual(["active", "name", "number"]);
    for (const v of body["vatCodes"]) expect(Object.keys(v).sort()).toEqual(["active", "code", "label", "rateBasisPoints"]);
  });

  it("(AC-1.4, AC-1.9) deactivate and reactivate an account flip `active` in the system read, the entry never leaves it", async () => {
    await seedCatalog();
    const active = async () => ((await get(REF())).body["ledgerAccounts"] as { number: string; active: boolean }[]).find((a) => a.number === "5901")!.active;
    expect(await active()).toBe(true);
    await setLedgerAccountActive("welld_ch", "5901", false, actor);
    expect(await active()).toBe(false);
    await setLedgerAccountActive("welld_ch", "5901", true, actor);
    expect(await active()).toBe(true);
  });

  it("(AC-1.8, AC-1.10) deactivate and reactivate a VAT code flip `active`, its rate stays the one it was added with", async () => {
    await seedCatalog();
    const find = async () => ((await get(REF())).body["vatCodes"] as { code: string; label: string; active: boolean; rateBasisPoints: number }[]).find((v) => v.code === "IMP81")!;
    await setVatCodeActive("welld_ch", "IMP81", false, actor);
    expect(await find()).toEqual({ code: "IMP81", label: "IVA 8.1%", rateBasisPoints: 810, active: false });
    await setVatCodeActive("welld_ch", "IMP81", true, actor);
    expect((await find()).active).toBe(true);
  });

  it("an entity with nothing entered is an empty answer, not an error; the other entity's entries never appear", async () => {
    await seedCatalog();
    const italy = await get(REF("welld_it"));
    expect(italy.status).toBe(200);
    expect(italy.body).toEqual({ entity: "welld_it", ownCurrency: "EUR", ledgerAccounts: [{ number: "9001", name: "Conto Italia", active: true }], vatCodes: [] });
    await truncateAccountingTables();
    expect((await get(REF("welld_it"))).body).toEqual({ entity: "welld_it", ownCurrency: "EUR", ledgerAccounts: [], vatCodes: [] });
  });

  it("an entity that does not exist is 404 not_found", async () => {
    for (const entity of ["welld_xx", "__proto__", "WELLD_CH"]) {
      const res = await get(REF(entity));
      expect(res.status).toBe(404);
      expect(res.body["code"]).toBe("not_found");
    }
  });
});

describe("GET /system/v1/entities/{entity}/rates (AC-2.10, AC-3.8)", () => {
  it("(AC-2.10) a missing published month is fetched under the consumer trigger and answered in the asked order", async () => {
    const res = await get(RATES("USD:2026-03,EUR:2026-03,GBP:2026-03"), systemApp);
    expect(res.status).toBe(200);
    expect(() => accountingWire.rates.parse(res.body)).not.toThrow();
    expect(res.body).toEqual({
      entity: "welld_ch",
      rates: [
        { currency: "USD", month: "2026-03", status: "in_effect", rateMicros: 780800, origin: "fetched", attempted: true },
        { currency: "EUR", month: "2026-03", status: "in_effect", rateMicros: 924600, origin: "fetched", attempted: true },
        { currency: "GBP", month: "2026-03", status: "in_effect", rateMicros: 1063500, origin: "fetched", attempted: true },
      ],
    });
    expect(source.urls).toHaveLength(1);
    const log = await attempts();
    expect(log.map((l) => [l.entity, l.month.toISOString().slice(0, 7), l.trigger, l.outcome, l.actorUserId])).toEqual([
      ["welld_ch", "2026-03", "consumer", "ok", "system:refund-api"],
    ]);
    expect((await entries()).map((e) => [e.entity, e.origin, e.createdByUserId])).toEqual([
      ["welld_ch", "fetched", "system:rates-fetch"],
      ["welld_ch", "fetched", "system:rates-fetch"],
      ["welld_ch", "fetched", "system:rates-fetch"],
    ]);
  });

  it("a rate already in effect is answered with no call to the source and `attempted: false`; a correction is the origin `corrected`", async () => {
    await get(RATES("EUR:2026-03"), systemApp);
    await appendCorrection("welld_ch", { currency: "EUR", month: "2026-03", rateMicros: 930000, actor });
    const res = await get(RATES("EUR:2026-03,USD:2026-03"), systemApp);
    expect(res.body["rates"]).toEqual([
      { currency: "EUR", month: "2026-03", status: "in_effect", rateMicros: 930000, origin: "corrected", attempted: false },
      { currency: "USD", month: "2026-03", status: "in_effect", rateMicros: 780800, origin: "fetched", attempted: false },
    ]);
    expect(source.urls).toHaveLength(1);
  });

  it("a month before the 5th of the next month is `not_published`, with no call to the source and no attempt row", async () => {
    clock = new Date("2026-11-03T10:00:00.000Z"); // October is not fetchable yet; September is
    const res = await get(RATES("EUR:2026-10,EUR:2026-11,EUR:2027-02"), systemApp);
    expect(res.body["rates"]).toEqual([
      { currency: "EUR", month: "2026-10", status: "missing", attempted: false, reason: "not_published" },
      { currency: "EUR", month: "2026-11", status: "missing", attempted: false, reason: "not_published" },
      { currency: "EUR", month: "2027-02", status: "missing", attempted: false, reason: "not_published" },
    ]);
    expect(source.urls).toHaveLength(0);
    expect(await attempts()).toHaveLength(0);
  });

  it("a failing source is `missing` / `fetch_failed` with `attempted: true`, a rate row changes nothing, and the failure is logged under the consumer trigger", async () => {
    source = fakeSource(() => new Response("no", { status: 503 }));
    systemApp = makeSystemApp();
    const res = await get(RATES("EUR:2026-03"), systemApp);
    expect(res.status).toBe(200);
    expect(res.body["rates"]).toEqual([{ currency: "EUR", month: "2026-03", status: "missing", attempted: true, reason: "fetch_failed" }]);
    expect(await entries()).toHaveLength(0);
    expect((await attempts()).map((a) => [a.trigger, a.outcome, a.errorCode, a.actorUserId])).toEqual([["consumer", "failed", "http_503", "system:refund-api"]]);
  });

  it("a second ask within 15 minutes is throttled: `missing`, `attempted: false`, no new call and no new row", async () => {
    source = fakeSource(() => new Response("no", { status: 503 }));
    systemApp = makeSystemApp();
    await get(RATES("EUR:2026-03"), systemApp);
    const again = await get(RATES("EUR:2026-03"), systemApp);
    expect(again.body["rates"]).toEqual([{ currency: "EUR", month: "2026-03", status: "missing", attempted: false, reason: "fetch_failed" }]);
    expect(source.urls).toHaveLength(1);
    expect(await attempts()).toHaveLength(1);
  });

  it("36 pairs over 12 months attempt at most six months, the newest; the rest are missing and not attempted", async () => {
    const months = ["2026-10", "2026-09", "2026-08", "2026-07", "2026-06", "2026-05", "2026-04", "2026-03", "2026-02", "2026-01", "2025-12", "2025-11"];
    const pairs = months.flatMap((m) => ["EUR", "USD", "GBP"].map((c) => `${c}:${m}`));
    expect(pairs).toHaveLength(36);
    const res = await get(RATES(pairs.join(",")), systemApp);
    expect(res.status).toBe(200);
    expect(source.urls).toHaveLength(6);
    const rates = res.body["rates"] as { month: string; status: string; attempted: boolean }[];
    expect(rates).toHaveLength(36);
    expect(rates.map((r) => `${r.month}`)).toEqual(pairs.map((p) => p.split(":")[1]!));
    for (const r of rates) {
      const newest = months.slice(0, 6).includes(r.month);
      expect([r.status, r.attempted]).toEqual(newest ? ["in_effect", true] : ["missing", false]);
    }
  });

  it("a source that never answers ends in under 7 s as `missing` (the 6 s consumer budget, AC-2.10)", async () => {
    expect(CONSUMER_FETCH_BUDGET_MS).toBe(6_000);
    systemApp = makeSystemApp({ fetcher: hangingFetcher, budgetMs: { consumer: 250 } });
    const started = Date.now();
    const res = await get(RATES("EUR:2026-03"), systemApp);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(res.status).toBe(200);
    expect(res.body["rates"]).toEqual([{ currency: "EUR", month: "2026-03", status: "missing", attempted: true, reason: "fetch_failed" }]);
    expect((await attempts()).map((a) => [a.trigger, a.errorCode])).toEqual([["consumer", "timeout"]]);
  });

  it("(AC-1.4) the answer needs no user capability: the caller is a service, and a rate fetched for WellD CH leaves WellD Italia untouched", async () => {
    await db.exchangeRateFetchAttempt.create({
      data: { entity: "welld_it", month: monthToDate("2026-03"), trigger: "manager", outcome: "failed", errorCode: "timeout", actorUserId: "u", createdAt: NOW },
    });
    await get(RATES("EUR:2026-03"), systemApp);
    expect(await db.exchangeRateEntry.count({ where: { entity: "welld_it" } })).toBe(0);
    expect(await db.exchangeRateFetchAttempt.count({ where: { entity: "welld_it" } })).toBe(1);
  });

  it("is `disabled` with the source off, through the assembled app: missing, not attempted, and the attempt row says so", async () => {
    const res = await get(RATES("EUR:2026-03"));
    expect(res.status).toBe(200);
    expect(res.body["rates"]).toEqual([{ currency: "EUR", month: "2026-03", status: "missing", attempted: false, reason: "fetch_failed" }]);
    expect((await attempts()).map((a) => [a.trigger, a.outcome, a.actorUserId])).toEqual([["consumer", "disabled", "system:refund-api"]]);
  });

  it("refuses a `pairs` that is not 1 to 36 distinct CCC:YYYY-MM from 2000-01 with 400 invalid_pairs, and reads and fetches nothing", async () => {
    const tooMany = Array.from({ length: 37 }, (_, i) => `EUR:${String(2020 + Math.floor(i / 12)).padStart(4, "0")}-${String((i % 12) + 1).padStart(2, "0")}`).join(",");
    const bad: (string | null)[] = [
      null, "", ",", "EUR", "EUR:", "EUR:2026", "EUR:2026-3", "EUR:2026-13", "EUR:2026-00", "EUR:1999-12", "EUR:0000-01", "eur:2026-03", "EURO:2026-03",
      "EUR:2026-03,", ",EUR:2026-03", "EUR:2026-03,,USD:2026-03", "EUR:2026-03,EUR:2026-03", "EUR:2026-03%20", "%20EUR:2026-03", "EUR:2026-03%2CUSD:2026-03%2C", "EUR%3A2026-03x",
      "EUR:2026-03;USD:2026-03", tooMany, "EUR:2026-03&pairs=USD:2026-03", `EUR:2026-03,${"A".repeat(600)}`,
    ];
    for (const pairs of bad) {
      const res = await get(RATES(pairs), systemApp);
      expect([pairs, res.status, res.body["code"]]).toEqual([pairs, 400, "invalid_pairs"]);
    }
    expect(source.urls).toHaveLength(0);
    expect(await attempts()).toHaveLength(0);
  });

  it("accepts exactly 36 distinct pairs and the first month, 2000-01", async () => {
    expect(parsePairs(["EUR:2000-01"])).toEqual({ ok: true, pairs: [{ currency: "EUR", month: "2000-01" }] });
    const thirtySix = Array.from({ length: 36 }, (_, i) => `EUR:${2020 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`);
    expect(parsePairs([thirtySix.join(",")]).ok).toBe(true);
    expect(parsePairs([`${thirtySix.join(",")},USD:2026-03`]).ok).toBe(false);
    expect(parsePairs(undefined).ok).toBe(false);
    expect(parsePairs(["EUR:2026-03", "USD:2026-03"]).ok).toBe(false);
  });

  it("refuses a currency the entity does not convert with 422 currency_not_convertible, for the whole request, fetching nothing", async () => {
    for (const [pairs, entity] of [["CHF:2026-03", "welld_ch"], ["EUR:2026-03,JPY:2026-03", "welld_ch"], ["XYZ:2026-03", "welld_ch"], ["EUR:2026-03", "welld_it"], ["USD:2026-03", "welld_it"]] as const) {
      const res = await get(RATES(pairs, entity), systemApp);
      expect([pairs, entity, res.status, res.body["code"]]).toEqual([pairs, entity, 422, "currency_not_convertible"]);
    }
    expect(source.urls).toHaveLength(0);
    expect(await attempts()).toHaveLength(0);
  });

  it("answers an entity that does not exist with 404 before it reads `pairs`", async () => {
    for (const pairs of ["EUR:2026-03", "nonsense", null]) {
      const res = await get(RATES(pairs, "welld_xx"), systemApp);
      expect(res.status).toBe(404);
      expect(res.body["code"]).toBe("not_found");
    }
  });
});

describe("one identical 401 (AC-3.8)", () => {
  const failures: Record<string, () => Promise<Record<string, string>>> = {
    "no token": async () => ({}),
    "an empty bearer": async () => ({ Authorization: "Bearer " }),
    "another scheme": async () => ({ Authorization: `Basic ${await serviceJwt()}` }),
    "garbage": async () => bearer("not.a.jwt"),
    "a user JWT (the user audience)": async () => bearer(await serviceJwt({ aud: TEST_AUDIENCE })),
    "a real user JWT from the harness": async () => bearer(await harness.signToken({ sub: "user-reader", email: "r@welld.ch" })),
    "the wrong audience": async () => bearer(await serviceJwt({ aud: "operai-other" })),
    "the wrong issuer": async () => bearer(await serviceJwt({ iss: "http://evil.example" })),
    "an expired token": async () => bearer(await serviceJwt({ exp: Math.floor(Date.now() / 1000) - 120 })),
    "a bad signature": async () => bearer(await serviceJwt({ key: foreignKey })),
    "a missing scope": async () => bearer(await serviceJwt({ scope: null })),
    "another scope": async () => bearer(await serviceJwt({ scope: "crm.contacts.read" })),
    "a longer scope that contains the name": async () => bearer(await serviceJwt({ scope: "accounting.reference.readwrite" })),
    "system:crm-api": async () => bearer(await serviceJwt({ sub: "system:crm-api" })),
    "a user sub": async () => bearer(await serviceJwt({ sub: "user-reader" })),
    "a bare system: sub": async () => bearer(await serviceJwt({ sub: "system:" })),
    "the allowed sub in another case": async () => bearer(await serviceJwt({ sub: "SYSTEM:REFUND-API" })),
  };

  for (const path of [REF(), RATES("EUR:2026-03")]) {
    it(`${path.split("?")[0]!.split("/").pop()}: every failure has the same status, body and headers, and does nothing`, async () => {
      const replies: [string, Reply][] = [];
      for (const [name, headers] of Object.entries(failures)) replies.push([name, await send(assembled, "GET", path, await headers())]);
      for (const [name, reply] of replies) expect([name, reply.status]).toEqual([name, 401]);
      const first = replies[0]![1];
      for (const [name, reply] of replies) {
        expect([name, reply.text]).toEqual([name, first.text]);
        expect([name, reply.headers.get("content-type"), reply.headers.get("cache-control")]).toEqual([name, first.headers.get("content-type"), "no-store"]);
      }
      expect(first.body).toEqual({
        type: "https://httpstatuses.com/401",
        title: "Unauthorized",
        status: 401,
        detail: "Valid credentials are required",
        instance: path.split("?")[0],
      });
      expect(await attempts()).toHaveLength(0);
      expect(await entries()).toHaveLength(0);
    });
  }

  it("is the same for an entity that does not exist, and for a malformed `pairs`: the credential is checked first", async () => {
    const good = await send(assembled, "GET", RATES("EUR:2026-03"));
    const unknownEntity = await send(assembled, "GET", RATES("EUR:2026-03", "welld_xx"));
    const malformed = await send(assembled, "GET", RATES("nonsense"));
    expect([good.status, unknownEntity.status, malformed.status]).toEqual([401, 401, 401]);
    expect(unknownEntity.body["detail"]).toBe(good.body["detail"]);
    expect(malformed.text).toBe(good.text);
  });

  it("a valid service token is 200 on both routes (the control of the table above)", async () => {
    expect((await get(REF())).status).toBe(200);
    expect((await get(RATES("EUR:2026-03"))).status).toBe(200);
  });

  it("a service token is no user credential: it is 401 on the user routes", async () => {
    const token = await serviceJwt();
    for (const path of ["/v1/me", "/v1/entities/welld_ch/ledger-accounts", "/v1/entities/welld_ch/exchange-rates"]) {
      expect((await send(assembled, "GET", path, bearer(token))).status).toBe(401);
    }
  });
});

describe("read-only (AC-3.8)", () => {
  it("POST, PUT, PATCH and DELETE on both paths are 404, with a valid service token and without one, and write nothing", async () => {
    for (const path of [REF(), RATES("EUR:2026-03")]) {
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        for (const headers of [bearer(await serviceJwt()), {}]) {
          const res = await send(assembled, method, path, headers);
          expect([path, method, res.status]).toEqual([path, method, 404]);
        }
      }
    }
    expect(await attempts()).toHaveLength(0);
    expect(await entries()).toHaveLength(0);
    expect(await db.ledgerAccount.count()).toBe(0);
  });

  it("the OpenAPI document lists the two system routes with a GET each and nothing else", async () => {
    const res = await assembled.request("/openapi.json");
    expect(res.status).toBe(200);
    const paths = ((await res.json()) as { paths: Record<string, Record<string, unknown>> }).paths;
    const system = Object.entries(paths).filter(([path]) => path.startsWith("/system/"));
    expect(system.map(([path, ops]) => [path, Object.keys(ops)])).toEqual([
      ["/system/v1/entities/{entity}/reference-data", ["get"]],
      ["/system/v1/entities/{entity}/rates", ["get"]],
    ]);
  });
});

describe("Cache-Control: no-store", () => {
  it("is on the 200, the 400, the 404 and the 422 of both routes", async () => {
    const replies = [
      await get(REF()),
      await get(REF("welld_xx")),
      await get(RATES("EUR:2026-03"), systemApp),
      await get(RATES("nonsense"), systemApp),
      await get(RATES("EUR:2026-03", "welld_xx"), systemApp),
      await get(RATES("CHF:2026-03"), systemApp),
    ];
    expect(replies.map((r) => r.status)).toEqual([200, 404, 200, 400, 404, 422]);
    for (const r of replies) expect(r.headers.get("cache-control")).toBe("no-store");
  });
});

describe("the wire contract (T7)", () => {
  it("parses every 200 body of the suite with accountingWire, strict both ways", async () => {
    await seedCatalog();
    const ch = await get(REF());
    const it = await get(REF("welld_it"));
    expect(() => accountingWire.referenceData.parse(ch.body)).not.toThrow();
    expect(() => accountingWire.referenceData.parse(it.body)).not.toThrow();
    const rates = await get(RATES("EUR:2026-03,EUR:2026-11,GBP:2026-02"), systemApp);
    expect(() => accountingWire.rates.parse(rates.body)).not.toThrow();
    expect(accountingWire.rates.safeParse({ ...rates.body, extra: 1 }).success).toBe(false);
  });
});
