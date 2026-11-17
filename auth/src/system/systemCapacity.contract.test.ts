/**
 * Suite-capacity contract for the /system endpoints (specs/20261111-push-notifications US-7, AC-7.7, ADR 20261112-system-endpoints-limited-per-verified-service).
 *
 * The test that would have caught D-1. The earlier unit tests drove ONE caller against ONE
 * limiter and so could not see that the whole suite shared a single address bucket of 20: on
 * Railway's private network no forwarded address reaches `auth`, every service is "direct",
 * and a busy minute of the suite's ordinary traffic was refused.
 *
 * So this runs the whole suite's traffic through the REAL routers, wired as `src/index.ts`
 * wires them (one set of limits, production defaults, the real `createSystemRateLimits`), in
 * one window, with NO `X-Forwarded-For` anywhere:
 *
 *   - the 9 service clients each mint 30 tokens (about ten times the steady rate), interleaved,
 *   - `system:notify-api` makes 220 contact lookups (110 email notices + 110 push activity checks),
 *   - `system:crm-api` and `system:letterhead-api` read the legal entities 60 times each, list and entity mixed
 *     (a consumer caches 30 s, so the steady rate is ~20 per 10 minutes: this is three times that;
 *     specs/20261117-legal-entities T6, AC-3.2),
 *   - 15 requests with invalid credentials arrive from the one shared address,
 *
 * and not one of them may be refused. A new limit that is keyed by a value the suite shares, or a
 * check ahead of verification, fails here at the 21st request.
 *
 * The tokens are minted by the real service-token router and presented to the real contact
 * router, signed by a throwaway in-memory RS256 key (this file must not depend on `auth.config`;
 * the real signing path is `src/auth/service-token.contract.test.ts`). Dummy secrets only.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { db } from "../lib/db";
import type { ServiceJwtPayload } from "./serviceToken.routes";

const { env } = await import("../lib/env");
const { createServiceTokenRouter } = await import("./serviceToken.routes");
const { createUserContactRouter } = await import("./userContact.routes");
const { createSystemLegalEntitiesRouter } = await import("../legalEntities/system.routes");
const { createSystemRateLimits, LEGAL_ENTITIES_SERVICE_LIMIT } = await import("./systemRateLimits");

const { publicKey, privateKey } = await generateKeyPair("RS256");
const KID = "capacity-kid";
const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: KID, alg: "RS256", use: "sig" }] });
const signJwt = async (payload: ServiceJwtPayload): Promise<string> =>
  new SignJWT({ scope: payload.scope })
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setIssuer(payload.iss)
    .setSubject(payload.sub)
    .setAudience(payload.aud)
    .setIssuedAt(payload.iat)
    .setExpirationTime(payload.exp)
    .setJti(payload.jti)
    .sign(privateKey);

// The nine service clients of the suite (infra/README.md § Notify credential rollout; letterhead-api reads the registry).
const SECRET = "dummy-capacity-secret-0123456789-abcdefgh";
const CLIENTS = [
  "inventory-api",
  "estimai-api",
  "refund-api",
  "crm-api",
  "projects-api",
  "activities-api",
  "meetings-api",
  "notify-api",
  "letterhead-api",
] as const;
const scopesOf = (id: string) =>
  id === "notify-api"
    ? ["users.contact"]
    : id === "letterhead-api"
      ? ["legal-entities:read"]
      : id === "crm-api"
        ? ["notifications.push", "emails.send", "legal-entities:read"]
        : ["notifications.push", "emails.send"];

const SERVICE_AUDIENCE = "operai-service-capacity-test";
const RUN_ID = crypto.randomUUID().slice(0, 8);
const mutableEnv = env as unknown as Record<string, unknown>;
const saved = { audience: env.SERVICE_AUDIENCE, clients: env.SERVICE_CLIENTS };
let userId = "";

beforeAll(async () => {
  mutableEnv["SERVICE_AUDIENCE"] = SERVICE_AUDIENCE;
  mutableEnv["SERVICE_CLIENTS"] = new Map(CLIENTS.map((id) => [id, { secret: SECRET, scopes: scopesOf(id) }]));
  userId = (await db.user.create({ data: { name: `Cap ${RUN_ID}`, email: `cap-${RUN_ID}@operai.test` } })).id;
});
afterAll(async () => {
  mutableEnv["SERVICE_AUDIENCE"] = saved.audience;
  mutableEnv["SERVICE_CLIENTS"] = saved.clients;
  await db.user.deleteMany({ where: { id: userId } });
});

describe("suite capacity (AC-7.7) — the D-1 traffic shape, production defaults, real routers, no X-Forwarded-For", () => {
  test("the limits under test are the production defaults", () => {
    expect([
      env.SERVICE_TOKEN_SERVICE_LIMIT,
      env.USERS_CONTACT_SERVICE_LIMIT,
      env.SYSTEM_INVALID_CREDENTIAL_LIMIT,
      env.SYSTEM_RATE_WINDOW_MS,
      LEGAL_ENTITIES_SERVICE_LIMIT,
    ]).toEqual([300, 600, 20, 600_000, 300]);
  });

  test("9 clients x 30 mints + 220 lookups + 120 legal-entity reads + 15 invalid requests from one address: zero 429", async () => {
    const limits = createSystemRateLimits();
    const tokenRouter = createServiceTokenRouter({ signJwt, limits });
    const contactRouter = createUserContactRouter({ getJwks: async () => jwks, limits });
    // Reads through `db`: the registry may hold no row here (version 0 answers) - the traffic is what is under test.
    const registryRouter = createSystemLegalEntitiesRouter({ getJwks: async () => jwks, limits });

    const mint = (clientId: string, clientSecret = SECRET) =>
      tokenRouter.request("/system/service-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId, clientSecret }),
      });
    const lookup = (token: string, id: string) =>
      contactRouter.request("/system/users/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ userId: id }),
      });

    const read = (token: string, path: string) =>
      registryRouter.request(path, { headers: { Authorization: `Bearer ${token}` } });
    const tokenOf = async (clientId: string) => {
      const res = await mint(clientId);
      expect(res.status).toBe(200);
      return ((await res.json()) as { token: string }).token;
    };

    // notify-api's own credential comes from the real token router, like in production.
    const first = await mint("notify-api");
    expect(first.status).toBe(200);
    const notifyToken = ((await first.json()) as { token: string }).token;

    const statuses: { what: string; status: number }[] = [{ what: "mint notify-api", status: 200 }];
    const record = (what: string, res: Response) => statuses.push({ what, status: res.status });

    // The two registry readers' credentials are minted by the real router too (their mints count in the 30 below
    // as two of the 30 rounds' worth: the mint limit is 300, nothing here comes near it).
    const registryTokens = [await tokenOf("crm-api"), await tokenOf("letterhead-api")];
    statuses.push({ what: "mint crm-api", status: 200 }, { what: "mint letterhead-api", status: 200 });

    let lookups = 0;
    let reads = 0;
    let invalid = 0;
    for (let round = 0; round < 30; round++) {
      // 4 reads a round -> 120 over 30 rounds, 60 for each of the two services, list and entity alternating
      for (let i = 0; i < 4; i++) {
        const path = reads % 2 === 0 ? "/system/legal-entities" : "/system/legal-entities/welld_ch";
        record("read", await read(registryTokens[reads % 4 < 2 ? 0 : 1]!, path));
        reads += 1;
      }
      for (const clientId of CLIENTS) {
        if (clientId === "notify-api" && round === 0) continue; // minted above
        record(`mint ${clientId}`, await mint(clientId));
      }
      // ~7.3 lookups a round -> 220 over 30 rounds; half hit a user, half an unknown id (both are normal traffic)
      const due = Math.round(((round + 1) * 220) / 30) - lookups;
      for (let i = 0; i < due; i++) {
        record("lookup", await lookup(notifyToken, i % 2 === 0 ? userId : `unknown-${RUN_ID}-${lookups}`));
        lookups += 1;
      }
      // 15 invalid requests from "direct", spread over the window (every other round)
      if (round % 2 === 0 && invalid < 15) {
        record("invalid mint", await mint("nobody", "x".repeat(40)));
        invalid += 1;
      }
    }
    // the remaining invalid ones, split across both endpoints, so the shared count is exercised to 15
    while (invalid < 15) {
      record(invalid % 2 === 0 ? "invalid mint" : "invalid lookup", invalid % 2 === 0 ? await mint("nobody", "x".repeat(40)) : await lookup("not-a-jwt", userId));
      invalid += 1;
    }

    expect(lookups).toBe(220);
    expect(reads).toBe(120);
    expect(invalid).toBe(15);
    const refused = statuses.filter((s) => s.status === 429);
    expect(refused).toEqual([]);
    // and every request was answered as normal traffic is: mints 200, lookups 200/404, invalid 401
    for (const s of statuses) {
      if (s.what.startsWith("mint")) expect(s.status).toBe(200);
      else if (s.what === "lookup") expect([200, 404]).toContain(s.status);
      else if (s.what === "read") expect(s.status).toBe(200);
      else expect(s.status).toBe(401);
    }
    expect(statuses.length).toBe(270 + 2 + 220 + 120 + 15);
  });
});
