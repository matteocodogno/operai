/**
 * Integration tests for POST /system/service-token (T4, specs/015-hardware-
 * inventory — refs AC-2.8, AC-2.9; ADR-0044).
 *
 * Route logic only, with an injected signer backed by a throwaway in-memory
 * RS256 key: this file must not depend on `auth.config` (see the "WHY A
 * FACTORY" note in serviceToken.routes.ts). The REAL signing path — better-
 * auth's jwt plugin, the published `/auth/jwks`, notify-api's verification
 * options, rejection on user routes — is the R-4 contract test,
 * `src/auth/service-token.contract.test.ts`.
 *
 * `env` is mutated per file and restored in `afterAll` — the module is shared
 * across the whole `bun test` process, so env set at import time would depend
 * on file order. Each test uses its own `X-Forwarded-For` so the in-process
 * rate limiter (keyed by network address) never couples tests together.
 *
 * Secrets here are obvious dummies.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createLocalJWKSet, decodeJwt, exportJWK, generateKeyPair, jwtVerify, SignJWT } from "jose";
import type { ServiceJwtPayload } from "./serviceToken.routes";

const { env } = await import("../lib/env");
const { createServiceTokenRouter } = await import("./serviceToken.routes");

// Throwaway key, generated in memory for this file only.
const { publicKey, privateKey } = await generateKeyPair("RS256");
const KID = "test-kid";
const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: KID, alg: "RS256", use: "sig" }] });

/** Signs the way the jwt plugin does: exactly the payload claims, RS256 + kid. */
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

const serviceTokenRouter = createServiceTokenRouter({ signJwt });

const SERVICE_AUDIENCE = "operai-service-routes-test";
const SECRET = "dummy-routes-secret-0123456789-abcdefgh";
const URL_PATH = "/system/service-token";

const mutableEnv = env as unknown as Record<string, unknown>;
const saved = { audience: env.SERVICE_AUDIENCE, clients: env.SERVICE_CLIENTS };

const configure = (audience: string | undefined, clients: Map<string, unknown>) => {
  mutableEnv["SERVICE_AUDIENCE"] = audience;
  mutableEnv["SERVICE_CLIENTS"] = clients;
};
const validClients = () =>
  new Map([["inventory-api", { secret: SECRET, scopes: ["notifications.push"] }]]);

beforeAll(() => configure(SERVICE_AUDIENCE, validClients()));
afterAll(() => {
  mutableEnv["SERVICE_AUDIENCE"] = saved.audience;
  mutableEnv["SERVICE_CLIENTS"] = saved.clients;
});

let ipCounter = 0;
const freshIp = () => `203.0.113.${(ipCounter += 1)}`;

const post = (body: unknown, ip = freshIp(), raw = false) =>
  serviceTokenRouter.request(URL_PATH, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Forwarded-For": ip },
    body: raw ? (body as string) : JSON.stringify(body),
  });

const good = { clientId: "inventory-api", clientSecret: SECRET };

