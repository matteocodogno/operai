/**
 * Auth matrix for POST /system/notifications (specs/015 T6, ADR-0044).
 *
 * No DB: a tiny Hono app with the auth middleware + a recording handler
 * proves the guard stops (or lets through) the request. Keys and the JWKS are
 * generated in memory and INJECTED into the middleware factory, so nothing
 * here depends on module load order or a live auth service.
 */

import { describe, it, expect, beforeAll } from "bun:test";
import { Hono } from "hono";
import {
  generateKeyPair,
  exportJWK,
  SignJWT,
  UnsecuredJWT,
  createLocalJWKSet,
} from "jose";
import { env } from "@/lib/env";
import {
  createNotificationsAuthMiddleware,
  originAllowed,
  type NotificationsAuthVariables,
} from "./notificationsAuth.middleware";

const ISSUER = env.AUTH_ISSUER;
const SERVICE_AUD = "operai-system-test";
const USER_AUD = "operai-suite-test";
const KID = "svc-test-kid";
const LEGACY = env.NOTIFY_INTERNAL_TOKEN;

let signingKey: CryptoKey;
let otherSigningKey: CryptoKey;
let publicJwk: Awaited<ReturnType<typeof exportJWK>>;
let jwks: ReturnType<typeof createLocalJWKSet>;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  signingKey = pair.privateKey;
  otherSigningKey = (await generateKeyPair("RS256")).privateKey;
  publicJwk = { ...(await exportJWK(pair.publicKey)), kid: KID, alg: "RS256", use: "sig" };
  jwks = createLocalJWKSet({ keys: [publicJwk] });
});

const sign = (
  o: {
    sub?: string | null;
    aud?: string | null;
    iss?: string;
    scope?: string | null;
    exp?: string | number | null;
    signer?: CryptoKey;
    kid?: string;
  } = {},
) => {
  const jwt = new SignJWT(o.scope === null ? {} : { scope: o.scope ?? "notifications.push" })
    .setProtectedHeader({ alg: "RS256", kid: o.kid ?? KID })
    .setIssuedAt()
    .setIssuer(o.iss ?? ISSUER);
  if (o.sub !== null) jwt.setSubject(o.sub ?? "system:inventory-api");
  if (o.aud !== null) jwt.setAudience(o.aud ?? SERVICE_AUD);
  if (o.exp !== null) jwt.setExpirationTime(o.exp ?? "5m");
  return jwt.sign(o.signer ?? signingKey);
};

type App = Hono<{ Variables: NotificationsAuthVariables }>;

const buildApp = (opts: { audience?: string | undefined } = { audience: SERVICE_AUD }) => {
  const ran = { value: false };
  const seen: { origins?: readonly string[] | null; sub?: string | null } = {};
  const app: App = new Hono();
  app.use("/x", createNotificationsAuthMiddleware({ jwks, audience: opts.audience }));
  app.post("/x", (c) => {
    ran.value = true;
    seen.origins = c.get("allowedOrigins");
    seen.sub = c.get("serviceSub");
    return c.json({ ok: true });
  });
  return { app, ran, seen };
};

const post = (app: App, headers: Record<string, string>) =>
  app.request("/x", { method: "POST", headers });

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

describe("legacy internal token (unchanged for the three existing callers)", () => {
  it("accepted, with no origin restriction", async () => {
    const { app, ran, seen } = buildApp();
    const res = await post(app, { "X-Internal-Token": LEGACY });
    expect(res.status).toBe(200);
    expect(ran.value).toBe(true);
    expect(seen.origins).toBeNull();
    expect(seen.sub).toBeNull();
  });

  it("accepted even when the service-JWT path is disabled (SERVICE_AUDIENCE unset)", async () => {
    const { app } = buildApp({ audience: undefined });
    expect((await post(app, { "X-Internal-Token": LEGACY })).status).toBe(200);
  });

  it("wrong token -> 401, handler not run", async () => {
    const { app, ran } = buildApp();
    const res = await post(app, { "X-Internal-Token": LEGACY.slice(0, -1) + "x" });
    expect(res.status).toBe(401);
    expect(ran.value).toBe(false);
  });

  it("no credentials at all -> 401", async () => {
    const { app, ran } = buildApp();
    expect((await post(app, {})).status).toBe(401);
    expect(ran.value).toBe(false);
  });
});

