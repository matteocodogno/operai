/**
 * The adversarial and cross-cutting matrix of accounting-api (T15, specs/20261119-accounting): every route of the ASSEMBLED
 * app against every kind of caller, so a route added later cannot escape a rule the others obey. Real Postgres (the
 * `accounting` database), the shared auth harness (a fake `auth GET /authz/resolve`), and a REAL `systemAuth` verifying the
 * service JWTs of a key set the test injects. No network: the rates source is off, or a fake.
 *
 * AC coverage: 3.6 (no grant: 403 with no data, on every user route), 3.5 (an entity outside the caller's coverage is the same
 * 404 as one that does not exist), 3.4 (a reader writes nothing, and a refused request writes nothing), 3.8 (no user route
 * accepts a service JWT, no system route a user JWT; ONE identical 401 for every credential that is not the principal), 2.10
 * (a consumer's trigger and actor are derived from the credential; concurrent asks share one fetch), 6.8 (the budget is in
 * `budgets.cross-package.test.ts`).
 *
 * The routes are read from the assembled app (`app.routes`) and compared with the table below, so a new route fails the
 * inventory until it is listed here with its rule, instead of passing unexamined.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { createLocalJWKSet, decodeJwt, exportJWK, generateKeyPair, SignJWT, UnsecuredJWT } from "jose";
import { setupTestAuth, TEST_AUDIENCE, TEST_ISSUER, TEST_SERVICE_AUDIENCE } from "./test-support/testAuth"; // first: it sets the environment the modules below read
import { accountingGrant, ENTITY_CONDITION, fakeResolve, PERSONAS, resolveBodyFor, type Persona } from "./test-support/fakeResolve";
import { fakeSource, xmlFor } from "./test-support/fakeSource";
import { ACCOUNTING_TABLES, truncateAccountingTables } from "./test-support/dbCleanup";

const harness = setupTestAuth();
await harness.init();

const { OpenAPIHono } = await import("@hono/zod-openapi");
const { app } = await import("./index");
const { db } = await import("./lib/db");
const { __resetAuthzCacheForTests } = await import("./authz/authz.middleware");
const { __setDefaultJwksForTests } = await import("./auth/systemAuth.middleware");
const { createLedgerAccount, createVatCode, setLedgerAccountActive, setVatCodeActive } = await import("./catalog/catalog.repo");
const { createRatesRouter } = await import("./rates/rates.routes");
const { createRatesService } = await import("./rates/rates.service");
const { handleProblemError, problem, validationHook } = await import("./lib/problem");
const { referenceDataRouter } = await import("./system/referenceData.routes");
const { createSystemRatesRouter } = await import("./system/rates.routes");
const { REFERENCE_READ_SCOPE } = await import("./system/readers");

type EntityId = "welld_ch" | "welld_it";
const ENTITY_IDS: readonly EntityId[] = ["welld_ch", "welld_it"];
const otherOf = (entity: EntityId): EntityId => (entity === "welld_ch" ? "welld_it" : "welld_ch");

// ─── The callers ─────────────────────────────────────────────────────────────

const READER_IT: Persona = { sub: "user-reader-it", entity: "welld_it", permissions: [accountingGrant("read", ENTITY_CONDITION)] };
/** Reads both entities (an unconditioned read) and manages only its own, WellD Italia. */
const READS_BOTH_MANAGES_IT: Persona = {
  sub: "user-reads-both-manages-it",
  entity: "welld_it",
  permissions: [accountingGrant("read"), accountingGrant("manage", ENTITY_CONDITION)],
};

const OWNER: Record<EntityId, Persona> = { welld_ch: PERSONAS.accountingCh, welld_it: PERSONAS.accountingIt };
const READER: Record<EntityId, Persona> = { welld_ch: PERSONAS.readerCh, welld_it: READER_IT };
/** Callers with no grant that covers anything: a refused read says 403 whatever the path. */
const NO_COVERAGE = [PERSONAS.outsider, PERSONAS.noEntity, PERSONAS.unknownCondition] as const;
/** Entity ids that name no entity (case, whitespace, prototype keys, an encoded NUL). */
const NO_SUCH_ENTITY = ["welld_xx", "WELLD_CH", "welld_ch%20", "%20welld_it", "__proto__", "constructor", "toString", "welld_ch%00", "welld"] as const;

const BY_SUB = new Map<string, Persona>([...Object.values(PERSONAS), READER_IT, READS_BOTH_MANAGES_IT].map((p) => [p.sub, p]));

// ─── The routes (the table the inventory checks against the app) ─────────────

interface UserRoute {
  readonly method: "GET" | "POST" | "PUT";
  /** The path as the app registers it. */
  readonly template: string;
  /** What the caller needs: any grant (`/v1/me`), read of the entity, or manage of it. */
  readonly level: "any" | "read" | "manage";
  readonly path: (entity: string) => string;
  readonly body?: Record<string, unknown>;
  /** The status an authorised caller gets, per entity, against the state `seed()` leaves. */
  readonly ok: (entity: EntityId) => number;
}

