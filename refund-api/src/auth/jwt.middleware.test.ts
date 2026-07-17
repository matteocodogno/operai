/**
 * JWT middleware tests (T4, specs/007-refund-service)
 *
 * Strategy: generate a fixture RS256 keypair at test startup; build an in-memory
 * JWKS with createLocalJWKSet; mock `createRemoteJWKSet` from jose so the
 * middleware under test uses the local key set — no live auth service required.
 *
 * Each test mounts a tiny Hono app with jwtMiddleware + a protected dummy route
 * that records whether it ran (to prove the guard stopped the request). Mirrors
 * estimai-api/src/auth/jwt.middleware.test.ts verbatim (same middleware, same
 * ADR-0005/ADR-0010 identity contract) — refund-api's own authorization layer
 * (ADR-0014, capability/condition checks) is added on top by T6 and is out of
 * scope here.
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
const TEST_AUDIENCE = "operai-suite";

// ─── Module mock: redirect createRemoteJWKSet to our local key set ────────────
//
// The middleware creates the JWKS singleton at import time with:
//   createRemoteJWKSet(new URL(env.AUTH_JWKS_URL))
//
// mock.module() intercepts the jose import and replaces createRemoteJWKSet with
// a version that proxies to localJWKS (populated in beforeAll).
// Bun applies this mock BEFORE the dynamic import below executes.

let jwksProxy: typeof localJWKS | null = null;

mock.module("jose", () => {
  // Forward all real exports; only swap createRemoteJWKSet.
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
// env.ts runs at module-eval time and calls process.exit(1) on missing vars.
// These assignments run synchronously before the dynamic import below.
//
// DATABASE_URL uses `??=` (set ONLY if unset), never `=`: `bun test` runs
// every test file in ONE process, so an unconditional overwrite here would
// permanently clobber the REAL DATABASE_URL (auto-loaded by Bun from `.env`
// at process start) for every OTHER test file that runs afterward in the
// same process — including T5's real-Postgres `db.audit-immutability.test.ts`
// (see its own comment for the full story). This middleware never actually
// connects to a database, so any placeholder value is fine when nothing else
// has already set a real one; a real value already present must never be
// touched.
process.env["DATABASE_URL"] ??= "postgresql://test:test@localhost:5435/test";
process.env["ALLOWED_ORIGINS"] = "http://localhost:5173";
process.env["AUTH_JWKS_URL"] = "http://localhost:3001/.well-known/jwks.json";
process.env["AUTH_ISSUER"] = TEST_ISSUER;
process.env["AUTH_AUDIENCE"] = TEST_AUDIENCE;
process.env["NODE_ENV"] = "test";
process.env["NOTIFY_INTERNAL_TOKEN"] = "test-notify-internal-token-at-least-32-characters";
process.env["NOTIFY_INTERNAL_URL"] = "http://localhost:8081";

// Dynamic import ensures the mock.module() registration and process.env
// assignments above are fully in effect before jwt.middleware.ts is evaluated.
const { jwtMiddleware } = await import("./jwt.middleware");

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a minimal Hono app with jwtMiddleware + a protected handler.
 * handlerRanRef.value is set to true when the protected handler executes —
 * lets tests assert the guard blocked (or allowed) the request.
 */
const buildApp = (handlerRanRef: { value: boolean }) => {
  const app = new Hono();
  app.use("/protected", jwtMiddleware);
  app.get("/protected", (c) => {
    handlerRanRef.value = true;
    return c.json(
      {
        userId: c.get("userId" as never),
        email: c.get("email" as never),
        permEpoch: c.get("permEpoch" as never),
      },
      200,
    );
  });
  return app;
};

/**
 * Sign a JWT with the fixture private key, correct issuer and kid.
 * Individual options can be overridden per test.
 */
const signValid = async (overrides?: {
  issuer?: string;
  expiresIn?: string | number;
  sub?: string;
  email?: string;
  kid?: string;
  privateKeyOverride?: CryptoKey;
  // ADR-0010: the `aud` claim. `null` omits the claim entirely (pre-ADR-0010
  // token shape); any string sets a specific (possibly wrong) audience value.
  // Defaults to the correct TEST_AUDIENCE so existing callers keep passing.
  audience?: string | null;
  // T6/ADR-0014: the `perm_epoch` claim (auth.config.ts's definePayload).
  // `undefined` (default) omits the claim entirely, exercising the "missing
  // claim degrades to 0" path; any number sets a specific epoch value.
  permEpoch?: number;
}) => {
  const {
    issuer = TEST_ISSUER,
    expiresIn = "1h",
    sub = "user-abc-123",
    email = "alice@example.com",
    kid = TEST_KID,
    privateKeyOverride,
    audience = TEST_AUDIENCE,
    permEpoch,
  } = overrides ?? {};

  const jwt = new SignJWT({
    email,
    ...(permEpoch !== undefined ? { perm_epoch: permEpoch } : {}),
  })
    .setProtectedHeader({ alg: "RS256", kid })
    .setIssuer(issuer)
    .setSubject(sub)
    .setExpirationTime(expiresIn);

  if (audience !== null) {
    jwt.setAudience(audience);
  }

  return jwt.sign(privateKeyOverride ?? privateKey);
};