describe("scoped service JWT", () => {
  it("valid token -> accepted, bound to the inventory origin only", async () => {
    const { app, ran, seen } = buildApp();
    const res = await post(app, bearer(await sign()));
    expect(res.status).toBe(200);
    expect(ran.value).toBe(true);
    expect(seen.sub).toBe("system:inventory-api");
    expect(seen.origins).toEqual(["inventory"]);
  });

  it("scope may be one of several space-separated scopes", async () => {
    const { app } = buildApp();
    const res = await post(app, bearer(await sign({ scope: "other.thing notifications.push" })));
    expect(res.status).toBe(200);
  });

  it("an unknown system:* client authenticates but is bound to NO origin", async () => {
    const { app, seen } = buildApp();
    const res = await post(app, bearer(await sign({ sub: "system:someone-else" })));
    expect(res.status).toBe(200);
    expect(seen.origins).toEqual([]);
  });

  const rejected: Array<[string, () => Promise<string>]> = [
    ["user JWT (aud = AUTH_AUDIENCE)", () => sign({ aud: USER_AUD, sub: "user-1" })],
    ["wrong audience", () => sign({ aud: "somewhere-else" })],
    ["missing audience", () => sign({ aud: null })],
    ["missing scope claim", () => sign({ scope: null })],
    ["wrong scope", () => sign({ scope: "emails.send" })],
    ["scope that merely contains the string as a prefix", () => sign({ scope: "notifications.push.admin" })],
    ["empty scope", () => sign({ scope: "" })],
    ["wrong issuer", () => sign({ iss: "http://evil.example" })],
    ["expired", () => sign({ exp: Math.floor(Date.now() / 1000) - 60 })],
    ["no exp claim", () => sign({ exp: null })],
    ["missing sub", () => sign({ sub: null })],
    ["sub is not system:*", () => sign({ sub: "user-1" })],
    ["sub is the bare prefix", () => sign({ sub: "system:" })],
    ["signed with a different key", () => sign({ signer: otherSigningKey })],
    ["unknown kid", () => sign({ kid: "nope" })],
    [
      "alg:none",
      async () =>
        new UnsecuredJWT({ scope: "notifications.push" })
          .setIssuer(ISSUER)
          .setAudience(SERVICE_AUD)
          .setSubject("system:inventory-api")
          .setExpirationTime("5m")
          .encode(),
    ],
    [
      "HS256 signed with the public JWK as the shared secret",
      async () =>
        new SignJWT({ scope: "notifications.push" })
          .setProtectedHeader({ alg: "HS256", kid: KID })
          .setIssuer(ISSUER)
          .setAudience(SERVICE_AUD)
          .setSubject("system:inventory-api")
          .setExpirationTime("5m")
          .sign(new TextEncoder().encode(JSON.stringify(publicJwk))),
    ],
    ["garbage", async () => "not.a.jwt"],
  ];

  for (const [name, make] of rejected) {
    it(`401: ${name}`, async () => {
      const { app, ran } = buildApp();
      const res = await post(app, bearer(await make()));
      expect(res.status).toBe(401);
      expect(ran.value).toBe(false);
    });
  }

  it("every rejection carries a byte-identical body (no detail leak)", async () => {
    const { app } = buildApp();
    const bodies = new Set<string>();
    for (const [, make] of rejected) {
      const res = await post(app, bearer(await make()));
      bodies.add(JSON.stringify(await res.json()));
    }
    for (const h of [{}, { "X-Internal-Token": "wrong" }]) {
      bodies.add(JSON.stringify(await (await post(app, h)).json()));
    }
    expect(bodies.size).toBe(1);
  });

  it("disabled when SERVICE_AUDIENCE is unset: a validly signed service JWT is 401", async () => {
    const { app, ran } = buildApp({ audience: undefined });
    const res = await post(app, bearer(await sign()));
    expect(res.status).toBe(401);
    expect(ran.value).toBe(false);
  });

  it("the two credentials are alternatives: a valid JWT passes next to a wrong legacy token, an invalid one does not", async () => {
    const { app } = buildApp();
    expect(
      (await post(app, { ...bearer(await sign()), "X-Internal-Token": "wrong" })).status,
    ).toBe(200);
    expect(
      (await post(app, { ...bearer(await sign({ scope: "x" })), "X-Internal-Token": "wrong" })).status,
    ).toBe(401);
  });

  it("a non-Bearer scheme or an empty token -> 401", async () => {
    const { app } = buildApp();
    expect((await post(app, { Authorization: `Basic ${await sign()}` })).status).toBe(401);
    expect((await post(app, { Authorization: "Bearer " })).status).toBe(401);
  });
});

describe("originAllowed", () => {
  it("null (legacy) allows anything; a list allows only its members", () => {
    expect(originAllowed(null, "refund")).toBe(true);
    expect(originAllowed(["inventory"], "inventory")).toBe(true);
    expect(originAllowed(["inventory"], "refund")).toBe(false);
    expect(originAllowed([], "inventory")).toBe(false);
  });
});
