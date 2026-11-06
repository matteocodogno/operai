/**
 * GET /system/deals (specs/022-projects-handoff T3 — AC-1.1, AC-2.1, AC-2.2, AC-2.3; ADR-0060):
 * the CRM's won deals read service-to-service by projects-api with a scoped service
 * credential (`crm.deals.read`). Real Postgres (compose, `crm` database); the JWKS is an
 * in-memory one injected into the middleware, so no live `auth` is needed.
 *
 * The deal is read live, never synced: a deal reopened in the CRM drops out of `stage=won`
 * on the next read and is back once won again. The route carries no money: no amount,
 * currency, owner or notes, ever (D14). The credential matrix is the one of
 * `companies.routes.test.ts`: every failure answers the SAME 401, byte for byte.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { TEST_AUDIENCE, TEST_ISSUER } from "../test-support/testAuth";

const { db } = await import("../lib/db");
const { createSystemAuthMiddleware } = await import("./systemAuth.middleware");
const { createSystemDealsRouter, WON_DEALS_LIMIT } = await import("./deals.routes");

const SERVICE_AUD = "operai-system-test";
const KID = "svc-deals-kid";
const RUN = crypto.randomUUID().slice(0, 8);
const PREFIX = `svc-deal-${RUN}`;
const URL_PATH = "/system/deals";
const SCOPE = "crm.deals.read";
const NOTES = `secret-notes-${RUN}`;

let signingKey: CryptoKey;
let app: Hono;
let noAudienceApp: Hono;
let companyId: string;

const serviceJwt = (
  o: { sub?: string; scope?: string | null; aud?: string; exp?: string | number } = {},
): Promise<string> => {
  const claims: Record<string, unknown> = {};
  if (o.scope !== null) claims["scope"] = o.scope ?? SCOPE;
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
  title: string;
  stage: string;
  entity: string;
  company: { id: string; name: string };
  wonAt: string | null;
  estimate: { id: string; name: string } | null;
}
interface Body {
  items: Item[];
  truncated: boolean;
}
const body = async (res: Response): Promise<Body> => (await res.json()) as Body;
/** Only the deals this file made: the database may hold others. */
const mine = (items: Item[]): Item[] => items.filter((i) => i.title.startsWith(PREFIX));

type Stage = "lead" | "qualified" | "proposal" | "negotiation" | "won" | "lost";
const day = (n: number) => new Date(Date.UTC(2099, 0, n)); // far future: the newest won deals

const makeDeal = (
  title: string,
  o: { stage?: Stage; closedAt?: Date | null; entity?: "welld_ch" | "welld_it"; estimate?: { id: string; name: string } } = {},
) => {
  const stage = o.stage ?? "won";
  return db.deal.create({
    data: {
      companyId,
      title: `${PREFIX} ${title}`,
      stage,
      amountCents: 123_456_789n,
      currency: "CHF",
      entity: o.entity ?? "welld_ch",
      ownerUserId: "user-owner",
      notes: NOTES,
      closedAt: o.closedAt === undefined ? (stage === "won" || stage === "lost" ? new Date() : null) : o.closedAt,
      createdBy: "user-owner",
      updatedBy: "user-owner",
      ...(o.estimate
        ? {
            estimate: {
              create: {
                estimateId: o.estimate.id,
                estimateName: o.estimate.name,
                technicalUserId: "user-tech",
                requestedBy: "user-owner",
              },
            },
          }
        : {}),
    },
  });
};

