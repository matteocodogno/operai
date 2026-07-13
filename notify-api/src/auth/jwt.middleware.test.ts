/**
 * JWT middleware tests (mirrors estimai-api/src/auth/jwt.middleware.test.ts).
 *
 * Strategy: generate a fixture RS256 keypair at test startup; build an in-memory
 * JWKS with createLocalJWKSet; mock `createRemoteJWKSet` from jose so the
 * middleware under test uses the local key set — no live auth service required.
 *
 * Each test mounts a tiny Hono app with jwtMiddleware + a protected dummy route
 * that records whether it ran (to prove the guard stopped the request).
 *
 * ADR-0010 additions (AUTH_AUDIENCE fold-in, specs/005 T9-notify-api-half):
 *   (h) token missing `aud` → 401
 *   (i) token with wrong `aud` → 401
 *   (j) token with the correct `aud` → 200 (regression guard — audience check
 *       does not accidentally reject legitimate tokens)
 */

import { describe, it, expect, beforeAll, mock, spyOn } from "bun:test";
import { Hono } from "hono";
import {
  generateKeyPair,
  exportJWK,
  SignJWT,
  UnsecuredJWT,
  createLocalJWKSet,
  type JWSHeaderParameters,
  type FlattenedJWSInput,
} from "jose";

// ─── Fixture keypair (generated once for the test suite) ─────────────────────

let privateKey: CryptoKey;
let otherPrivateKey: CryptoKey; // second key — proves bad-signature rejection

// In-memory JWKS that the middleware will verify against.
let localJWKS: (
  protectedHeader?: JWSHeaderParameters,
  token?: FlattenedJWSInput,
) => Promise<CryptoKey>;

const TEST_KID = "operai-auth-rs256-v1";
const TEST_ISSUER = "http://localhost:3001";
const TEST_AUDIENCE = "operai-suite-test";

// ─── Module mock: redirect createRemoteJWKSet to our local key set ────────────

let jwksProxy: typeof localJWKS | null = null;

mock.module("jose", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const realJose = require("jose") as typeof import("jose");
  return {
    ...realJose,
    createRemoteJWKSet: (_url: URL) =>
      (protectedHeader?: JWSHeaderParameters, token?: FlattenedJWSInput) => {
        if (!jwksProxy) throw new Error("JWKS proxy not initialised in test");
        return jwksProxy(protectedHeader, token);
      },
  };
});

// ─── Set env vars BEFORE importing the middleware ────────────────────────────

process.env["DATABASE_URL"] = "postgresql://test:test@localhost:5435/test";
process.env["ALLOWED_ORIGINS"] = "http://localhost:5173";
process.env["AUTH_JWKS_URL"] = "http://localhost:3001/auth/jwks";
process.env["AUTH_ISSUER"] = TEST_ISSUER;
process.env["AUTH_AUDIENCE"] = TEST_AUDIENCE;
process.env["NODE_ENV"] = "test";

const { jwtMiddleware } = await import("./jwt.middleware");

// ─── Helpers ──────────────────────────────────────────────────────────────────

const buildApp = (handlerRanRef: { value: boolean }) => {
  const app = new Hono();
  app.use("/protected", jwtMiddleware);
  app.get("/protected", (c) => {
    handlerRanRef.value = true;
    return c.json(
      {
        userId: c.get("userId" as never),
        email: c.get("email" as never),
      },
      200,
    );
  });
  return app;
};

const signValid = async (overrides?: {
  issuer?: string;
  audience?: string | undefined;
  expiresIn?: string | number;
  sub?: string;
  email?: string;
  kid?: string;
  privateKeyOverride?: CryptoKey;
  omitAudience?: boolean;
}) => {
  const {
    issuer = TEST_ISSUER,
    audience = TEST_AUDIENCE,
    expiresIn = "1h",
    sub = "user-abc-123",
    email = "alice@example.com",
    kid = TEST_KID,
    privateKeyOverride,
    omitAudience = false,
  } = overrides ?? {};

  const jwt = new SignJWT({ email })
    .setProtectedHeader({ alg: "RS256", kid })
    .setIssuer(issuer)
    .setSubject(sub)
    .setExpirationTime(expiresIn);

  if (!omitAudience) {
    jwt.setAudience(audience);
  }

  return jwt.sign(privateKeyOverride ?? privateKey);
};

