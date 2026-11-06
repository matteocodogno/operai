/**
 * GET /system/estimates/{id}/summary (specs/022 T2 — AC-3.1; ADR-0061): an estimate's
 * man-days read service-to-service by projects-api with a scoped service credential
 * (`estimai.estimates.read`). Real Postgres (compose, `estimai` database); the JWKS is an
 * in-memory one injected into the middleware, so no live `auth` is needed.
 *
 * The credential matrix: every failure — no token, a user JWT, another scope, another
 * audience, a non-service `sub`, an expired or malformed token, a missing SERVICE_AUDIENCE —
 * answers the SAME 401, byte for byte. The route reads any estimate, whoever owns it and
 * whoever collaborates on it, and returns the figure only — never the estimate's content.
 *
 * The router takes its estimate lookup as a parameter and the test hands it a Prisma client of
 * its own (the way collaborators.routes.test.ts isolates its deps): `bun test` shares one
 * module cache across files, and the `@/lib/db` singleton must not be built here.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { config as dotenvConfig } from "dotenv";
import { Hono } from "hono";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";

// env.ts validates at import. The real DATABASE_URL comes from the service's dotenv file
// (an earlier test file may have left a placeholder), the rest only has to be present.
dotenvConfig({ path: new URL("../../.env", import.meta.url).pathname, override: true });
process.env["ALLOWED_ORIGINS"] ??= "http://localhost:5173";
process.env["AUTH_JWKS_URL"] ??= "http://localhost:3001/.well-known/jwks.json";
process.env["AUTH_ISSUER"] ??= "http://localhost:3001";
process.env["AUTH_AUDIENCE"] ??= "operai-suite";
process.env["NODE_ENV"] = "test";
process.env["AUTH_BASE_URL"] ??= "http://localhost:3001";
process.env["SERVICE_CLIENT_ID"] ??= "estimai-api";
process.env["SERVICE_CLIENT_SECRET"] ??= "test-service-client-secret-at-least-32-characters";
process.env["NOTIFY_INTERNAL_URL"] ??= "http://localhost:8081";

const { env } = await import("../lib/env");
const { PrismaClient } = await import("../lib/generated/prisma/client");
const { PrismaPg } = await import("@prisma/adapter-pg");
const { createSystemAuthMiddleware } = await import("./systemAuth.middleware");
const { createSystemEstimatesRouter } = await import("./estimates.routes");

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env["DATABASE_URL"]! }) });

const SERVICE_AUD = "operai-system-test";
const KID = "svc-estimates-kid";
const RUN = crypto.randomUUID().slice(0, 8);
const OWNER = `sys-owner-${RUN}`;
const COLLABORATOR = `sys-collab-${RUN}`;
const SERVICE_SCOPE = "estimai.estimates.read";

let signingKey: CryptoKey;
let app: Hono;
let noAudienceApp: Hono;

const serviceJwt = (
  o: { sub?: string; scope?: string | null; aud?: string; exp?: string | number } = {},
): Promise<string> => {
  const claims: Record<string, unknown> = {};
  if (o.scope !== null) claims["scope"] = o.scope ?? SERVICE_SCOPE;
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setIssuedAt()
    .setIssuer(env.AUTH_ISSUER)
    .setAudience(o.aud ?? SERVICE_AUD)
    .setSubject(o.sub ?? "system:projects-api")
    .setExpirationTime(o.exp ?? "5m")
    .sign(signingKey);
};

const summaryPath = (id: string) => `/system/estimates/${id}/summary`;
const get = (id: string, token?: string, target: Hono = app) =>
  target.request(summaryPath(id), token ? { headers: { Authorization: `Bearer ${token}` } } : {});

// The shared vectors of crm-api/src/offers/scope.test.ts: 1 + 10.5833 + 5 + 1 = 17.5833 → 17.6.
const CONTENT_17_6 = {
  params: { aiGain: "0.3" },
  releases: [
    { id: "r2", name: "Release 2" },
    { id: "r1", name: "MVP" },
  ],
  acts: [
    { id: "1", epic: "Auth", ml: 1, o: 1, p: 1, release: "r1" },
    { id: "2", epic: "Auth", ml: 10, release: "r1" },
    { id: "3", epic: "Reports", o: 2, ml: 4, p: 9, risk: 0.5, release: "r2" },
    { id: "4", epic: "", ml: 1, o: 1, p: 1, release: "missing" },
  ],
};

const make = (name: string, content: object = CONTENT_17_6, userId = OWNER) =>
  db.estimate.create({
    data: { userId, name, sizeBytes: JSON.stringify(content).length, content },
  });

const cleanup = () => db.estimate.deleteMany({ where: { userId: { in: [OWNER, COLLABORATOR] } } });

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  signingKey = pair.privateKey;
  const jwks = createLocalJWKSet({
    keys: [{ ...(await exportJWK(pair.publicKey)), kid: KID, alg: "RS256", use: "sig" }],
  });
  const find = (id: string) =>
    db.estimate.findUnique({ where: { id }, select: { id: true, name: true, content: true } });
  const build = (audience: string | undefined) => {
    const router = createSystemEstimatesRouter(
      createSystemAuthMiddleware({ scope: SERVICE_SCOPE, jwks, audience }),
      find,
    );
    const hono = new Hono();
    hono.route("/", router);
    return hono;
  };
  app = build(SERVICE_AUD);
  noAudienceApp = build(undefined);
  await cleanup();
});

afterAll(async () => {
  await cleanup();
  await db.$disconnect();
});

describe("GET /system/estimates/{id}/summary — a scoped service credential", () => {
  it("200 { id, name, manDays } for an estimate it neither owns nor collaborates on, and nothing else", async () => {
    const estimate = await make("Acme platform");
    const res = await get(estimate.id, await serviceJwt());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: estimate.id, name: "Acme platform", manDays: 17.6 });
  });

  it("reads an estimate whoever owns it and whoever collaborates on it", async () => {
    const estimate = await make("Shared one", { params: {}, releases: [], acts: [{ id: "a", o: 2, ml: 4, p: 9, risk: 0.5 }] });
    await db.estimateCollaborator.create({
      data: {
        estimateId: estimate.id,
        userId: COLLABORATOR,
        email: `${COLLABORATOR}@example.com`,
        accessLevel: "viewer",
        grantedByUserId: OWNER,
      },
    });
    const res = await get(estimate.id, await serviceJwt());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: estimate.id, name: "Shared one", manDays: 5 });
  });

  it("an estimate with no activities is 0 man-days, not an error", async () => {
    const estimate = await make("Empty", { params: {}, releases: [], acts: [] });
    const res = await get(estimate.id, await serviceJwt());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: estimate.id, name: "Empty", manDays: 0 });
  });

  it("404 estimate_not_found, as problem+json, for an unknown id", async () => {
    const res = await get("no-such-estimate", await serviceJwt());
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({
      status: 404,
      code: "estimate_not_found",
      instance: summaryPath("no-such-estimate"),
    });
  });

  it("400 for an id that cannot be an estimate id, after the credential is accepted", async () => {
    const res = await get("x".repeat(129), await serviceJwt());
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ status: 400 });
  });

  it("a token carrying our scope among others is accepted", async () => {
    const estimate = await make("Several scopes");
    const res = await get(estimate.id, await serviceJwt({ scope: `notifications.push ${SERVICE_SCOPE}` }));
    expect(res.status).toBe(200);
  });
});

describe("GET /system/estimates/{id}/summary — the credential (every failure is the same 401)", () => {
  it("no token, a user JWT, another scope, another audience, a non-service sub, expired, malformed: one identical body", async () => {
    const estimate = await make("Guarded");
    const userJwt = await serviceJwt({ sub: "user-1", aud: env.AUTH_AUDIENCE, scope: null });
    const failures: Array<[string, Response]> = [
      ["no token", await get(estimate.id)],
      ["a user JWT", await get(estimate.id, userJwt)],
      ["a user JWT with the scope claim", await get(estimate.id, await serviceJwt({ sub: "user-1", aud: env.AUTH_AUDIENCE }))],
      ["another scope", await get(estimate.id, await serviceJwt({ scope: "crm.deals.read" }))],
      ["no scope claim", await get(estimate.id, await serviceJwt({ scope: null }))],
      ["a scope that only contains ours", await get(estimate.id, await serviceJwt({ scope: `${SERVICE_SCOPE}.extra` }))],
      ["another audience", await get(estimate.id, await serviceJwt({ aud: "someone-else" }))],
      ["a sub that is not a service principal", await get(estimate.id, await serviceJwt({ sub: "projects-api" }))],
      ["an empty service sub", await get(estimate.id, await serviceJwt({ sub: "system:" }))],
      ["an expired token", await get(estimate.id, await serviceJwt({ exp: Math.floor(Date.now() / 1000) - 60 }))],
      ["a malformed token", await get(estimate.id, "not-a-jwt")],
    ];
    const reference = await failures[0]![1].clone().text();
    expect(JSON.parse(reference)).toMatchObject({ status: 401, instance: summaryPath(estimate.id) });
    for (const [label, res] of failures) {
      expect({ label, status: res.status }).toEqual({ label, status: 401 });
      expect({ label, body: await res.text() }).toEqual({ label, body: reference });
    }
  });

  it("a bad credential on an unknown id is the same 401 — the credential is checked before the id", async () => {
    const known = await make("Known");
    const [a, b] = [await get(known.id), await get("no-such-estimate")];
    expect([a.status, b.status]).toEqual([401, 401]);
    const strip = async (res: Response) => ({ ...((await res.json()) as object), instance: "" });
    expect(await strip(a)).toEqual(await strip(b));
  });

  it("fails closed when SERVICE_AUDIENCE is not configured, even for an otherwise valid token", async () => {
    const estimate = await make("Closed");
    const res = await get(estimate.id, await serviceJwt(), noAudienceApp);
    expect(res.status).toBe(401);
  });
});