const cleanup = async () => {
  await db.deal.deleteMany({ where: { title: { startsWith: PREFIX } } });
  await db.company.deleteMany({ where: { name: { startsWith: PREFIX } } });
};

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  signingKey = pair.privateKey;
  const jwks = createLocalJWKSet({
    keys: [{ ...(await exportJWK(pair.publicKey)), kid: KID, alg: "RS256", use: "sig" }],
  });
  app = new Hono();
  app.route("/", createSystemDealsRouter(createSystemAuthMiddleware({ scope: SCOPE, jwks, audience: SERVICE_AUD })));
  noAudienceApp = new Hono();
  noAudienceApp.route("/", createSystemDealsRouter(createSystemAuthMiddleware({ scope: SCOPE, jwks, audience: undefined })));
  await cleanup();
  const company = await db.company.create({
    data: {
      name: `${PREFIX} Acme`,
      status: "prospect",
      entity: "welld_ch",
      ownerUserId: "user-owner",
      createdBy: "user-owner",
      updatedBy: "user-owner",
    },
  });
  companyId = company.id;
});

afterAll(cleanup);

describe("GET /system/deals?stage=won — the to-start queue's source (AC-1.1)", () => {
  it("lists only won deals, newest win first, with title, entity, company, wonAt and the estimate link", async () => {
    const oldest = await makeDeal("oldest", { closedAt: day(1) });
    const newest = await makeDeal("newest", { closedAt: day(3), estimate: { id: "est-1", name: "Acme platform" } });
    const middle = await makeDeal("middle", { closedAt: day(2), entity: "welld_it" });
    await makeDeal("lost", { stage: "lost", closedAt: day(5) });
    await makeDeal("still negotiating", { stage: "negotiation" });

    const res = await get("?stage=won", await serviceJwt());
    expect(res.status).toBe(200);
    const got = mine((await body(res)).items);
    expect(got.map((i) => i.id)).toEqual([newest.id, middle.id, oldest.id]);
    expect(got[0]).toEqual({
      id: newest.id,
      title: `${PREFIX} newest`,
      stage: "won",
      entity: "welld_ch",
      company: { id: companyId, name: `${PREFIX} Acme` },
      wonAt: day(3).toISOString(),
      estimate: { id: "est-1", name: "Acme platform" },
    });
    expect(got[1]).toMatchObject({ entity: "welld_it", estimate: null });
  });

  it("no item carries an amount, currency, owner or notes — not in the keys, not anywhere in the body (D14)", async () => {
    await makeDeal("money", { closedAt: day(4), estimate: { id: "est-m", name: "Money" } });
    const res = await get("?stage=won", await serviceJwt());
    const text = await res.clone().text();
    expect(text).not.toContain(NOTES);
    expect(text).not.toContain("123456789");
    expect(text).not.toContain("user-owner");
    for (const item of (await body(res)).items) {
      expect(Object.keys(item).sort()).toEqual(["company", "entity", "estimate", "id", "stage", "title", "wonAt"]);
      expect(Object.keys(item.company).sort()).toEqual(["id", "name"]);
    }
  });

  it("a deal reopened in the CRM drops out, and is back once won again (AC-2.1, AC-2.2)", async () => {
    const deal = await makeDeal("flapper", { closedAt: day(10) });
    const token = await serviceJwt();
    const ids = async () => mine((await body(await get("?stage=won", token))).items).map((i) => i.id);
    expect(await ids()).toContain(deal.id);

    await db.deal.update({ where: { id: deal.id }, data: { stage: "negotiation", closedAt: null } });
    expect(await ids()).not.toContain(deal.id);

    await db.deal.update({ where: { id: deal.id }, data: { stage: "won", closedAt: day(11) } });
    expect(await ids()).toContain(deal.id);
  });

  it("caps the list at 500 and says so with `truncated`, keeping the newest", async () => {
    expect(WON_DEALS_LIMIT).toBe(500);
    const first = await get("?stage=won", await serviceJwt());
    const before = await body(first);
    // Fill the database past the cap with deals older than everything else made here.
    const missing = Math.max(0, WON_DEALS_LIMIT + 1 - before.items.length);
    await db.deal.createMany({
      data: Array.from({ length: missing }, (_, i) => ({
        companyId,
        title: `${PREFIX} bulk ${String(i).padStart(4, "0")}`,
        stage: "won" as const,
        amountCents: 1n,
        currency: "CHF" as const,
        entity: "welld_ch" as const,
        ownerUserId: "user-owner",
        closedAt: day(20),
        createdBy: "user-owner",
        updatedBy: "user-owner",
      })),
    });
    const capped = await body(await get("?stage=won", await serviceJwt()));
    expect(capped.items).toHaveLength(WON_DEALS_LIMIT);
    expect(capped.truncated).toBe(true);
    // Still newest first across the whole list.
    const times = capped.items.flatMap((i) => (i.wonAt ? [i.wonAt] : []));
    expect([...times].sort().reverse()).toEqual(times);
  });

  it("`truncated` is false when every won deal fits", async () => {
    await db.deal.deleteMany({ where: { title: { startsWith: `${PREFIX} bulk` } } });
    const total = await db.deal.count({ where: { stage: "won" } });
    // Only meaningful when the rest of the database holds a handful of won deals.
    if (total > WON_DEALS_LIMIT) return;
    const res = await body(await get("?stage=won", await serviceJwt()));
    expect(res.items).toHaveLength(total);
    expect(res.truncated).toBe(false);
  });
});