describe("POST /system/service-token — success (AC-2.8)", () => {
  test("returns { token, expiresInSeconds: 300 } and never lets the response be cached", async () => {
    const res = await post(good);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; expiresInSeconds: number };
    expect(body.expiresInSeconds).toBe(300);
    expect(typeof body.token).toBe("string");
    expect(Object.keys(body).sort()).toEqual(["expiresInSeconds", "token"]);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  test("claims: sub system:<client>, aud SERVICE_AUDIENCE (not AUTH_AUDIENCE), scope, iss, 5-minute exp, unique jti", async () => {
    const before = Math.floor(Date.now() / 1000);
    const a = decodeJwt(((await (await post(good)).json()) as { token: string }).token);
    const b = decodeJwt(((await (await post(good)).json()) as { token: string }).token);
    const after = Math.floor(Date.now() / 1000);

    expect(a.sub).toBe("system:inventory-api");
    expect(a.aud).toBe(SERVICE_AUDIENCE);
    expect(a.aud).not.toBe(env.AUTH_AUDIENCE);
    expect(a["scope"]).toBe("notifications.push");
    expect(a.iss).toBe(env.BETTER_AUTH_URL);
    expect(a.iat).toBeGreaterThanOrEqual(before);
    expect(a.iat).toBeLessThanOrEqual(after);
    expect((a.exp as number) - (a.iat as number)).toBe(300);
    expect(a.jti).toBeTruthy();
    expect(a.jti).not.toBe(b.jti);
    // No user identity claims leak into a service token.
    for (const claim of ["email", "name", "image", "perm_epoch"]) {
      expect(claim in a).toBe(false);
    }
  });

  test("the token expires: verification fails once its exp has passed", async () => {
    const { token } = (await (await post(good)).json()) as { token: string };
    const exp = decodeJwt(token).exp as number;
    await expect(
      jwtVerify(token, jwks, {
        issuer: env.BETTER_AUTH_URL,
        audience: SERVICE_AUDIENCE,
        currentDate: new Date((exp + 1) * 1000),
      }),
    ).rejects.toThrow();
  });

  test("the scope comes from the client's own entry", async () => {
    // A second, differently-scoped-by-construction client: same allowlist, own entry.
    configure(SERVICE_AUDIENCE, new Map([["other-svc", { secret: SECRET, scopes: ["notifications.push"] }]]));
    try {
      const res = await post({ clientId: "other-svc", clientSecret: SECRET });
      const claims = decodeJwt(((await res.json()) as { token: string }).token);
      expect(claims.sub).toBe("system:other-svc");
    } finally {
      configure(SERVICE_AUDIENCE, validClients());
    }
  });
});

describe("POST /system/service-token — authentication failures (AC-2.9)", () => {
  test("unknown client and wrong secret return the byte-identical 401 (status, headers that matter, body)", async () => {
    const unknown = await post({ clientId: "nobody", clientSecret: SECRET });
    const wrong = await post({ clientId: "inventory-api", clientSecret: "x".repeat(40) });
    const wrongShort = await post({ clientId: "inventory-api", clientSecret: "a" });

    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(wrongShort.status).toBe(401);

    const [u, w, s] = await Promise.all([unknown.text(), wrong.text(), wrongShort.text()]);
    expect(u).toBe(w);
    expect(w).toBe(s);
    expect(unknown.headers.get("Content-Type")).toBe(wrong.headers.get("Content-Type"));
    expect(u).not.toContain("inventory-api");
    expect(u).not.toContain(SECRET);
    expect(u).not.toContain("token\":");
  });

  test("ids that exist on Object.prototype are just unknown clients", async () => {
    const reference = await (await post({ clientId: "nobody", clientSecret: SECRET })).text();
    for (const clientId of ["__proto__", "constructor", "toString"]) {
      const res = await post({ clientId, clientSecret: SECRET });
      expect(res.status).toBe(401);
      expect(await res.text()).toBe(reference);
    }
  });

  test("with no clients configured every call is that same 401 — the endpoint authenticates nobody", async () => {
    const reference = await (await post({ clientId: "nobody", clientSecret: SECRET })).text();
    configure(undefined, new Map());
    try {
      const res = await post(good);
      expect(res.status).toBe(401);
      expect(await res.text()).toBe(reference);
    } finally {
      configure(SERVICE_AUDIENCE, validClients());
    }
  });

  test("refuses to mint if the audience ever equals the user audience (defence in depth) — never a user-audience token", async () => {
    configure(env.AUTH_AUDIENCE, validClients());
    try {
      const res = await post(good);
      expect(res.status).toBeGreaterThanOrEqual(500);
      expect(await res.text()).not.toContain("eyJ");
    } finally {
      configure(SERVICE_AUDIENCE, validClients());
    }
  });

  test("a malformed body is a 400 Problem JSON, not a 401, and reveals nothing about clients", async () => {
    for (const body of [{}, { clientId: "inventory-api" }, { clientSecret: SECRET }, { clientId: 1, clientSecret: 2 }]) {
      const res = await post(body);
      expect(res.status).toBe(400);
      const json = (await res.json()) as Record<string, unknown>;
      expect(json["status"]).toBe(400);
      expect(JSON.stringify(json)).not.toContain(SECRET);
    }
    expect((await post("{not json", freshIp(), true)).status).toBe(400);
  });

  test("oversized credentials are refused before any comparison (bounded work)", async () => {
    const res = await post({ clientId: "inventory-api", clientSecret: "z".repeat(5000) });
    expect(res.status).toBe(400);
  });
});

describe("POST /system/service-token — rate limiting (AC-2.9)", () => {
  test("the (limit+1)th attempt from one address is 429 with Retry-After; another address is unaffected", async () => {
    const ip = freshIp();
    const limit = env.SERVICE_TOKEN_RATE_LIMIT;
    for (let i = 0; i < limit; i++) {
      // Failed attempts count too: the limiter is on the attempt, not the success.
      expect((await post({ clientId: "nobody", clientSecret: SECRET }, ip)).status).toBe(401);
    }
    const over = await post(good, ip);
    expect(over.status).toBe(429);
    expect(Number(over.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);
    const body = (await over.json()) as Record<string, unknown>;
    expect(body["status"]).toBe(429);
    expect(body["code"]).toBe("rate_limited");
    expect(JSON.stringify(body)).not.toContain("eyJ");

    expect((await post(good, freshIp())).status).toBe(200);
  });

  test("malformed bodies are counted too — probing with invalid input cannot dodge the limiter", async () => {
    const ip = freshIp();
    for (let i = 0; i < env.SERVICE_TOKEN_RATE_LIMIT; i++) {
      expect((await post({}, ip)).status).toBe(400);
    }
    expect((await post({}, ip)).status).toBe(429);
  });
});