const E = (entity: string) => `/v1/entities/${entity}`;
const USER_ROUTES: readonly UserRoute[] = [
  { method: "GET", template: "/v1/me", level: "any", path: () => "/v1/me", ok: () => 200 },
  { method: "GET", template: "/v1/entities/:entity/ledger-accounts", level: "read", path: (e) => `${E(e)}/ledger-accounts`, ok: () => 200 },
  { method: "POST", template: "/v1/entities/:entity/ledger-accounts", level: "manage", path: (e) => `${E(e)}/ledger-accounts`, body: { number: "7001", name: "Nuovo conto" }, ok: () => 201 },
  { method: "POST", template: "/v1/entities/:entity/ledger-accounts/:number/deactivate", level: "manage", path: (e) => `${E(e)}/ledger-accounts/5901/deactivate`, ok: () => 200 },
  { method: "POST", template: "/v1/entities/:entity/ledger-accounts/:number/reactivate", level: "manage", path: (e) => `${E(e)}/ledger-accounts/5902/reactivate`, ok: () => 200 },
  { method: "GET", template: "/v1/entities/:entity/vat-codes", level: "read", path: (e) => `${E(e)}/vat-codes`, ok: () => 200 },
  { method: "POST", template: "/v1/entities/:entity/vat-codes", level: "manage", path: (e) => `${E(e)}/vat-codes`, body: { code: "NEW1", label: "Nuova aliquota", ratePercent: "2.6" }, ok: () => 201 },
  { method: "POST", template: "/v1/entities/:entity/vat-codes/:code/deactivate", level: "manage", path: (e) => `${E(e)}/vat-codes/IMP81/deactivate`, ok: () => 200 },
  { method: "POST", template: "/v1/entities/:entity/vat-codes/:code/reactivate", level: "manage", path: (e) => `${E(e)}/vat-codes/IMP77/reactivate`, ok: () => 200 },
  { method: "GET", template: "/v1/entities/:entity/exchange-rates", level: "read", path: (e) => `${E(e)}/exchange-rates`, ok: () => 200 },
  { method: "POST", template: "/v1/entities/:entity/exchange-rates/fetch", level: "manage", path: (e) => `${E(e)}/exchange-rates/fetch`, body: {}, ok: (e) => (e === "welld_ch" ? 200 : 422) },
  { method: "PUT", template: "/v1/entities/:entity/exchange-rates/:month/:currency", level: "manage", path: (e) => `${E(e)}/exchange-rates/2026-01/EUR`, body: { rate: "0.93" }, ok: (e) => (e === "welld_ch" ? 200 : 422) },
];
const ENTITY_ROUTES = USER_ROUTES.filter((r) => r.level !== "any");
const WRITE_ROUTES = USER_ROUTES.filter((r) => r.level === "manage");
const READ_ROUTES = ENTITY_ROUTES.filter((r) => r.level === "read");

const SYSTEM_ROUTES = [
  { template: "/system/v1/entities/:entity/reference-data", path: (e = "welld_ch") => `/system/v1/entities/${e}/reference-data` },
  { template: "/system/v1/entities/:entity/rates", path: (e = "welld_ch") => `/system/v1/entities/${e}/rates?pairs=EUR:2026-03` },
] as const;

// ─── Requests ────────────────────────────────────────────────────────────────

interface Reply {
  readonly status: number;
  readonly text: string;
  readonly body: Record<string, any>;
  readonly headers: Headers;
}

const PROBLEM_KEYS = ["type", "title", "status", "detail", "instance", "code"];

interface CallOptions {
  readonly as?: Persona;
  /** The whole `Authorization` value; `null` sends none. Default: a user token of `as`. */
  readonly authorization?: string | null;
  readonly body?: unknown;
  readonly raw?: string;
  /** Keep the (sub, epoch) cache and the resolve fixture of the previous call (concurrency). */
  readonly keepAuthz?: boolean;
}