describe("GET /system/deals?ids= — deals by id, in any stage", () => {
  it("returns those deals whatever their stage, `wonAt` null unless won, unknown ids silently absent (AC-2.3)", async () => {
    const won = await makeDeal("ids won", { closedAt: day(30), estimate: { id: "est-i", name: "Ids" } });
    const reopened = await makeDeal("ids reopened", { stage: "negotiation" });
    const lost = await makeDeal("ids lost", { stage: "lost", closedAt: day(31) });
    const other = await makeDeal("ids other");

    const res = await get(`?ids=${won.id},${reopened.id},${lost.id},no-such-deal`, await serviceJwt());
    expect(res.status).toBe(200);
    const got = await body(res);
    expect(got.truncated).toBe(false);
    expect(got.items.map((i) => i.id)).toEqual([won.id, reopened.id, lost.id]);
    expect(got.items.map((i) => [i.stage, i.wonAt])).toEqual([
      ["won", day(30).toISOString()],
      ["negotiation", null],
      ["lost", null],
    ]);
    expect(got.items[0]!.estimate).toEqual({ id: "est-i", name: "Ids" });
    expect(got.items.map((i) => i.id)).not.toContain(other.id);
  });

  it("a deal reopened then won again carries its new won date", async () => {
    const deal = await makeDeal("ids flapper", { closedAt: day(40) });
    const token = await serviceJwt();
    await db.deal.update({ where: { id: deal.id }, data: { stage: "proposal", closedAt: null } });
    expect((await body(await get(`?ids=${deal.id}`, token))).items[0]).toMatchObject({ stage: "proposal", wonAt: null });
    await db.deal.update({ where: { id: deal.id }, data: { stage: "won", closedAt: day(41) } });
    expect((await body(await get(`?ids=${deal.id}`, token))).items[0]).toMatchObject({
      stage: "won",
      wonAt: day(41).toISOString(),
    });
  });

  it("carries no money here either, and a repeated id is returned once", async () => {
    const deal = await makeDeal("ids money");
    const res = await get(`?ids=${deal.id},${deal.id}`, await serviceJwt());
    const text = await res.clone().text();
    expect(text).not.toContain(NOTES);
    expect(text).not.toContain("123456789");
    expect((await body(res)).items).toHaveLength(1);
  });

  it("more than 100 ids is a 400; exactly 100 is accepted", async () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `d${i}`).join(",");
    const token = await serviceJwt();
    expect((await get(`?ids=${ids(101)}`, token)).status).toBe(400);
    expect((await get(`?ids=${ids(100)}`, token)).status).toBe(200);
  });

  it("an empty entry, an empty list or an id longer than 64 characters is a 400", async () => {
    const token = await serviceJwt();
    expect((await get("?ids=a,,b", token)).status).toBe(400);
    expect((await get("?ids=", token)).status).toBe(400);
    expect((await get(`?ids=${"x".repeat(65)}`, token)).status).toBe(400);
    expect((await get(`?ids=${"x".repeat(64)}`, token)).status).toBe(200);
  });
});