// ─── Test setup ───────────────────────────────────────────────────────────────

beforeAll(async () => {
  // Generate the fixture RS256 keypair for the test suite.
  // extractable: true is required so we can call exportJWK on the public key.
  const kp = await generateKeyPair("RS256", { extractable: true });
  privateKey = kp.privateKey;

  // Export the public key as JWK and build the local in-memory JWKS.
  const publicJwk = await exportJWK(kp.publicKey);
  localJWKS = createLocalJWKSet({
    keys: [{ ...publicJwk, use: "sig", alg: "RS256", kid: TEST_KID }],
  });
  jwksProxy = localJWKS;

  // Second keypair for bad-signature test — NOT added to the JWKS.
  const kp2 = await generateKeyPair("RS256");
  otherPrivateKey = kp2.privateKey;
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("jwtMiddleware", () => {
  // ─── (a) Valid token passes and sets context variables ───────────────────

  it("(a) valid RS256 token with correct issuer — passes, sets userId and email", async () => {
    const handlerRan = { value: false };
    const app = buildApp(handlerRan);

    const jwt = await signValid({ permEpoch: 7 });
    const res = await app.request("/protected", {
      headers: { Authorization: `Bearer ${jwt}` },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      userId: string;
      email: string;
      permEpoch: number;
    };
    expect(body.userId).toBe("user-abc-123");
    expect(body.email).toBe("alice@example.com");
    // T6/ADR-0014: perm_epoch is read straight off the verified payload.
    expect(body.permEpoch).toBe(7);
    // Handler MUST have run — verify the middleware passed through.
    expect(handlerRan.value).toBe(true);
  });

  // ─── (h) perm_epoch claim handling (T6, ADR-0014) ─────────────────────────

  it("(h) token with no 'perm_epoch' claim — passes, permEpoch defaults to 0", async () => {
    const handlerRan = { value: false };
    const app = buildApp(handlerRan);

    // signValid() with no `permEpoch` override omits the claim entirely.
    const jwt = await signValid();
    const res = await app.request("/protected", {
      headers: { Authorization: `Bearer ${jwt}` },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { permEpoch: number };
    expect(body.permEpoch).toBe(0);
    expect(handlerRan.value).toBe(true);
  });

  it("(h2) token with perm_epoch: 0 explicitly — passes, permEpoch is 0", async () => {
    const handlerRan = { value: false };
    const app = buildApp(handlerRan);

    const jwt = await signValid({ permEpoch: 0 });
    const res = await app.request("/protected", {
      headers: { Authorization: `Bearer ${jwt}` },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { permEpoch: number };
    expect(body.permEpoch).toBe(0);
    expect(handlerRan.value).toBe(true);
  });

  // ─── (b) Missing / malformed Authorization header → 401 ─────────────────

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

    // SECURITY: guard must have stopped execution — handler must NOT have run.
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

  // ─── (c) Expired token → 401 ─────────────────────────────────────────────

  it("(c) expired token — 401, handler does not run", async () => {
    const handlerRan = { value: false };
    const app = buildApp(handlerRan);

    // Set expiry 10 seconds in the past.
    const pastExp = Math.floor(Date.now() / 1000) - 10;
    const jwt = await signValid({ expiresIn: pastExp });

    const res = await app.request("/protected", {
      headers: { Authorization: `Bearer ${jwt}` },
    });

    expect(res.status).toBe(401);
    // SECURITY: handler must NOT have run.
    expect(handlerRan.value).toBe(false);
  });

  // ─── (d) Wrong issuer → 401 ──────────────────────────────────────────────

  it("(d) wrong issuer — 401, handler does not run", async () => {
    const handlerRan = { value: false };
    const app = buildApp(handlerRan);

    const jwt = await signValid({ issuer: "https://attacker.example.com" });
    const res = await app.request("/protected", {
      headers: { Authorization: `Bearer ${jwt}` },
    });

    expect(res.status).toBe(401);
    // SECURITY: wrong issuer must be rejected — handler must NOT have run.
    expect(handlerRan.value).toBe(false);
  });

  // ─── (d2) Missing audience claim → 401 (ADR-0010) ────────────────────────

  it("(d2) token with no 'aud' claim at all — 401, handler does not run (ADR-0010)", async () => {
    const handlerRan = { value: false };
    const app = buildApp(handlerRan);

    // audience: null omits setAudience() entirely — simulates a pre-ADR-0010
    // token that predates the claim.
    const jwt = await signValid({ audience: null });
    const res = await app.request("/protected", {
      headers: { Authorization: `Bearer ${jwt}` },
    });

    expect(res.status).toBe(401);
    // SECURITY: a token missing 'aud' must be rejected — handler must NOT run.
    expect(handlerRan.value).toBe(false);
  });

  // ─── (d3) Wrong audience claim → 401 (ADR-0010) ──────────────────────────

  it("(d3) token with a different (wrong) 'aud' value — 401, handler does not run (ADR-0010)", async () => {
    const handlerRan = { value: false };
    const app = buildApp(handlerRan);

    const jwt = await signValid({ audience: "some-other-service" });
    const res = await app.request("/protected", {
      headers: { Authorization: `Bearer ${jwt}` },
    });

    expect(res.status).toBe(401);
    // SECURITY: a wrong audience must be rejected — handler must NOT run.
    // This is the concrete cross-service-replay regression guard: a token
    // minted for a different resource server (e.g. estimai-api or notify-api)
    // must not be accepted here.
    expect(handlerRan.value).toBe(false);
  });

  // ─── (e) Bad signature (signed with a DIFFERENT key) → 401 ──────────────

  it("(e) bad signature (signed with a different RS256 key) — 401, handler does not run", async () => {
    const handlerRan = { value: false };
    const app = buildApp(handlerRan);

    // otherPrivateKey is NOT in the JWKS — the local JWKS only has the public key
    // for `privateKey`. Signature verification MUST fail.
    const jwt = await signValid({ privateKeyOverride: otherPrivateKey });
    const res = await app.request("/protected", {
      headers: { Authorization: `Bearer ${jwt}` },
    });

    expect(res.status).toBe(401);
    // SECURITY: bad signature must be rejected — handler must NOT have run.
    expect(handlerRan.value).toBe(false);
  });

  // ─── (f) Algorithm confusion — alg:none and non-RS256 → 401 ─────────────

  it("(f) alg:none token — 401, algorithm-confusion attack rejected, handler does not run", async () => {
    const handlerRan = { value: false };
    const app = buildApp(handlerRan);

    // UnsecuredJWT produces a token with "alg":"none" — a classic attack vector
    // against libraries that do not pin the algorithm.
    const jwt = new UnsecuredJWT({
      email: "alice@example.com",
      sub: "user-abc-123",
    })
      .setIssuer(TEST_ISSUER)
      .setExpirationTime("1h")
      .encode();

    const res = await app.request("/protected", {
      headers: { Authorization: `Bearer ${jwt}` },
    });

    expect(res.status).toBe(401);
    // Confirm it is a well-formed Problem JSON response, not an unhandled error.
    const body = (await res.json()) as { status: number; type: string };
    expect(body.status).toBe(401);
    expect(body.type).toBe("https://httpstatuses.com/401");

    // SECURITY: alg:none must not bypass the middleware — handler must NOT run.
    expect(handlerRan.value).toBe(false);
  });

  it("(f2) HS256 token (algorithm-confusion, non-RS256) — 401, handler does not run", async () => {
    const handlerRan = { value: false };
    const app = buildApp(handlerRan);

    const { generateSecret } = await import("jose");
    const hmacKey = await generateSecret("HS256");

    // HS256 token — must be rejected because the middleware pins algorithms: ['RS256'].
    const jwt = await new SignJWT({ email: "alice@example.com" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(TEST_ISSUER)
      .setSubject("user-abc-123")
      .setExpirationTime("1h")
      .sign(hmacKey);

    const res = await app.request("/protected", {
      headers: { Authorization: `Bearer ${jwt}` },
    });

    expect(res.status).toBe(401);
    // SECURITY: HS256 must be rejected by the RS256 algorithm pin.
    expect(handlerRan.value).toBe(false);
  });

  // ─── (g) No DB access for unauthenticated requests ───────────────────────

  it("(g) unauthenticated requests — no database access occurs", async () => {
    // Spy on the Prisma client's $queryRaw as a sentinel for any DB access.
    // The middleware has zero import of db — this test proves it behaviourally.
    const dbModule = await import("../lib/db");
    const querySpy = spyOn(dbModule.db, "$queryRaw").mockResolvedValue([]);

    const handlerRan = { value: false };
    const app = buildApp(handlerRan);

    // Case 1: no token at all.
    const res1 = await app.request("/protected");
    expect(res1.status).toBe(401);
    expect(querySpy).not.toHaveBeenCalled();

    // Case 2: syntactically invalid JWT string.
    const res2 = await app.request("/protected", {
      headers: { Authorization: "Bearer not-a-real-jwt" },
    });
    expect(res2.status).toBe(401);
    expect(querySpy).not.toHaveBeenCalled();

    // Case 3: valid structure but expired.
    const pastExp = Math.floor(Date.now() / 1000) - 10;
    const expiredJwt = await signValid({ expiresIn: pastExp });
    const res3 = await app.request("/protected", {
      headers: { Authorization: `Bearer ${expiredJwt}` },
    });
    expect(res3.status).toBe(401);
    expect(querySpy).not.toHaveBeenCalled();

    // None of the rejection paths ran the handler.
    expect(handlerRan.value).toBe(false);

    querySpy.mockRestore();
  });
});