async function call(method: string, path: string, o: CallOptions = {}): Promise<Reply> {
  const as = o.as ?? PERSONAS.accountingCh;
  if (!o.keepAuthz) {
    __resetAuthzCacheForTests(); // the middleware caches per (sub, epoch): every call resolves afresh
    harness.setResolve(fakeResolve(as));
  }
  const headers: Record<string, string> = {};
  if (o.authorization === undefined) headers["Authorization"] = `Bearer ${await harness.signToken({ sub: as.sub, email: `${as.sub}@welld.ch` })}`;
  else if (o.authorization !== null) headers["Authorization"] = o.authorization;
  const hasBody = method !== "GET" && method !== "HEAD";
  if (hasBody) headers["Content-Type"] = "application/json";
  const res = await app.request(path, {
    method,
    headers,
    ...(hasBody && o.raw !== undefined ? { body: o.raw } : hasBody && o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
  });
  const text = await res.text();
  let body: Record<string, any> = {};
  try {
    body = text ? (JSON.parse(text) as Record<string, any>) : {};
  } catch {
    body = {};
  }
  return { status: res.status, text, body, headers: res.headers };
}

const send = (route: UserRoute, entity: string, o: CallOptions = {}) =>
  call(route.method, route.path(entity), { ...(route.body !== undefined ? { body: route.body } : {}), ...o });

/** A body that is not JSON: a refusal must come before anything reads it. */
const BROKEN_BODY = '{"number":';

async function snapshot(): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of ACCOUNTING_TABLES) {
    const rows = await db.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM "${table}"`);
    counts[table] = Number(rows[0]!.n);
  }
  return counts;
}

const actor = { userId: "user-seed", email: "seed@welld.ch" };
const MARK = (entity: string) => `SECRET-${entity}`;

/** Per entity: accounts 5901 (active) and 5902 (deactivated), VAT codes IMP81 (active) and IMP77 (deactivated); every name carries a marker. */
async function seed() {
  for (const entity of ENTITY_IDS) {
    await createLedgerAccount(entity, { number: "5901", name: `${MARK(entity)} treno` }, actor);
    await createLedgerAccount(entity, { number: "5902", name: `${MARK(entity)} aereo` }, actor);
    await setLedgerAccountActive(entity, "5902", false, actor);
    await createVatCode(entity, { code: "IMP81", label: `${MARK(entity)} 8.1`, rateBasisPoints: 810 }, actor);
    await createVatCode(entity, { code: "IMP77", label: `${MARK(entity)} 7.7`, rateBasisPoints: 770 }, actor);
    await setVatCodeActive(entity, "IMP77", false, actor);
  }
}

/** A refusal is a Problem: the standard members and nothing else, and none of the seeded data. */
function expectProblemOnly(r: Reply) {
  expect(r.text).not.toContain("SECRET");
  expect(Object.keys(r.body).filter((key) => !PROBLEM_KEYS.includes(key))).toEqual([]);
}

/** A refusal with the entity of the path blanked, so refusals of different paths can be compared byte for byte. */
const shape = (r: Reply, segment: string) => ({
  ...r.body,
  // The instance echoes the path as the router decoded it (`%20` is a space), so the segment is blanked in both spellings.
  instance: String(r.body["instance"]).split(decodeURIComponent(segment)).join("<E>").split(segment).join("<E>"),
});

beforeAll(async () => {
  await truncateAccountingTables();
});
beforeEach(async () => {
  await truncateAccountingTables();
  await seed();
  __resetAuthzCacheForTests();
});
afterAll(async () => {
  await truncateAccountingTables();
});

// ─── The inventory ───────────────────────────────────────────────────────────

describe("the routes of the assembled app are exactly the routes this matrix covers", () => {
  const registered = [...new Set(app.routes.filter((r) => r.method !== "ALL").map((r) => `${r.method} ${r.path}`))].sort();

  it("lists every /v1 route, so a new one fails here until it has a rule", () => {
    expect(registered.filter((r) => r.split(" ")[1]!.startsWith("/v1/"))).toEqual(USER_ROUTES.map((r) => `${r.method} ${r.template}`).sort());
  });

  it("lists every /system/v1 route", () => {
    expect(registered.filter((r) => r.split(" ")[1]!.startsWith("/system/"))).toEqual(SYSTEM_ROUTES.map((r) => `GET ${r.template}`).sort());
  });

  it("has no other route that could carry data: /health, the OpenAPI document and its UI", () => {
    expect(registered.filter((r) => !r.split(" ")[1]!.startsWith("/v1/") && !r.split(" ")[1]!.startsWith("/system/"))).toEqual(["GET /docs", "GET /health", "GET /openapi.json"]);
  });

  it("registers an entity route only for the methods its gate checks (GET, POST, PUT): a PATCH or DELETE route would skip the gate", () => {
    for (const r of registered.filter((x) => x.split(" ")[1]!.startsWith("/v1/entities/"))) expect(["GET", "POST", "PUT"]).toContain(r.split(" ")[0]!);
  });

  it("answers GET only on the system paths (the read-only rule)", () => {
    for (const r of registered.filter((x) => x.split(" ")[1]!.startsWith("/system/"))) expect(r.split(" ")[0]).toBe("GET");
  });
});

// ─── Identity first ──────────────────────────────────────────────────────────

describe("no token, a bad token, or a service JWT: 401 on every user route, before the permissions are even asked", () => {
  const KID = "svc-matrix-user-routes";
  let serviceToken: string;
  beforeAll(async () => {
    const pair = await generateKeyPair("RS256", { extractable: true });
    serviceToken = await new SignJWT({ scope: REFERENCE_READ_SCOPE })
      .setProtectedHeader({ alg: "RS256", kid: KID })
      .setIssuedAt()
      .setIssuer(TEST_ISSUER)
      .setAudience(TEST_SERVICE_AUDIENCE)
      .setSubject("system:refund-api")
      .setExpirationTime("5m")
      .sign(pair.privateKey);
  });

  for (const route of USER_ROUTES) {
    it(`${route.method} ${route.template}`, async () => {
      const before = await snapshot();
      const calls = harness.resolveCallCount();
      for (const authorization of [null, "", "Bearer", "Bearer ", "Basic abc", "Bearer not.a.jwt", `Bearer ${serviceToken}`, `bearer ${serviceToken}`]) {
        for (const entity of route.level === "any" ? ["-"] : ENTITY_IDS) {
          const r = await send(route, entity, { authorization });
          expect([authorization, entity, r.status]).toEqual([authorization, entity, 401]);
          expectProblemOnly(r);
        }
      }
      expect(harness.resolveCallCount()).toBe(calls);
      expect(await snapshot()).toEqual(before);
    });
  }

  it("a token whose subject is the service principal, in the USER audience, is a user with no grant (403), not a service", async () => {
    // The `sub` is only an identifier on a user route; what makes a service is the service audience, which a user route never accepts.
    const principal: Persona = { sub: "system:refund-api", entity: null, permissions: [] };
    const r = await call("GET", "/v1/entities/welld_ch/ledger-accounts", { as: principal });
    expect([r.status, r.body["code"]]).toEqual([403, "accounting_forbidden"]);
  });
});

// ─── No grant ────────────────────────────────────────────────────────────────

describe("a caller with no grant that covers anything gets 403 accounting_forbidden and no data (AC-3.6)", () => {
  for (const route of USER_ROUTES) {
    it(`${route.method} ${route.template}`, async () => {
      const before = await snapshot();
      const entities = route.level === "any" ? ["-"] : [...ENTITY_IDS, ...NO_SUCH_ENTITY];
      for (const persona of NO_COVERAGE) {
        const replies: Reply[] = [];
        for (const entity of entities) {
          // A well-formed body and a broken one: the gate answers before the body is read, so there is no validation oracle.
          for (const o of route.method === "GET" ? [{}] : [{}, { raw: BROKEN_BODY }]) {
            const r = await send(route, entity, { as: persona, ...o });
            expect([persona.sub, entity, r.status, r.body["code"]]).toEqual([persona.sub, entity, 403, "accounting_forbidden"]);
            expectProblemOnly(r);
            replies.push(r);
          }
        }
        // One answer for every path: it does not say which entity was asked, nor whether it exists.
        const baseline = replies[0]!;
        for (const r of replies) expect({ ...r.body, instance: "" }).toEqual({ ...baseline.body, instance: "" });
      }
      expect(await snapshot()).toEqual(before);
    });
  }

  it("a HEAD of a read route is refused the same way, with no body", async () => {
    for (const route of READ_ROUTES) {
      const r = await call("HEAD", route.path("welld_ch"), { as: PERSONAS.outsider });
      expect([route.template, r.status, r.text]).toEqual([route.template, 403, ""]);
    }
  });

  it("an unauthorised caller learns nothing from a path under an entity that no route answers", async () => {
    for (const path of ["/v1/entities/welld_ch/ledger-accounts/5901", "/v1/entities/welld_ch/ledger-accounts/5901/delete", "/v1/entities/welld_ch/vat-codes/IMP81/rate", "/v1/entities/welld_ch/exchange-rates/2026-01"]) {
      for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
        const r = await call(method, path, { as: PERSONAS.outsider });
        expect([path, method, r.status === 403 || r.status === 404]).toEqual([path, method, true]);
        expectProblemOnly(r);
      }
    }
  });
});

// ─── Entity crossing ─────────────────────────────────────────────────────────

describe("an entity outside the caller's coverage is 404 not_found, the same as one that does not exist (AC-3.5)", () => {
  const CROSSING: readonly { readonly name: string; readonly persona: Persona; readonly entity: EntityId }[] = [
    { name: "the WellD Italia accounting user on WellD CH", persona: PERSONAS.accountingIt, entity: "welld_ch" },
    { name: "the WellD CH accounting user on WellD Italia", persona: PERSONAS.accountingCh, entity: "welld_it" },
    { name: "a WellD CH reader on WellD Italia (a write too: 404, not 403)", persona: PERSONAS.readerCh, entity: "welld_it" },
    { name: "a WellD Italia reader on WellD CH", persona: READER_IT, entity: "welld_ch" },
    { name: "a WellD CH manage-only holder on WellD Italia", persona: PERSONAS.managerOnlyCh, entity: "welld_it" },
  ];

  for (const route of ENTITY_ROUTES) {
    it(`${route.method} ${route.template}`, async () => {
      const before = await snapshot();
      for (const { name, persona, entity } of CROSSING) {
        for (const o of route.method === "GET" ? [{}] : [{}, { raw: BROKEN_BODY }]) {
          const crossed = await send(route, entity, { as: persona, ...o });
          expect([name, crossed.status, crossed.body["code"]]).toEqual([name, 404, "not_found"]);
          expectProblemOnly(crossed);
          // Byte for byte what an entity that does not exist answers the same caller.
          for (const nothing of NO_SUCH_ENTITY) {
            const missing = await send(route, nothing, { as: persona, ...o });
            expect([name, nothing, missing.status]).toEqual([name, nothing, 404]);
            expect(shape(missing, nothing)).toEqual(shape(crossed, entity));
          }
        }
      }
      expect(await snapshot()).toEqual(before);
    });
  }

  it("a caller who covers both entities for reading but manages one: a write on the other is 403 manage_required, nothing written", async () => {
    const before = await snapshot();
    for (const route of WRITE_ROUTES) {
      const refused = await send(route, "welld_ch", { as: READS_BOTH_MANAGES_IT });
      expect([route.template, refused.status, refused.body["code"]]).toEqual([route.template, 403, "accounting_manage_required"]);
      expectProblemOnly(refused);
    }
    expect(await snapshot()).toEqual(before);
    // The same caller reads WellD CH, and writes WellD Italia.
    for (const route of READ_ROUTES) expect((await send(route, "welld_ch", { as: READS_BOTH_MANAGES_IT })).status).toBe(200);
    const created = await send(WRITE_ROUTES[0]!, "welld_it", { as: READS_BOTH_MANAGES_IT });
    expect(created.status).toBe(201);
    expect(await db.ledgerAccount.count({ where: { entity: "welld_ch", number: "7001" } })).toBe(0);
  });

  it("the controls: the caller who covers the entity gets the route's own answer, so the 404s above are the gate's and not a dead route", async () => {
    for (const route of ENTITY_ROUTES) {
      for (const entity of ENTITY_IDS) {
        await truncateAccountingTables();
        await seed();
        const r = await send(route, entity, { as: OWNER[entity] });
        expect([route.method, route.template, entity, r.status]).toEqual([route.method, route.template, entity, route.ok(entity)]);
      }
    }
  });

  it("a list answers only the caller's own entity: the other one's names never appear", async () => {
    for (const route of READ_ROUTES.filter((r) => r.template.endsWith("ledger-accounts") || r.template.endsWith("vat-codes"))) {
      for (const entity of ENTITY_IDS) {
        const r = await send(route, entity, { as: OWNER[entity] });
        expect(r.text).toContain(MARK(entity));
        expect(r.text).not.toContain(MARK(otherOf(entity)));
      }
    }
  });
});

// ─── Reader writes ───────────────────────────────────────────────────────────

describe("a reader who writes gets 403 accounting_manage_required and nothing is written (AC-3.4)", () => {
  for (const route of WRITE_ROUTES) {
    it(`${route.method} ${route.template}`, async () => {
      for (const entity of ENTITY_IDS) {
        const before = await snapshot();
        for (const o of [{}, { raw: BROKEN_BODY }, { raw: "" }]) {
          const r = await send(route, entity, { as: READER[entity], ...o });
          expect([entity, r.status, r.body["code"]]).toEqual([entity, 403, "accounting_manage_required"]);
          expectProblemOnly(r);
        }
        expect(await snapshot()).toEqual(before);
        // The same reader reads what it may not change.
        for (const read of READ_ROUTES) expect((await send(read, entity, { as: READER[entity] })).status).toBe(200);
      }
    });
  }

  it("`manage` alone covers read, and the reader of one entity cannot write the other (404 first)", async () => {
    for (const route of READ_ROUTES) expect((await send(route, "welld_ch", { as: PERSONAS.managerOnlyCh })).status).toBe(200);
    expect((await send(WRITE_ROUTES[0]!, "welld_ch", { as: PERSONAS.managerOnlyCh })).status).toBe(201);
    expect((await send(WRITE_ROUTES[0]!, "welld_it", { as: READER["welld_ch"] })).status).toBe(404);
  });
});

// ─── The system routes ───────────────────────────────────────────────────────

describe("system routes: only the service principal, and a user JWT is never one (AC-3.8)", () => {
  const KID = "svc-matrix-test";
  let signingKey: CryptoKey;
  let foreignKey: CryptoKey;
  let previousJwks: ReturnType<typeof __setDefaultJwksForTests>;

  beforeAll(async () => {
    const pair = await generateKeyPair("RS256", { extractable: true });
    signingKey = pair.privateKey;
    foreignKey = (await generateKeyPair("RS256", { extractable: true })).privateKey;
    const jwk = await exportJWK(pair.publicKey);
    previousJwks = __setDefaultJwksForTests(createLocalJWKSet({ keys: [{ ...jwk, kid: KID, alg: "RS256", use: "sig" }] }));
  });
  afterAll(() => {
    __setDefaultJwksForTests(previousJwks);
  });

  interface Claims {
    readonly sub?: string | null;
    readonly scope?: unknown;
    readonly aud?: string | readonly string[] | null;
    readonly iss?: string | null;
    readonly exp?: string | number | null;
    readonly nbf?: number;
    readonly key?: CryptoKey;
  }

  /** A signed service JWT (valid by default); `null` drops a claim, `scope: null` drops the scope. */
  const serviceJwt = (c: Claims = {}): Promise<string> => {
    const payload: Record<string, unknown> = {};
    if (c.scope !== null) payload["scope"] = c.scope === undefined ? REFERENCE_READ_SCOPE : c.scope;
    const jwt = new SignJWT(payload).setProtectedHeader({ alg: "RS256", kid: KID }).setIssuedAt();
    if (c.iss !== null) jwt.setIssuer(c.iss ?? TEST_ISSUER);
    if (c.sub !== null) jwt.setSubject(c.sub ?? "system:refund-api");
    if (c.aud !== null) jwt.setAudience((c.aud ?? TEST_SERVICE_AUDIENCE) as string | string[]);
    if (c.exp !== null) jwt.setExpirationTime(c.exp ?? "5m");
    if (c.nbf !== undefined) jwt.setNotBefore(c.nbf);
    return jwt.sign(c.key ?? signingKey);
  };
  const bearer = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });
  const get = async (path: string, headers: Record<string, string>): Promise<Reply> => {
    const res = await app.request(path, { method: "GET", headers });
    const text = await res.text();
    let body: Record<string, any> = {};
    try {
      body = text ? (JSON.parse(text) as Record<string, any>) : {};
    } catch {
      body = {};
    }
    return { status: res.status, text, body, headers: res.headers };
  };

  const now = () => Math.floor(Date.now() / 1000);
  const rejected: Record<string, () => Promise<Record<string, string>>> = {
    // The user side of the boundary.
    "a user token of an administrator": async () => bearer(await harness.signToken({ sub: PERSONAS.admin.sub, email: "admin@welld.ch" })),
    "a user token whose subject is the service principal": async () => bearer(await harness.signToken({ sub: "system:refund-api", email: "x@welld.ch" })),
    "a service-shaped token in the user audience (right key, right scope, right sub)": async () => bearer(await serviceJwt({ aud: TEST_AUDIENCE })),
    "a token for both audiences' names but not the service one": async () => bearer(await serviceJwt({ aud: [TEST_AUDIENCE, "operai-other"] })),
    // The algorithm.
    "alg none": async () =>
      bearer(new UnsecuredJWT({ scope: REFERENCE_READ_SCOPE }).setIssuer(TEST_ISSUER).setSubject("system:refund-api").setAudience(TEST_SERVICE_AUDIENCE).setExpirationTime("5m").encode()),
    "HS256 with a shared secret": async () =>
      bearer(
        await new SignJWT({ scope: REFERENCE_READ_SCOPE })
          .setProtectedHeader({ alg: "HS256", kid: KID })
          .setIssuer(TEST_ISSUER)
          .setSubject("system:refund-api")
          .setAudience(TEST_SERVICE_AUDIENCE)
          .setExpirationTime("5m")
          .sign(new TextEncoder().encode("a-secret-of-at-least-thirty-two-bytes!")),
      ),
    "a key that is not the suite's": async () => bearer(await serviceJwt({ key: foreignKey })),
    // The principal.
    "a sub with a trailing space": async () => bearer(await serviceJwt({ sub: "system:refund-api " })),
    "a sub with a leading space": async () => bearer(await serviceJwt({ sub: " system:refund-api" })),
    "a sub with a newline": async () => bearer(await serviceJwt({ sub: "system:refund-api\n" })),
    "a longer sub": async () => bearer(await serviceJwt({ sub: "system:refund-api2" })),
    "a sub with a suffix after a colon": async () => bearer(await serviceJwt({ sub: "system:refund-api:admin" })),
    "a shorter sub": async () => bearer(await serviceJwt({ sub: "system:refund" })),
    "a sub with no prefix": async () => bearer(await serviceJwt({ sub: "refund-api" })),
    "another case": async () => bearer(await serviceJwt({ sub: "system:Refund-api" })),
    "another service": async () => bearer(await serviceJwt({ sub: "system:crm-api" })),
    "a sub with a NUL": async () => bearer(await serviceJwt({ sub: "system:refund-api\u0000" })),
    "no sub": async () => bearer(await serviceJwt({ sub: null })),
    // The scope.
    "no scope": async () => bearer(await serviceJwt({ scope: null })),
    "an empty scope": async () => bearer(await serviceJwt({ scope: "" })),
    "a blank scope": async () => bearer(await serviceJwt({ scope: " " })),
    "the scope with a dot after it": async () => bearer(await serviceJwt({ scope: "accounting.reference.read." })),
    "the scope in another case": async () => bearer(await serviceJwt({ scope: "Accounting.Reference.Read" })),
    "a prefix of the scope": async () => bearer(await serviceJwt({ scope: "accounting.reference" })),
    "the scope with a longer last word": async () => bearer(await serviceJwt({ scope: "accounting.reference.reader" })),
    "the scope joined to another by a tab": async () => bearer(await serviceJwt({ scope: "accounting.reference.read\tcrm.read" })),
    "the scope as a list instead of a string": async () => bearer(await serviceJwt({ scope: [REFERENCE_READ_SCOPE] })),
    "the scope as a number": async () => bearer(await serviceJwt({ scope: 1 })),
    // The time and the rest of the claims.
    "an expired token": async () => bearer(await serviceJwt({ exp: now() - 120 })),
    "a token that expires at issue": async () => bearer(await serviceJwt({ exp: now() })),
    "a token with no expiry": async () => bearer(await serviceJwt({ exp: null })),
    "a token not valid yet": async () => bearer(await serviceJwt({ nbf: now() + 3600 })),
    "no issuer": async () => bearer(await serviceJwt({ iss: null })),
    "another issuer": async () => bearer(await serviceJwt({ iss: `${TEST_ISSUER}.evil.example` })),
    "no audience": async () => bearer(await serviceJwt({ aud: null })),
    "the audience as a different case": async () => bearer(await serviceJwt({ aud: TEST_SERVICE_AUDIENCE.toUpperCase() })),
    // The header.
    "no header": async () => ({}),
    "the scheme in lower case": async () => ({ Authorization: `bearer ${await serviceJwt()}` }),
    "two spaces after the scheme": async () => ({ Authorization: `Bearer  ${await serviceJwt()}` }),
    "the token after a comma": async () => ({ Authorization: `Bearer x, Bearer ${await serviceJwt()}` }),
    "the token in a cookie": async () => ({ Cookie: `access_token=${await serviceJwt()}` }),
    "the token in another header": async () => ({ "X-Access-Token": await serviceJwt() }),
  };

  for (const route of SYSTEM_ROUTES) {
    it(`${route.template}: every credential that is not the principal gets the same 401, and nothing is read, fetched or written`, async () => {
      const before = await snapshot();
      const calls = harness.resolveCallCount();
      const path = route.path();
      const replies: [string, Reply][] = [];
      for (const [name, headers] of Object.entries(rejected)) replies.push([name, await get(path, await headers())]);
      const first = replies[0]![1];
      for (const [name, reply] of replies) {
        expect([name, reply.status]).toEqual([name, 401]);
        expect([name, reply.text]).toEqual([name, first.text]);
        expect([name, reply.headers.get("cache-control"), reply.headers.get("content-type")]).toEqual([name, "no-store", first.headers.get("content-type")]);
      }
      expect(first.body).toEqual({ type: "https://httpstatuses.com/401", title: "Unauthorized", status: 401, detail: "Valid credentials are required", instance: path.split("?")[0] });
      // The user side never ran: no permissions were asked for.
      expect(harness.resolveCallCount()).toBe(calls);
      expect(await snapshot()).toEqual(before);
    });

    it(`${route.template}: the credential is checked before the entity and the query, so a bad one never learns whether either is valid`, async () => {
      const good = await get(route.path(), {});
      for (const path of [route.path("welld_xx"), route.path("__proto__"), route.path().split("?")[0]! + "?pairs=nonsense", route.path().split("?")[0]!]) {
        const r = await get(path, bearer(await serviceJwt({ sub: "system:crm-api" })));
        expect([path, r.status]).toEqual([path, 401]);
        expect(r.body["detail"]).toBe(good.body["detail"]);
      }
    });
  }

  it("the controls: the principal, with its scope alone or among others, is let in on both routes", async () => {
    for (const scope of [REFERENCE_READ_SCOPE, `openid ${REFERENCE_READ_SCOPE}`, `${REFERENCE_READ_SCOPE} other.scope`, `a  ${REFERENCE_READ_SCOPE}`]) {
      for (const route of SYSTEM_ROUTES) {
        const r = await get(route.path(), bearer(await serviceJwt({ scope })));
        expect([scope, route.template, r.status]).toEqual([scope, route.template, 200]);
      }
    }
    // An audience list that names the service audience is a service token (jose's rule), and only auth mints tokens.
    expect((await get(SYSTEM_ROUTES[0].path(), bearer(await serviceJwt({ aud: [TEST_SERVICE_AUDIENCE, "operai-other"] })))).status).toBe(200);
  });

  it("a user JWT is refused on every system route, whoever holds it, and the service JWT is refused on every user route", async () => {
    const admin = await harness.signToken({ sub: PERSONAS.admin.sub, email: "admin@welld.ch" });
    const service = await serviceJwt();
    for (const route of SYSTEM_ROUTES) expect((await get(route.path(), bearer(admin))).status).toBe(401);
    for (const route of USER_ROUTES) {
      const r = await send(route, "welld_ch", { authorization: `Bearer ${service}` });
      expect([route.template, r.status]).toEqual([route.template, 401]);
    }
  });

  it("the service principal and the trigger are derived from the credential: nothing the caller sends changes them (ADR on-demand outbound work)", async () => {
    const source = fakeSource();
    const fx = new OpenAPIHono({ defaultHook: validationHook });
    fx.route("/", referenceDataRouter);
    fx.route("/", createSystemRatesRouter(createRatesService({ mode: "bazg", fetcher: source.fetcher, now: () => new Date("2026-11-19T10:00:00.000Z") })));
    fx.onError((err, c) => handleProblemError(err, c.req.path) ?? problem({ status: 500, detail: "unexpected" }, c.req.path));
    const res = await fx.request("/system/v1/entities/welld_ch/rates?pairs=EUR:2026-03&trigger=manager&actor=user-admin&actorUserId=user-admin&userId=user-admin", {
      headers: {
        ...bearer(await serviceJwt()),
        "X-Trigger": "manager",
        "X-Actor": "user-admin",
        "X-User-Id": "user-admin",
        "X-Forwarded-User": "user-admin",
      },
    });
    expect(res.status).toBe(200);
    const attempts = await db.exchangeRateFetchAttempt.findMany();
    expect(attempts.map((a) => [a.trigger, a.actorUserId, a.outcome])).toEqual([["consumer", "system:refund-api", "ok"]]);
  });
});

describe("a manager's fetch is a manager's whatever the request says", () => {
  it("POST /fetch records the trigger `manager` and the caller's own id, and a `trigger` anywhere is refused or ignored, never obeyed", async () => {
    const source = fakeSource();
    const fx = new OpenAPIHono({ defaultHook: validationHook });
    fx.route("/", createRatesRouter(createRatesService({ mode: "bazg", fetcher: source.fetcher, now: () => new Date("2026-11-19T10:00:00.000Z") })));
    fx.onError((err, c) => handleProblemError(err, c.req.path) ?? problem({ status: 500, detail: "unexpected" }, c.req.path));
    __resetAuthzCacheForTests();
    harness.setResolve(fakeResolve(PERSONAS.accountingCh));
    const token = await harness.signToken({ sub: PERSONAS.accountingCh.sub, email: "ch@welld.ch" });
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-Trigger": "consumer", "X-Actor": "system:refund-api" };

    const smuggled = await fx.request("/v1/entities/welld_ch/exchange-rates/fetch", { method: "POST", headers, body: JSON.stringify({ trigger: "consumer", months: ["2026-03"] }) });
    expect(smuggled.status).toBe(422);
    expect(await db.exchangeRateFetchAttempt.count()).toBe(0);

    const queried = await fx.request("/v1/entities/welld_ch/exchange-rates/fetch?trigger=consumer&actor=system:refund-api", { method: "POST", headers, body: JSON.stringify({ months: ["2026-03"] }) });
    expect(queried.status).toBe(200);
    const attempts = await db.exchangeRateFetchAttempt.findMany();
    expect(attempts.map((a) => [a.trigger, a.actorUserId, a.outcome])).toEqual([["manager", PERSONAS.accountingCh.sub, "ok"]]);
  });
});

// ─── Concurrency ─────────────────────────────────────────────────────────────

describe("concurrency", () => {
  /** A resolver that answers the grants of whoever the token names, so callers of different grants can share one instant. */
  const byToken = async (authorizationHeader: string) => {
    const sub = decodeJwt(authorizationHeader.slice("Bearer ".length)).sub!;
    return resolveBodyFor(BY_SUB.get(sub)!);
  };
  const expected = (persona: Persona, entity: EntityId, level: "read" | "manage"): number => {
    if (persona.permissions.length === 0 || persona === PERSONAS.noEntity || persona === PERSONAS.unknownCondition) return 403;
    const reads = persona === PERSONAS.admin || persona === READS_BOTH_MANAGES_IT || OWNER[entity] === persona || READER[entity] === persona || persona === PERSONAS.managerOnlyCh && entity === "welld_ch";
    if (!reads) return 404;
    if (level === "read") return 200;
    const manages = persona === PERSONAS.admin || OWNER[entity] === persona || (persona === READS_BOTH_MANAGES_IT && entity === "welld_it") || (persona === PERSONAS.managerOnlyCh && entity === "welld_ch");
    return manages ? 201 : 403;
  };

  it("callers of different grants asking at the same instant each get their own answer: the (sub, epoch) cache never lends one's grants to another", async () => {
    harness.setResolve(byToken);
    __resetAuthzCacheForTests();
    const personas = [PERSONAS.accountingCh, PERSONAS.accountingIt, PERSONAS.readerCh, READER_IT, PERSONAS.outsider, PERSONAS.admin, READS_BOTH_MANAGES_IT, PERSONAS.managerOnlyCh, PERSONAS.noEntity];
    const jobs: { persona: Persona; entity: EntityId }[] = [];
    for (let round = 0; round < 5; round++) for (const persona of personas) for (const entity of ENTITY_IDS) jobs.push({ persona, entity });
    // A fixed shuffle: neighbours in the queue are never the same caller.
    jobs.sort((a, b) => ((a.persona.sub + a.entity).length * 7919) % 31 - ((b.persona.sub + b.entity).length * 7919) % 31);
    const route = READ_ROUTES[0]!;
    const replies = await Promise.all(jobs.map((job) => send(route, job.entity, { as: job.persona, keepAuthz: true })));
    replies.forEach((r, i) => {
      const { persona, entity } = jobs[i]!;
      expect([persona.sub, entity, r.status]).toEqual([persona.sub, entity, expected(persona, entity, "read")]);
      if (r.status === 200) {
        expect(r.text).toContain(MARK(entity));
        expect(r.text).not.toContain(MARK(otherOf(entity)));
      } else expectProblemOnly(r);
    });
  });

  it("the same racing write from every kind of caller: one row per entity, written by the one who may, and every other refused", async () => {
    harness.setResolve(byToken);
    __resetAuthzCacheForTests();
    const route = WRITE_ROUTES[0]!; // POST ledger-accounts { number: "7001" }
    const jobs: { persona: Persona; entity: EntityId }[] = [];
    for (let i = 0; i < 4; i++) {
      for (const entity of ENTITY_IDS) {
        jobs.push({ persona: OWNER[entity], entity }, { persona: READER[entity], entity }, { persona: OWNER[otherOf(entity)], entity }, { persona: PERSONAS.outsider, entity });
      }
    }
    const replies = await Promise.all(jobs.map((job) => send(route, job.entity, { as: job.persona, keepAuthz: true })));
    const created: string[] = [];
    replies.forEach((r, i) => {
      const { persona, entity } = jobs[i]!;
      if (persona === OWNER[entity]) {
        expect([persona.sub, entity, [201, 409].includes(r.status)]).toEqual([persona.sub, entity, true]);
        if (r.status === 201) created.push(entity);
      } else expect([persona.sub, entity, r.status]).toEqual([persona.sub, entity, expected(persona, entity, "manage")]);
    });
    expect(created.sort()).toEqual(["welld_ch", "welld_it"]);
    for (const entity of ENTITY_IDS) expect(await db.ledgerAccount.count({ where: { entity, number: "7001" } })).toBe(1);
  });

  describe("the rates fetch is single-flight across callers and routes (AC-2.10)", () => {
    const NOW = new Date("2026-11-19T10:00:00.000Z");
    const slow = (status = 200) => fakeSource(async (month) => {
      await Bun.sleep(150);
      return status === 200 ? new Response(xmlFor(month)) : new Response("no", { status });
    });

    function fxApp(source: ReturnType<typeof fakeSource>) {
      const service = createRatesService({ mode: "bazg", fetcher: source.fetcher, now: () => NOW });
      const fx = new OpenAPIHono({ defaultHook: validationHook });
      fx.route("/", createRatesRouter(service, () => NOW));
      fx.route("/", createSystemRatesRouter(service));
      fx.onError((err, c) => handleProblemError(err, c.req.path) ?? problem({ status: 500, detail: "unexpected" }, c.req.path));
      return fx;
    }

    let signingKey: CryptoKey;
    let previousJwks: ReturnType<typeof __setDefaultJwksForTests>;
    beforeAll(async () => {
      const pair = await generateKeyPair("RS256", { extractable: true });
      signingKey = pair.privateKey;
      const jwk = await exportJWK(pair.publicKey);
      previousJwks = __setDefaultJwksForTests(createLocalJWKSet({ keys: [{ ...jwk, kid: "svc-matrix-flight", alg: "RS256", use: "sig" }] }));
    });
    afterAll(() => {
      __setDefaultJwksForTests(previousJwks);
    });
    const serviceToken = () =>
      new SignJWT({ scope: REFERENCE_READ_SCOPE })
        .setProtectedHeader({ alg: "RS256", kid: "svc-matrix-flight" })
        .setIssuedAt()
        .setIssuer(TEST_ISSUER)
        .setAudience(TEST_SERVICE_AUDIENCE)
        .setSubject("system:refund-api")
        .setExpirationTime("5m")
        .sign(signingKey);

    async function managerFetch(fx: ReturnType<typeof fxApp>, months: string[]) {
      harness.setResolve(byToken);
      const token = await harness.signToken({ sub: PERSONAS.accountingCh.sub, email: "ch@welld.ch" });
      return fx.request("/v1/entities/welld_ch/exchange-rates/fetch", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ months }),
      });
    }

    it("a dozen consumers and two managers asking for the same missing month make ONE call to the source and record one attempt and one rate per currency", async () => {
      const source = slow();
      const fx = fxApp(source);
      const token = await serviceToken();
      const consumer = () => fx.request("/system/v1/entities/welld_ch/rates?pairs=EUR:2026-03,USD:2026-03,GBP:2026-03", { headers: { Authorization: `Bearer ${token}` } });
      __resetAuthzCacheForTests();
      const replies = await Promise.all([
        ...Array.from({ length: 12 }, consumer),
        managerFetch(fx, ["2026-03"]),
        managerFetch(fx, ["2026-03"]),
      ]);
      expect(replies.map((r) => r.status)).toEqual(Array(14).fill(200));
      expect(source.urls).toHaveLength(1);
      for (const reply of replies.slice(0, 12)) {
        const body = (await reply.json()) as { rates: { status: string; origin?: string; rateMicros?: number }[] };
        expect(body.rates.map((r) => [r.status, r.origin, r.rateMicros])).toEqual([["in_effect", "fetched", 924600], ["in_effect", "fetched", 780800], ["in_effect", "fetched", 1063500]]);
      }
      expect(await db.exchangeRateFetchAttempt.count()).toBe(1);
      expect((await db.exchangeRateEntry.findMany()).map((e) => `${e.currency}:${e.origin}`).sort()).toEqual(["EUR:fetched", "GBP:fetched", "USD:fetched"]);
    });

    it("a failing source is asked once for a dozen consumers; each is told `missing`, none is told a rate, and one failure is logged", async () => {
      const source = slow(503);
      const fx = fxApp(source);
      const token = await serviceToken();
      const replies = await Promise.all(Array.from({ length: 12 }, () => fx.request("/system/v1/entities/welld_ch/rates?pairs=EUR:2026-03", { headers: { Authorization: `Bearer ${token}` } })));
      expect(replies.map((r) => r.status)).toEqual(Array(12).fill(200));
      for (const reply of replies) {
        const body = (await reply.json()) as { rates: { status: string; reason?: string }[] };
        expect(body.rates.map((r) => [r.status, r.reason])).toEqual([["missing", "fetch_failed"]]);
      }
      expect(source.urls).toHaveLength(1);
      expect((await db.exchangeRateFetchAttempt.findMany()).map((a) => [a.trigger, a.outcome, a.errorCode])).toEqual([["consumer", "failed", "http_503"]]);
      expect(await db.exchangeRateEntry.count()).toBe(0);
    });

    it("two entities asked at once do not share a flight: the entity with no source is refused 422 and attempts nothing", async () => {
      const source = slow();
      const fx = fxApp(source);
      const token = await serviceToken();
      const [ch, it] = await Promise.all([
        fx.request("/system/v1/entities/welld_ch/rates?pairs=EUR:2026-03", { headers: { Authorization: `Bearer ${token}` } }),
        fx.request("/system/v1/entities/welld_it/rates?pairs=EUR:2026-03", { headers: { Authorization: `Bearer ${token}` } }),
      ]);
      expect([ch.status, it.status]).toEqual([200, 422]);
      expect(source.urls).toHaveLength(1);
      expect(await db.exchangeRateFetchAttempt.count({ where: { entity: "welld_it" } })).toBe(0);
      expect(await db.exchangeRateEntry.count({ where: { entity: "welld_it" } })).toBe(0);
    });
  });
});