describe("GET /system/deals — exactly one of stage and ids (400)", () => {
  it("neither, both, or a stage other than won is a 400 problem naming the query", async () => {
    const token = await serviceJwt();
    for (const query of ["", "?stage=won&ids=a", "?stage=lost", "?stage=", "?stage=WON", "?q=x"]) {
      const res = await get(query, token);
      expect({ query, status: res.status }).toEqual({ query, status: 400 });
      expect(await res.json()).toMatchObject({ status: 400, instance: URL_PATH });
    }
  });
});

describe("GET /system/deals — the credential (every failure is the same 401)", () => {
  it("no token, a user JWT, another scope, another audience, a non-service sub, expired, malformed: one identical body", async () => {
    const userJwt = await serviceJwt({ sub: "user-1", aud: TEST_AUDIENCE, scope: null });
    const q = "?stage=won";
    const failures: Array<[string, Response]> = [
      ["no token", await get(q)],
      ["a user JWT", await get(q, userJwt)],
      ["a user JWT with the scope claim", await get(q, await serviceJwt({ sub: "user-1", aud: TEST_AUDIENCE }))],
      ["another scope", await get(q, await serviceJwt({ scope: "crm.companies.read" }))],
      ["no scope claim", await get(q, await serviceJwt({ scope: null }))],
      ["a scope that only contains ours", await get(q, await serviceJwt({ scope: `${SCOPE}.extra` }))],
      ["another audience", await get(q, await serviceJwt({ aud: "someone-else" }))],
      ["a sub that is not a service principal", await get(q, await serviceJwt({ sub: "projects-api" }))],
      ["an empty service sub", await get(q, await serviceJwt({ sub: "system:" }))],
      ["an expired token", await get(q, await serviceJwt({ exp: Math.floor(Date.now() / 1000) - 60 }))],
      ["a malformed token", await get(q, "not-a-jwt")],
    ];
    const reference = await failures[0]![1].clone().text();
    expect(JSON.parse(reference)).toMatchObject({ status: 401, instance: URL_PATH });
    for (const [label, res] of failures) {
      expect({ label, status: res.status }).toEqual({ label, status: 401 });
      expect({ label, body: await res.text() }).toEqual({ label, body: reference });
    }
  });

  it("the credential is checked before the query: a bad token with a bad query is the 401, not a 400", async () => {
    expect((await get("")).status).toBe(401);
    expect((await get("?stage=lost", "not-a-jwt")).status).toBe(401);
  });

  it("a token carrying our scope among others is accepted", async () => {
    const res = await get("?stage=won", await serviceJwt({ scope: `crm.companies.read ${SCOPE}` }));
    expect(res.status).toBe(200);
  });

  it("the companies scope does not open this route", async () => {
    expect((await get("?stage=won", await serviceJwt({ scope: "crm.companies.read" }))).status).toBe(401);
  });

  it("fails closed when SERVICE_AUDIENCE is not configured, even for an otherwise valid token", async () => {
    const res = await get("?stage=won", await serviceJwt(), noAudienceApp);
    expect(res.status).toBe(401);
  });
});

describe("GET /system/deals — mounted on the assembled app", () => {
  it("a user JWT is never accepted here, and no token is the same 401 (not a 404)", async () => {
    const { app: assembled, call } = await import("../test-support/world");
    expect(assembled.routes.some((r) => r.method === "GET" && r.path === URL_PATH)).toBe(true);
    expect((await call("GET", `${URL_PATH}?stage=won`, { as: null })).status).toBe(401);
    expect((await call("GET", `${URL_PATH}?stage=won`, { as: "admin" })).status).toBe(401);
  });

  it("is documented in the OpenAPI document", async () => {
    const { app: assembled } = await import("../test-support/world");
    const doc = (await (await assembled.request("/openapi.json")).json()) as { paths: Record<string, unknown> };
    expect(Object.keys(doc.paths)).toContain(URL_PATH);
  });
});
