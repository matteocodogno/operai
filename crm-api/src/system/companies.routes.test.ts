/**
 * GET /system/companies (specs/021-projects T2 — AC-1.1, AC-1.4, AC-2.2; ADR-0059):
 * CRM companies read service-to-service by projects-api with a scoped service
 * credential (`crm.companies.read`). Real Postgres (compose, `crm` database); the
 * JWKS is an in-memory one injected into the middleware, so no live `auth` is needed.
 *
 * The credential matrix: every failure — no token, a user JWT, another scope,
 * another audience, a non-service `sub`, an expired or malformed token, a
 * missing SERVICE_AUDIENCE — answers the SAME 401, byte for byte.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { TEST_AUDIENCE, TEST_ISSUER } from "../test-support/testAuth";

const { db } = await import("../lib/db");
const { createSystemAuthMiddleware } = await import("./systemAuth.middleware");
const { createSystemCompaniesRouter } = await import("./companies.routes");

const SERVICE_AUD = "operai-system-test";
const KID = "svc-companies-kid";
const RUN = crypto.randomUUID().slice(0, 8);
const PREFIX = `svc-co-${RUN}`;
const URL_PATH = "/system/companies";

let signingKey: CryptoKey;
let app: Hono;
let noAudienceApp: Hono;

const serviceJwt = (
  o: { sub?: string; scope?: string | null; aud?: string; exp?: string | number } = {},
): Promise<string> => {
  const claims: Record<string, unknown> = {};
  if (o.scope !== null) claims["scope"] = o.scope ?? "crm.companies.read";
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setIssuedAt()
    .setIssuer(TEST_ISSUER)
    .setAudience(o.aud ?? SERVICE_AUD)
    .setSubject(o.sub ?? "system:projects-api")
    .setExpirationTime(o.exp ?? "5m")
    .sign(signingKey);
};

const get = (query = "", token?: string, target: Hono = app) =>
  target.request(`${URL_PATH}${query}`, token ? { headers: { Authorization: `Bearer ${token}` } } : {});

interface Item {
  id: string;
  name: string;
  entity: string;
  archived: boolean;
}
const items = async (res: Response): Promise<Item[]> => ((await res.json()) as { items: Item[] }).items;

const make = (name: string, extra: { archived?: boolean; entity?: "welld_ch" | "welld_it" } = {}) =>
  db.company.create({
    data: {
      name: `${PREFIX} ${name}`,
      status: "prospect",
      entity: extra.entity ?? "welld_ch",
      ownerUserId: "user-owner",
      createdBy: "user-owner",
      updatedBy: "user-owner",
      archivedAt: extra.archived ? new Date() : null,
    },
  });

const cleanup = () => db.company.deleteMany({ where: { name: { startsWith: PREFIX } } });

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  signingKey = pair.privateKey;
  const jwks = createLocalJWKSet({
    keys: [{ ...(await exportJWK(pair.publicKey)), kid: KID, alg: "RS256", use: "sig" }],
  });
  app = new Hono();
  app.route(
    "/",
    createSystemCompaniesRouter(
      createSystemAuthMiddleware({ scope: "crm.companies.read", jwks, audience: SERVICE_AUD }),
    ),
  );
  noAudienceApp = new Hono();
  noAudienceApp.route(
    "/",
    createSystemCompaniesRouter(
      createSystemAuthMiddleware({ scope: "crm.companies.read", jwks, audience: undefined }),
    ),
  );
  await cleanup();
});

afterAll(cleanup);

describe("GET /system/companies — a scoped service credential", () => {
  it("200 { items: [{ id, name, entity, archived }] } and nothing else per item", async () => {
    const acme = await make("Acme", { entity: "welld_it" });
    const res = await get(`?q=${PREFIX}%20Acme`, await serviceJwt());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      items: [{ id: acme.id, name: `${PREFIX} Acme`, entity: "welld_it", archived: false }],
    });
  });
});

describe("GET /system/companies — the credential (every failure is the same 401)", () => {
  it("no token, a user JWT, another scope, another audience, a non-service sub, expired, malformed: one identical body", async () => {
    const userJwt = await serviceJwt({ sub: "user-1", aud: TEST_AUDIENCE, scope: null });
    const failures: Array<[string, Response]> = [
      ["no token", await get()],
      ["a user JWT", await get("", userJwt)],
      ["a user JWT with the scope claim", await get("", await serviceJwt({ sub: "user-1", aud: TEST_AUDIENCE }))],
      ["another scope", await get("", await serviceJwt({ scope: "notifications.push" }))],
      ["no scope claim", await get("", await serviceJwt({ scope: null }))],
      ["a scope that only contains ours", await get("", await serviceJwt({ scope: "crm.companies.read.extra" }))],
      ["another audience", await get("", await serviceJwt({ aud: "someone-else" }))],
      ["a sub that is not a service principal", await get("", await serviceJwt({ sub: "projects-api" }))],
      ["an empty service sub", await get("", await serviceJwt({ sub: "system:" }))],
      ["an expired token", await get("", await serviceJwt({ exp: Math.floor(Date.now() / 1000) - 60 }))],
      ["a malformed token", await get("", "not-a-jwt")],
    ];
    const reference = await failures[0]![1].clone().text();
    expect(JSON.parse(reference)).toMatchObject({ status: 401, instance: URL_PATH });
    for (const [label, res] of failures) {
      expect({ label, status: res.status }).toEqual({ label, status: 401 });
      expect({ label, body: await res.text() }).toEqual({ label, body: reference });
    }
  });

  it("a token carrying our scope among others is accepted", async () => {
    const res = await get("", await serviceJwt({ scope: "notifications.push crm.companies.read" }));
    expect(res.status).toBe(200);
  });

  it("fails closed when SERVICE_AUDIENCE is not configured, even for an otherwise valid token", async () => {
    const res = await get("", await serviceJwt(), noAudienceApp);
    expect(res.status).toBe(401);
  });
});

describe("GET /system/companies — q, ids, limit", () => {
  it("`q` is a case-insensitive substring of the name and never returns an archived company", async () => {
    const live = await make("Needle Live");
    await make("Needle Archived", { archived: true });
    await make("Haystack");
    const res = await get(`?q=${PREFIX.toUpperCase()}%20nEEdle`, await serviceJwt());
    expect(res.status).toBe(200);
    expect((await items(res)).map((i) => i.id)).toEqual([live.id]);
  });

  it("`ids` returns exactly those companies, archived ones included, unknown ids silently absent", async () => {
    const live = await make("Ids Live");
    const archived = await make("Ids Archived", { archived: true });
    const other = await make("Ids Other");
    const res = await get(`?ids=${live.id},${archived.id},no-such-company`, await serviceJwt());
    expect(res.status).toBe(200);
    const got = await items(res);
    expect(got.map((i) => i.id).sort()).toEqual([live.id, archived.id].sort());
    expect(got.find((i) => i.id === archived.id)?.archived).toBe(true);
    expect(got.map((i) => i.id)).not.toContain(other.id);
  });

  it("`ids` without a `limit` returns every company asked for - a page's lookup is never truncated at 20", async () => {
    const made = [];
    for (let i = 0; i < 25; i++) made.push(await make(`Page ${String(i).padStart(2, "0")}`));
    const res = await get(`?ids=${made.map((c) => c.id).join(",")}`, await serviceJwt());
    expect(await items(res)).toHaveLength(25);
    // An explicit limit still applies.
    expect(await items(await get(`?ids=${made.map((c) => c.id).join(",")}&limit=5`, await serviceJwt()))).toHaveLength(5);
  });

  it("more than 100 ids is a 400; exactly 100 is accepted", async () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `c${i}`).join(",");
    const token = await serviceJwt();
    expect((await get(`?ids=${ids(101)}`, token)).status).toBe(400);
    expect((await get(`?ids=${ids(100)}`, token)).status).toBe(200);
  });

  it("an empty entry in `ids` is a 400", async () => {
    expect((await get("?ids=a,,b", await serviceJwt())).status).toBe(400);
  });

  it("results are sorted by name; `limit` defaults to 20 and is bounded 1-50", async () => {
    for (let i = 0; i < 22; i++) await make(`Lim ${String(i).padStart(2, "0")}`);
    const token = await serviceJwt();
    const first = await items(await get(`?q=${PREFIX}%20Lim`, token));
    expect(first).toHaveLength(20);
    expect(first.map((i) => i.name)).toEqual([...first.map((i) => i.name)].sort());
    expect(first[0]!.name).toBe(`${PREFIX} Lim 00`);

    expect(await items(await get(`?q=${PREFIX}%20Lim&limit=3`, token))).toHaveLength(3);
    expect(await items(await get(`?q=${PREFIX}%20Lim&limit=50`, token))).toHaveLength(22);
    expect((await get("?limit=0", token)).status).toBe(400);
    expect((await get("?limit=51", token)).status).toBe(400);
    expect((await get("?limit=abc", token)).status).toBe(400);
  });
});

describe("GET /system/companies — mounted on the assembled app", () => {
  it("a user JWT is never accepted here, and no token is the same 401 (not a 404)", async () => {
    const { app: assembled, call } = await import("../test-support/world");
    expect(assembled.routes.some((r) => r.method === "GET" && r.path === URL_PATH)).toBe(true);
    expect((await call("GET", URL_PATH, { as: null })).status).toBe(401);
    expect((await call("GET", URL_PATH, { as: "admin" })).status).toBe(401);
  });

  it("is documented in the OpenAPI document", async () => {
    const { app: assembled } = await import("../test-support/world");
    const doc = (await (await assembled.request("/openapi.json")).json()) as { paths: Record<string, unknown> };
    expect(Object.keys(doc.paths)).toContain(URL_PATH);
  });
});