// ─── Test setup ───────────────────────────────────────────────────────────────

beforeAll(async () => {
  const kp = await generateKeyPair("RS256", { extractable: true });
  privateKey = kp.privateKey;

  const publicJwk = await exportJWK(kp.publicKey);
  localJWKS = createLocalJWKSet({
    keys: [{ ...publicJwk, use: "sig", alg: "RS256", kid: TEST_KID }],
  });
  jwksProxy = localJWKS;

  const kp2 = await generateKeyPair("RS256");
  otherPrivateKey = kp2.privateKey;
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("jwtMiddleware (notify-api)", () => {
  it("(a) valid RS256 token with correct issuer + audience — passes, sets userId and email", async () => {
    const handlerRan = { value: false };
    const app = buildApp(handlerRan);

    const jwt = await signValid();
    const res = await app.request("/protected", {
      headers: { Authorization: `Bearer ${jwt}` },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { userId: string; email: string };
    expect(body.userId).toBe("user-abc-123");
    expect(body.email).toBe("alice@example.com");
    expect(handlerRan.value).toBe(true);
  });

  it("(b) missing Authorization header — 401 Problem JSON, handler does not run", async () => {
    const handlerRan = { value: false };
    const app = buildApp(handlerRan);

    const res = await app.request("/protected");

    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/json");

    const body = (await res.json()) as {
      type: string;
      status: number;
      title: string;
      detail: string;
    };
    expect(body.type).toBe("https://httpstatuses.com/401");
    expect(body.status).toBe(401);
    expect(body.title).toBe("Unauthorized");
    expect(typeof body.detail).toBe("string");

    expect(handlerRan.value).toBe(false);
  });

  it("(b2) malformed Authorization header (not Bearer) — 401, handler does not run", async () => {
    const handlerRan = { value: false };
    const app = buildApp(handlerRan);

    const res = await app.request("/protected", {
      headers: { Authorization: "Basic dXNlcjpwYXNz" },
    });

    expect(res.status).toBe(401);
    expect(handlerRan.value).toBe(false);
  });

  it("(b3) 'Bearer ' with empty token value — 401, handler does not run", async () => {
    const handlerRan = { value: false };
    const app = buildApp(handlerRan);

    const res = await app.request("/protected", {
      headers: { Authorization: "Bearer " },
    });

    expect(res.status).toBe(401);
    expect(handlerRan.value).toBe(false);
  });

  it("(c) expired token — 401, handler does not run", async () => {
    const handlerRan = { value: false };
    const app = buildApp(handlerRan);

    const pastExp = Math.floor(Date.now() / 1000) - 10;
    const jwt = await signValid({ expiresIn: pastExp });

    const res = await app.request("/protected", {
      headers: { Authorization: `Bearer ${jwt}` },
    });

    expect(res.status).toBe(401);
    expect(handlerRan.value).toBe(false);
  });

  it("(d) wrong issuer — 401, handler does not run", async () => {
    const handlerRan = { value: false };
    const app = buildApp(handlerRan);

    const jwt = await signValid({ issuer: "https://attacker.example.com" });
    const res = await app.request("/protected", {
      headers: { Authorization: `Bearer ${jwt}` },
    });

    expect(res.status).toBe(401);
    expect(handlerRan.value).toBe(false);
  });

  it("(e) bad signature (signed with a different RS256 key) — 401, handler does not run", async () => {
    const handlerRan = { value: false };
    const app = buildApp(handlerRan);

    const jwt = await signValid({ privateKeyOverride: otherPrivateKey });
    const res = await app.request("/protected", {
      headers: { Authorization: `Bearer ${jwt}` },
    });

    expect(res.status).toBe(401);
    expect(handlerRan.value).toBe(false);
  });

  it("(f) alg:none token — 401, algorithm-confusion attack rejected, handler does not run", async () => {
    const handlerRan = { value: false };
    const app = buildApp(handlerRan);

    const jwt = new UnsecuredJWT({
      email: "alice@example.com",
      sub: "user-abc-123",
    })
      .setIssuer(TEST_ISSUER)
      .setAudience(TEST_AUDIENCE)
      .setExpirationTime("1h")
      .encode();

    const res = await app.request("/protected", {
      headers: { Authorization: `Bearer ${jwt}` },
    });

    expect(res.status).toBe(401);
    const body = (await res.json()) as { status: number; type: string };
    expect(body.status).toBe(401);
    expect(body.type).toBe("https://httpstatuses.com/401");

    expect(handlerRan.value).toBe(false);
  });

  it("(f2) HS256 token (algorithm-confusion, non-RS256) — 401, handler does not run", async () => {
    const handlerRan = { value: false };
    const app = buildApp(handlerRan);

    const { generateSecret } = await import("jose");
    const hmacKey = await generateSecret("HS256");

    const jwt = await new SignJWT({ email: "alice@example.com" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(TEST_ISSUER)
      .setAudience(TEST_AUDIENCE)
      .setSubject("user-abc-123")
      .setExpirationTime("1h")
      .sign(hmacKey);

    const res = await app.request("/protected", {
      headers: { Authorization: `Bearer ${jwt}` },
    });

    expect(res.status).toBe(401);
    expect(handlerRan.value).toBe(false);
  });

  it("(g) unauthenticated requests — no database access occurs (AC-4.2)", async () => {
    const dbModule = await import("../lib/db");
    const querySpy = spyOn(dbModule.db, "$queryRaw").mockResolvedValue([]);

    const handlerRan = { value: false };
    const app = buildApp(handlerRan);

    const res1 = await app.request("/protected");
    expect(res1.status).toBe(401);
    expect(querySpy).not.toHaveBeenCalled();

    const res2 = await app.request("/protected", {
      headers: { Authorization: "Bearer not-a-real-jwt" },
    });
    expect(res2.status).toBe(401);
    expect(querySpy).not.toHaveBeenCalled();

    const pastExp = Math.floor(Date.now() / 1000) - 10;
    const expiredJwt = await signValid({ expiresIn: pastExp });
    const res3 = await app.request("/protected", {
      headers: { Authorization: `Bearer ${expiredJwt}` },
    });
    expect(res3.status).toBe(401);
    expect(querySpy).not.toHaveBeenCalled();

    expect(handlerRan.value).toBe(false);

    querySpy.mockRestore();
  });

  // ─── ADR-0010: audience verification ─────────────────────────────────────

  it("(h) token with NO aud claim — 401, handler does not run", async () => {
    const handlerRan = { value: false };
    const app = buildApp(handlerRan);

    const jwt = await signValid({ omitAudience: true });
    const res = await app.request("/protected", {
      headers: { Authorization: `Bearer ${jwt}` },
    });

    expect(res.status).toBe(401);
    expect(handlerRan.value).toBe(false);
  });

  it("(i) token with the WRONG aud — 401, handler does not run", async () => {
    const handlerRan = { value: false };
    const app = buildApp(handlerRan);

    const jwt = await signValid({ audience: "some-other-service" });
    const res = await app.request("/protected", {
      headers: { Authorization: `Bearer ${jwt}` },
    });

    expect(res.status).toBe(401);
    expect(handlerRan.value).toBe(false);
  });

  it("(j) token with the CORRECT aud — 200 (audience check does not reject legitimate tokens)", async () => {
    const handlerRan = { value: false };
    const app = buildApp(handlerRan);

    const jwt = await signValid({ audience: TEST_AUDIENCE });
    const res = await app.request("/protected", {
      headers: { Authorization: `Bearer ${jwt}` },
    });

    expect(res.status).toBe(200);
    expect(handlerRan.value).toBe(true);
  });
});
