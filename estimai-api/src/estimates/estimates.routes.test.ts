/**
 * Integration tests for the Estimates CRUD endpoints (T4, specs/001-estimate-persistence).
 *
 * Strategy
 * ────────
 * - Real Postgres (compose, host:5435, database: estimai) — no DB mocking.
 * - Fixture RS256 keypair generated in beforeAll; a local in-memory JWKS replaces
 *   createRemoteJWKSet via mock.module() (same pattern as jwt.middleware.test.ts).
 * - Two fixture users: USER_A and USER_B. IDOR tests (AC-4.1) use USER_B's JWT
 *   to attempt access to USER_A's estimates.
 * - Test data is cleaned up per-test (deleteMany by userId) so runs are repeatable.
 *
 * AC coverage
 * ───────────
 * AC-1.1  POST → GET/{id}: content deep-equals what was sent (+ name/author)
 * AC-1.2  POST → PUT edits → GET list: 1 item, same id, updatedAt advanced, content reflects edit
 * AC-2.1  GET /estimates: returns name + updatedAt + id for each saved estimate
 * AC-2.3  GET /estimates for fresh user (no estimates): returns []
 * AC-3.1  DELETE → 204 → GET/{id}: 404
 * AC-4.1  IDOR — user B cannot read/update/delete user A's estimates (→ 404, not 200/403)
 * AC-4.2  No/invalid JWT → 401 on each endpoint
 *
 * SECURITY PROPERTY (AC-4.1)
 * ──────────────────────────
 * Every cross-user test is structured so that removing the `userId` predicate from
 * the repo query would change the result from 404 to 200/204, making the test FAIL.
 * This is the ownership invariant — the tests are only useful if they break without
 * the scoping.
 */

import { describe, it, expect, beforeAll, afterEach, mock } from "bun:test";
import { Hono } from "hono";
import {
  generateKeyPair,
  exportJWK,
  SignJWT,
  createLocalJWKSet,
} from "jose";

// ─── Fixture keypair & module mock ───────────────────────────────────────────

let userAPrivateKey: CryptoKey;
let userBPrivateKey: CryptoKey;
let userCPrivateKey: CryptoKey;

// Local in-memory JWKS used by the mocked jwtMiddleware.
// Type is the ReturnType of createLocalJWKSet from jose.
let localJWKS: Awaited<ReturnType<typeof createLocalJWKSet>>;

// Each user gets its own kid to avoid ERR_JWKS_MULTIPLE_MATCHING_KEYS when
// two public keys share the same kid in the in-memory JWKS.
const TEST_KID_A = "operai-auth-rs256-v1";
const TEST_KID_B = "operai-auth-rs256-v2";
// USER_C (T6, specs/013-estimate-sharing) — a third fixture user with NO
// relationship (no ownership, no grant) to any estimate. Used for the
// AC-1.6 denial-taxonomy tests: an unrelated stranger must get 404,
// byte-identical to a genuinely absent id.
const TEST_KID_C = "operai-auth-rs256-v3";
const TEST_ISSUER = "http://localhost:3001";
const TEST_AUDIENCE = "operai-suite"; // ADR-0010 — must match AUTH_AUDIENCE below

const USER_A_ID = "test-user-a-t4";
const USER_B_ID = "test-user-b-t4";
const USER_C_ID = "test-user-c-t6";
const USER_A_EMAIL = "user-a-t4@example.com";
const USER_B_EMAIL = "user-b-t4@example.com";
const USER_C_EMAIL = "user-c-t6@example.com";

// Proxy so we can swap the local JWKS after beforeAll runs.
//
// Strategy: instead of mocking jose (which collides with jwt.middleware.test.ts's
// mock.module("jose") when both files run in the same bun worker process), we mock
// the JWT middleware module itself. This replaces the already-imported jose-based
// middleware with our own implementation that verifies tokens against our local
// JWKS — no jose module replacement needed.
let jwksProxy: typeof localJWKS | null = null;

mock.module("@/auth/jwt.middleware", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createMiddleware } = require("hono/factory") as typeof import("hono/factory");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const jose = require("jose") as typeof import("jose");

  const jwtMiddleware = createMiddleware<{ Variables: { userId: string; email: string } }>(
    async (c, next) => {
      const authHeader = c.req.header("Authorization");
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return Response.json(
          { type: "https://httpstatuses.com/401", title: "Unauthorized", status: 401, detail: "A valid Bearer token is required", instance: c.req.path },
          { status: 401 },
        );
      }
      const token = authHeader.slice(7);
      if (!token) {
        return Response.json(
          { type: "https://httpstatuses.com/401", title: "Unauthorized", status: 401, detail: "A valid Bearer token is required", instance: c.req.path },
          { status: 401 },
        );
      }
      try {
        if (!jwksProxy) throw new Error("JWKS proxy not initialised");
        const { payload } = await jose.jwtVerify(token, jwksProxy, {
          issuer: TEST_ISSUER,
          audience: TEST_AUDIENCE, // ADR-0010 — mirrors jwt.middleware.ts's env.AUTH_AUDIENCE pin
          algorithms: ["RS256"],
        });
        const userId = payload.sub;
        const email = typeof payload.email === "string" ? payload.email : undefined;
        if (!userId || !email) {
          return Response.json(
            { type: "https://httpstatuses.com/401", title: "Unauthorized", status: 401, detail: "Missing required claims", instance: c.req.path },
            { status: 401 },
          );
        }
        c.set("userId", userId);
        c.set("email", email);
        return next();
      } catch {
        return Response.json(
          { type: "https://httpstatuses.com/401", title: "Unauthorized", status: 401, detail: "The provided token is invalid or has expired", instance: c.req.path },
          { status: 401 },
        );
      }
    }
  );

  return { jwtMiddleware, JwtVariables: {} };
});

// Set env vars before any module is imported (env.ts runs at import time).
//
// DATABASE_URL is loaded from the project's .env via dotenv before any other
// env var assignment. This ensures the real compose DB credentials are used
// even if a previous test file (jwt.middleware.test.ts) clobbered the value with
// a fake DATABASE_URL — bun processes test files sequentially in the same process,
// so environment mutations from earlier files persist.
//
// We use dotenv's config() with override:true to always restore the real value.
import { config as dotenvConfig } from "dotenv";
dotenvConfig({
  path: new URL("../../.env", import.meta.url).pathname,
  override: true,
});

process.env["ALLOWED_ORIGINS"] = "http://localhost:5173";
process.env["AUTH_JWKS_URL"] = "http://localhost:3001/.well-known/jwks.json";
process.env["AUTH_ISSUER"] = TEST_ISSUER;
process.env["AUTH_AUDIENCE"] = TEST_AUDIENCE;
process.env["NODE_ENV"] = "test";
// Required since T5 (specs/013-estimate-sharing) — env.ts now validates these
// at module-eval time regardless of whether this test file exercises them.
process.env["AUTH_BASE_URL"] ??= "http://localhost:3001";
process.env["NOTIFY_INTERNAL_TOKEN"] ??=
  "test-notify-internal-token-at-least-32-characters";
process.env["NOTIFY_INTERNAL_URL"] ??= "http://localhost:8081";

// Create a dedicated Prisma client with the real DATABASE_URL loaded from .env
// BEFORE importing anything that touches @/lib/db.
//
// When both test files run together, jwt.middleware.test.ts sets
// process.env.DATABASE_URL to a fake value ("test:test@..."). By the time this
// test file runs, dotenv has restored the real DATABASE_URL, but @/lib/db may have
// already been cached as a module with the wrong connection string.
//
// We mock @/lib/db to provide a fresh Prisma client using the restored URL, so
// estimates.repo.ts (which imports db) uses the real compose DB.
const { PrismaClient } = await import("@/lib/generated/prisma/client");
const { PrismaPg } = await import("@prisma/adapter-pg");

const realDatabaseUrl = process.env["DATABASE_URL"]!;

const freshAdapter = new PrismaPg({ connectionString: realDatabaseUrl });
const freshDb = new PrismaClient({ adapter: freshAdapter });

mock.module("@/lib/db", () => ({
  db: freshDb,
}));

// Dynamic imports ensure the mocks are in place first.
const { estimatesRouter, importEstimatesRouter } = await import("./estimates.routes");

// Use the same freshDb for test cleanup.
const testDb = freshDb;

// ─── Minimal Hono app for testing ────────────────────────────────────────────

const buildApp = () => {
  const app = new Hono();
  // importEstimatesRouter is mounted first (mirrors index.ts) so its larger
  // bodyLimit is in effect for /estimates/import independently of estimatesRouter.
  app.route("/", importEstimatesRouter);
  app.route("/", estimatesRouter);
  return app;
};

// ─── JWT helpers ─────────────────────────────────────────────────────────────

const signToken = async (
  privateKey: CryptoKey,
  kid: string,
  sub: string,
  email: string,
  // ADR-0010: `aud` claim. `null` omits it (pre-ADR-0010 token shape);
  // defaults to the correct TEST_AUDIENCE so every existing caller keeps
  // minting valid tokens without change.
  audience: string | null = TEST_AUDIENCE,
): Promise<string> => {
  const jwt = new SignJWT({ email })
    .setProtectedHeader({ alg: "RS256", kid })
    .setIssuer(TEST_ISSUER)
    .setSubject(sub)
    .setExpirationTime("1h");

  if (audience !== null) {
    jwt.setAudience(audience);
  }

  return jwt.sign(privateKey);
};

// Convenience wrappers — each user signs with their own keypair + kid.
const tokenA = () =>
  signToken(userAPrivateKey, TEST_KID_A, USER_A_ID, USER_A_EMAIL);
const tokenB = () =>
  signToken(userBPrivateKey, TEST_KID_B, USER_B_ID, USER_B_EMAIL);
const tokenC = () =>
  signToken(userCPrivateKey, TEST_KID_C, USER_C_ID, USER_C_EMAIL);

const bearerHeader = (token: string) => ({
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
});

// ─── Fixture content ─────────────────────────────────────────────────────────

const makeContent = (label = "v1") => ({
  params: {
    parallelism: 0.7,
    sprintDays: 10,
    workingDaysMonth: 20,
    qaDeployDays: 0,
    qaTestDays: 0,
    pmDays: 0,
    aiCostCoef: 10,
    aiGain: 0.3,
  },
  releases: [{ id: "rel-1", name: `Release ${label}`, fte: 2 }],
  acts: [
    {
      id: "act-1",
      num: 1,
      epic: "Auth",
      act: `Login (${label})`,
      prof: "Backend Dev",
      o: 1,
      ml: 2,
      p: 4,
      risk: 0.1,
      release: "rel-1",
    },
  ],
});

// ─── Setup ───────────────────────────────────────────────────────────────────

beforeAll(async () => {
  // Generate THREE fixture RS256 keypairs: user A, user B, and user C (T6 —
  // a third party with NO relationship to any estimate, for the denial-
  // taxonomy tests). Each key gets its own kid to avoid
  // ERR_JWKS_MULTIPLE_MATCHING_KEYS.
  const kpA = await generateKeyPair("RS256", { extractable: true });
  userAPrivateKey = kpA.privateKey;
  const pubJwkA = await exportJWK(kpA.publicKey);

  const kpB = await generateKeyPair("RS256", { extractable: true });
  userBPrivateKey = kpB.privateKey;
  const pubJwkB = await exportJWK(kpB.publicKey);

  const kpC = await generateKeyPair("RS256", { extractable: true });
  userCPrivateKey = kpC.privateKey;
  const pubJwkC = await exportJWK(kpC.publicKey);

  // Each key registered with its own kid — jose resolves the correct key per token.
  localJWKS = createLocalJWKSet({
    keys: [
      { ...pubJwkA, use: "sig", alg: "RS256", kid: TEST_KID_A },
      { ...pubJwkB, use: "sig", alg: "RS256", kid: TEST_KID_B },
      { ...pubJwkC, use: "sig", alg: "RS256", kid: TEST_KID_C },
    ],
  });
  jwksProxy = localJWKS;
});

// Clean up test data after each test to keep runs idempotent. Only A/B/C's
// OWNED estimates need explicit cleanup — EstimateCollaborator rows cascade
// away with their estimate (AC-9.1, T4's onDelete: Cascade), and B/C never
// own an estimate in the T6 tests below (only grants).
afterEach(async () => {
  await testDb.estimate.deleteMany({
    where: { userId: { in: [USER_A_ID, USER_B_ID, USER_C_ID] } },
  });
});

// ─── AC-1.1: POST → GET/{id} deep-equals content + name/author ───────────────

describe("AC-1.1 — create then fetch content round-trip", () => {
  it("POST /estimates → 201, then GET /estimates/{id} → content deep-equals sent payload", async () => {
    const app = buildApp();
    const jwt = await tokenA();
    const content = makeContent("ac11");

    // Create
    const postRes = await app.request("/estimates", {
      method: "POST",
      headers: bearerHeader(jwt),
      body: JSON.stringify({ name: "AC-1.1 Estimate", author: "Alice", content }),
    });
    expect(postRes.status).toBe(201);
    const created = (await postRes.json()) as {
      id: string;
      name: string;
      author: string;
      content: unknown;
      createdAt: string;
      updatedAt: string;
    };
    expect(created.name).toBe("AC-1.1 Estimate");
    expect(created.author).toBe("Alice");
    expect(created.id).toBeTruthy();
    expect(typeof created.createdAt).toBe("string");

    // Fetch back by id
    const getRes = await app.request(`/estimates/${created.id}`, {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    expect(getRes.status).toBe(200);
    const fetched = (await getRes.json()) as { content: unknown };

    // AC-1.1: semantic deep-equal — JSONB preserves values (not key order/whitespace)
    expect(fetched.content).toEqual(content);
  });
});

// ─── AC-1.2: POST → PUT → GET list: 1 item, same id, updatedAt advanced ──────

describe("AC-1.2 — update in place, no duplicate, updatedAt advances", () => {
  it("POST → PUT (different content) → GET list has exactly 1 item, same id, updatedAt advanced", async () => {
    const app = buildApp();
    const jwt = await tokenA();
    const originalContent = makeContent("original");
    const editedContent = makeContent("edited");

    // Create
    const postRes = await app.request("/estimates", {
      method: "POST",
      headers: bearerHeader(jwt),
      body: JSON.stringify({
        name: "AC-1.2 Estimate",
        author: "Alice",
        content: originalContent,
      }),
    });
    expect(postRes.status).toBe(201);
    const created = (await postRes.json()) as {
      id: string;
      updatedAt: string;
    };
    const originalUpdatedAt = created.updatedAt;

    // Wait 1 ms so updatedAt can advance (Postgres timestamp has ms precision).
    await Bun.sleep(10);

    // Update
    const putRes = await app.request(`/estimates/${created.id}`, {
      method: "PUT",
      headers: bearerHeader(jwt),
      body: JSON.stringify({
        name: "AC-1.2 Estimate (edited)",
        author: "Alice",
        content: editedContent,
      }),
    });
    expect(putRes.status).toBe(200);
    const updated = (await putRes.json()) as {
      id: string;
      updatedAt: string;
      content: unknown;
    };

    // Same id — no duplicate
    expect(updated.id).toBe(created.id);

    // updatedAt must have advanced (non-vacuous: we assert it is strictly later)
    expect(new Date(updated.updatedAt).getTime()).toBeGreaterThan(
      new Date(originalUpdatedAt).getTime(),
    );

    // Content reflects the edit
    expect(updated.content).toEqual(editedContent);

    // List must contain exactly 1 item
    const listRes = await app.request("/estimates", {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as Array<{
      id: string;
      name: string;
      updatedAt: string;
    }>;
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe(created.id);
    expect(list[0]?.name).toBe("AC-1.2 Estimate (edited)");
  });
});

// ─── AC-2.1: List returns name + updatedAt + id ───────────────────────────────

describe("AC-2.1 — list returns correct metadata for all saved estimates", () => {
  it("3 estimates for user A → GET /estimates returns 3 items with name + updatedAt + id", async () => {
    const app = buildApp();
    const jwt = await tokenA();

    // Seed 3 estimates
    for (let i = 1; i <= 3; i++) {
      const res = await app.request("/estimates", {
        method: "POST",
        headers: bearerHeader(jwt),
        body: JSON.stringify({
          name: `Estimate ${i}`,
          author: "Alice",
          content: makeContent(`v${i}`),
        }),
      });
      expect(res.status).toBe(201);
    }

    const listRes = await app.request("/estimates", {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as Array<{
      id: string;
      name: string;
      author: string;
      updatedAt: string;
    }>;

    expect(list).toHaveLength(3);

    // Every item must have id, name, and updatedAt (AC-2.1)
    for (const item of list) {
      expect(typeof item.id).toBe("string");
      expect(item.id).toBeTruthy();
      expect(typeof item.name).toBe("string");
      expect(item.name).toMatch(/^Estimate /);
      expect(typeof item.updatedAt).toBe("string");
      // ISO 8601 datetime
      expect(() => new Date(item.updatedAt)).not.toThrow();
    }
  });
});

// ─── AC-2.3: Fresh user → [] ──────────────────────────────────────────────────

describe("AC-2.3 — fresh user (no estimates) gets empty list", () => {
  it("GET /estimates for a user with no estimates → 200 []", async () => {
    const app = buildApp();
    // Use user B who has no estimates yet (cleaned up by afterEach).
    const jwt = await tokenB();

    const res = await app.request("/estimates", {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
  });
});

// ─── AC-3.1: DELETE → 204 → GET/{id} → 404 ──────────────────────────────────

describe("AC-3.1 — delete removes the estimate", () => {
  it("POST → DELETE → 204; GET/{id} → 404; GET list excludes it", async () => {
    const app = buildApp();
    const jwt = await tokenA();

    // Create
    const postRes = await app.request("/estimates", {
      method: "POST",
      headers: bearerHeader(jwt),
      body: JSON.stringify({
        name: "AC-3.1 Estimate",
        author: "Alice",
        content: makeContent(),
      }),
    });
    expect(postRes.status).toBe(201);
    const { id } = (await postRes.json()) as { id: string };

    // Delete
    const delRes = await app.request(`/estimates/${id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${jwt}` },
    });
    expect(delRes.status).toBe(204);

    // Direct fetch → 404
    const getRes = await app.request(`/estimates/${id}`, {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    expect(getRes.status).toBe(404);
    const notFoundBody = (await getRes.json()) as { status: number; type: string };
    expect(notFoundBody.status).toBe(404);
    expect(notFoundBody.type).toBe("https://httpstatuses.com/404");

    // List → does not include deleted id
    const listRes = await app.request("/estimates", {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    const list = (await listRes.json()) as Array<{ id: string }>;
    expect(list.every((item) => item.id !== id)).toBe(true);
  });
});

// ─── AC-4.1: IDOR — user B cannot access user A's estimates ──────────────────

describe("AC-4.1 — IDOR: user B cannot read/update/delete user A's estimates", () => {
  /**
   * SECURITY INVARIANT
   * ──────────────────
   * The assertions below are structured so that if the `userId` scoping in the
   * repo were removed (i.e., `where: { id }` instead of `where: { id, userId }`),
   * the DB would return user A's row to user B and the status would be 200/204
   * instead of 404 — the test would FAIL.
   *
   * Concretely:
   *   - GET /estimates/{A-id} with B's token → repo returns null (not found because
   *     `userId = USER_B_ID` doesn't match the row's `userId = USER_A_ID`) → 404.
   *     Without scoping: findFirst({ where: { id } }) finds the row → 200.
   *   - PUT /estimates/{A-id} with B's token → repo returns null → 404.
   *     Without scoping: update proceeds → 200.
   *   - DELETE /estimates/{A-id} with B's token → repo returns false → 404.
   *     Without scoping: delete proceeds → 204.
   *   - GET /estimates with B's token → repo returns only B's rows → excludes A's.
   *     Without scoping: findMany({ where: { userId: B } }) still filters — this
   *     one always scopes by userId, so the list test is always correct.
   */

  it("GET list with B's token excludes A's estimate", async () => {
    const app = buildApp();
    const jwtA = await tokenA();
    const jwtB = await tokenB();

    // Seed an estimate for A
    const postRes = await app.request("/estimates", {
      method: "POST",
      headers: bearerHeader(jwtA),
      body: JSON.stringify({
        name: "User A's private estimate",
        author: "Alice",
        content: makeContent(),
      }),
    });
    expect(postRes.status).toBe(201);
    const { id: aId } = (await postRes.json()) as { id: string };

    // B's list must not contain A's estimate id
    const listRes = await app.request("/estimates", {
      headers: { Authorization: `Bearer ${jwtB}` },
    });
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as Array<{ id: string }>;
    expect(list.every((item) => item.id !== aId)).toBe(true);
  });

  it("GET /estimates/{A-id} with B's token → 404 (not 200, not 403)", async () => {
    const app = buildApp();
    const jwtA = await tokenA();
    const jwtB = await tokenB();

    const postRes = await app.request("/estimates", {
      method: "POST",
      headers: bearerHeader(jwtA),
      body: JSON.stringify({
        name: "User A's private estimate",
        author: "Alice",
        content: makeContent(),
      }),
    });
    expect(postRes.status).toBe(201);
    const { id: aId } = (await postRes.json()) as { id: string };

    // CRITICAL: B must receive 404, not 200 or 403.
    // Without userId scoping in getEstimateById, this would return 200.
    const res = await app.request(`/estimates/${aId}`, {
      headers: { Authorization: `Bearer ${jwtB}` },
    });
    expect(res.status).toBe(404);

    const body = (await res.json()) as { status: number; type: string };
    expect(body.status).toBe(404);
    expect(body.type).toBe("https://httpstatuses.com/404");
  });

  it("PUT /estimates/{A-id} with B's token → 404 (not 200)", async () => {
    const app = buildApp();
    const jwtA = await tokenA();
    const jwtB = await tokenB();

    const postRes = await app.request("/estimates", {
      method: "POST",
      headers: bearerHeader(jwtA),
      body: JSON.stringify({
        name: "User A's private estimate",
        author: "Alice",
        content: makeContent(),
      }),
    });
    expect(postRes.status).toBe(201);
    const { id: aId } = (await postRes.json()) as { id: string };

    // CRITICAL: B's PUT must return 404.
    // Without userId scoping in updateEstimate, this would succeed and return 200.
    const res = await app.request(`/estimates/${aId}`, {
      method: "PUT",
      headers: bearerHeader(jwtB),
      body: JSON.stringify({
        name: "HIJACKED",
        author: "Eve",
        content: makeContent("hijack"),
      }),
    });
    expect(res.status).toBe(404);

    // Verify A's estimate is unchanged (it was not hijacked)
    const getRes = await app.request(`/estimates/${aId}`, {
      headers: { Authorization: `Bearer ${jwtA}` },
    });
    expect(getRes.status).toBe(200);
    const fetched = (await getRes.json()) as { name: string };
    expect(fetched.name).toBe("User A's private estimate"); // unchanged
  });

  it("DELETE /estimates/{A-id} with B's token → 404 (not 204)", async () => {
    const app = buildApp();
    const jwtA = await tokenA();
    const jwtB = await tokenB();

    const postRes = await app.request("/estimates", {
      method: "POST",
      headers: bearerHeader(jwtA),
      body: JSON.stringify({
        name: "User A's private estimate",
        author: "Alice",
        content: makeContent(),
      }),
    });
    expect(postRes.status).toBe(201);
    const { id: aId } = (await postRes.json()) as { id: string };

    // CRITICAL: B's DELETE must return 404.
    // Without userId scoping in deleteEstimate, this would succeed and return 204.
    const delRes = await app.request(`/estimates/${aId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${jwtB}` },
    });
    expect(delRes.status).toBe(404);

    // Prove A's estimate still exists (was not deleted by B)
    const getRes = await app.request(`/estimates/${aId}`, {
      headers: { Authorization: `Bearer ${jwtA}` },
    });
    expect(getRes.status).toBe(200); // still there — B's delete did NOT remove it
  });
});

// ─── Atomic write-path ownership (OWASP A01 regression guard) ────────────────
//
// These tests verify that the write operations themselves are owner-scoped, not
// just protected by a prior ownership check.  They would FAIL if the `userId`
// predicate were removed from the updateMany / deleteMany calls in the repo:
//   - Without `userId` in updateMany: B's PUT would mutate A's row and return 200.
//   - Without `userId` in deleteMany: B's DELETE would remove A's row and return 204.
// The subsequent assertions on the row content / existence are the falsifiable proof.

describe("Atomic ownership — write path is owner-scoped (A01 regression guard)", () => {
  it("PUT from user B does NOT mutate user A's row — content byte-for-byte unchanged", async () => {
    const app = buildApp();
    const jwtA = await tokenA();
    const jwtB = await tokenB();
    const originalContent = makeContent("original");

    // Seed: user A creates an estimate
    const postRes = await app.request("/estimates", {
      method: "POST",
      headers: bearerHeader(jwtA),
      body: JSON.stringify({
        name: "Owner A estimate",
        author: "Alice",
        content: originalContent,
      }),
    });
    expect(postRes.status).toBe(201);
    const { id: aId, updatedAt: originalUpdatedAt } = (await postRes.json()) as {
      id: string;
      updatedAt: string;
    };

    // Attack: user B attempts to overwrite A's estimate
    const attackRes = await app.request(`/estimates/${aId}`, {
      method: "PUT",
      headers: bearerHeader(jwtB),
      body: JSON.stringify({
        name: "HIJACKED by B",
        author: "Eve",
        content: makeContent("hijack"),
      }),
    });
    // The updateMany where:{id, userId:B} matches 0 rows → NotFoundError → 404.
    // If userId were absent from the write predicate, this would return 200.
    expect(attackRes.status).toBe(404);

    // Proof: A's row is byte-for-byte unchanged — name, content, and updatedAt identical.
    const verifyRes = await app.request(`/estimates/${aId}`, {
      headers: { Authorization: `Bearer ${jwtA}` },
    });
    expect(verifyRes.status).toBe(200);
    const row = (await verifyRes.json()) as {
      name: string;
      author: string;
      content: unknown;
      updatedAt: string;
    };
    expect(row.name).toBe("Owner A estimate");
    expect(row.author).toBe("Alice");
    expect(row.content).toEqual(originalContent);
    // updatedAt must not have advanced — the write never touched the row.
    expect(row.updatedAt).toBe(originalUpdatedAt);
  });

  it("DELETE from user B does NOT remove user A's row — row still present and unchanged", async () => {
    const app = buildApp();
    const jwtA = await tokenA();
    const jwtB = await tokenB();
    const originalContent = makeContent("to-survive");

    // Seed: user A creates an estimate
    const postRes = await app.request("/estimates", {
      method: "POST",
      headers: bearerHeader(jwtA),
      body: JSON.stringify({
        name: "Owner A estimate for delete guard",
        author: "Alice",
        content: originalContent,
      }),
    });
    expect(postRes.status).toBe(201);
    const { id: aId } = (await postRes.json()) as { id: string };

    // Attack: user B attempts to delete A's estimate
    const attackRes = await app.request(`/estimates/${aId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${jwtB}` },
    });
    // The deleteMany where:{id, userId:B} matches 0 rows → NotFoundError → 404.
    // If userId were absent from the write predicate, this would return 204 and
    // the subsequent GET would return 404 — the test would fail.
    expect(attackRes.status).toBe(404);

    // Proof: A's row still exists and content is unchanged.
    const verifyRes = await app.request(`/estimates/${aId}`, {
      headers: { Authorization: `Bearer ${jwtA}` },
    });
    expect(verifyRes.status).toBe(200);
    const row = (await verifyRes.json()) as { name: string; content: unknown };
    expect(row.name).toBe("Owner A estimate for delete guard");
    expect(row.content).toEqual(originalContent);
  });
});

// ─── Round-trip: strip() drops no documented field (A03/A04 regression guard) ──
//
// This test creates an estimate with ALL documented UI fields populated (full
// Activity and Release fields, all Parameters fields) and verifies the GET
// response deep-equals the posted content.  If .strip() were silently dropping
// any field the UI actually sends, this test would FAIL.

describe("Schema strip() round-trip — no documented field is dropped (AC-1.1 + A03)", () => {
  it("full realistic estimate with all documented fields survives POST→GET deep-equal", async () => {
    const app = buildApp();
    const jwt = await tokenA();

    const fullContent = {
      params: {
        parallelism: 0.7,
        sprintDays: 10,
        workingDaysMonth: 20,
        qaDeployDays: 1,
        qaTestDays: 2,
        pmDays: 0.5,
        aiCostCoef: 10,
        aiGain: 0.3,
      },
      releases: [
        { id: "rel-strip-1", name: "Release Alpha", fte: 3 },
        { id: "rel-strip-2", name: "Release Beta", fte: 2 },
      ],
      acts: [
        {
          id: "act-strip-1",
          num: "1",
          epic: "Authentication",
          act: "Implement OAuth login",
          prof: "Backend Dev",
          o: 1,
          ml: 3,
          p: 6,
          risk: 0.15,
          aiGain: 0.4,
          notes: "Use Google + GitHub providers",
          release: "rel-strip-1",
        },
        {
          id: "act-strip-2",
          num: "2",
          epic: "UI",
          act: "Build dashboard layout",
          prof: "Frontend Dev",
          o: 2,
          ml: 4,
          p: 7,
          risk: 0.1,
          notes: "",
          release: "rel-strip-2",
        },
      ],
    };

    const postRes = await app.request("/estimates", {
      method: "POST",
      headers: bearerHeader(jwt),
      body: JSON.stringify({
        name: "Full round-trip estimate",
        author: "Strip Test",
        content: fullContent,
      }),
    });
    expect(postRes.status).toBe(201);
    const { id } = (await postRes.json()) as { id: string };

    const getRes = await app.request(`/estimates/${id}`, {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    expect(getRes.status).toBe(200);
    const fetched = (await getRes.json()) as { content: unknown };

    // AC-1.1 + strip() guard: every documented field must be present and equal.
    expect(fetched.content).toEqual(fullContent);
  });
});

// ─── T5 / AC-1.4: Per-estimate size guard ────────────────────────────────────
//
// MAX_ESTIMATE_BYTES defaults to 1 MiB (1048576 bytes). We build an over-size
// payload by padding the `notes` field of one activity to 1 200 000 bytes —
// provably > 1 MiB in UTF-8. The serialised form is then asserted by the test
// itself so the bound is never magic.
//
// In-limit content stays < 1 KiB so the regression tests are not affected.
//
// No env override needed: the default from env.ts (1048576) applies throughout.

// Build an over-size content by stacking 2500 releases each with a 500-char
// name (the schema max). Each release serialises to ~550 bytes;
// 2500 × 550 ≈ 1.375 MiB — deterministically > 1 MiB default cap.
// All individual field lengths are within their schema limits, so the 400
// from Zod validation is never triggered; only the 413 size guard fires.
const makeOverSizeContent = () => {
  const longName = "N".repeat(500); // matches z.string().max(500) on ReleaseSchema.name
  const releases = Array.from({ length: 2500 }, (_, i) => ({
    id: `rel-${i}`,
    name: longName,
    fte: 2,
  }));
  return {
    params: {
      parallelism: 0.7,
      sprintDays: 10,
      workingDaysMonth: 20,
      qaDeployDays: 0,
      qaTestDays: 0,
      pmDays: 0,
      aiCostCoef: 10,
      aiGain: 0.3,
    },
    releases,
    acts: [],
  };
};

describe("AC-1.4 — size guard fixture is deterministically over-limit", () => {
  it("makeOverSizeContent() serialises to > 1 MiB (guard for test determinism)", () => {
    const bytes = new TextEncoder().encode(JSON.stringify(makeOverSizeContent())).length;
    // Non-vacuous: explicitly verify the fixture is actually over the default 1 MiB limit.
    expect(bytes).toBeGreaterThan(1048576);
  });

  it("makeContent() serialises to < 1 KiB (in-limit regression guard)", () => {
    const bytes = new TextEncoder().encode(JSON.stringify(makeContent())).length;
    expect(bytes).toBeLessThan(1024);
  });
});

describe("AC-1.4 — POST with over-size content → 413 Problem, nothing persisted", () => {
  it("POST with content > MAX_ESTIMATE_BYTES → 413 Problem JSON with correct shape", async () => {
    const app = buildApp();
    const jwt = await tokenA();

    const res = await app.request("/estimates", {
      method: "POST",
      headers: bearerHeader(jwt),
      body: JSON.stringify({ name: "Over-limit estimate", author: "Alice", content: makeOverSizeContent() }),
    });

    expect(res.status).toBe(413);
    const body = (await res.json()) as {
      type: string;
      title: string;
      status: number;
      detail: string;
      instance: string;
    };
    expect(body.type).toBe("https://httpstatuses.com/413");
    expect(body.title).toBe("Payload Too Large");
    expect(body.status).toBe(413);
    expect(body.detail).toContain("Nothing was saved");
    expect(body.instance).toBe("/estimates");
  });

  it("POST with over-size content → GET /estimates count is unchanged (nothing persisted)", async () => {
    const app = buildApp();
    const jwt = await tokenA();

    // Count before
    const beforeListRes = await app.request("/estimates", {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    expect(beforeListRes.status).toBe(200);
    const before = (await beforeListRes.json()) as unknown[];
    const countBefore = before.length;

    // Over-size POST must fail
    const postRes = await app.request("/estimates", {
      method: "POST",
      headers: bearerHeader(jwt),
      body: JSON.stringify({ name: "Over-limit", author: "Alice", content: makeOverSizeContent() }),
    });
    expect(postRes.status).toBe(413);

    // Count after must equal count before — nothing was persisted
    const afterListRes = await app.request("/estimates", {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    expect(afterListRes.status).toBe(200);
    const after = (await afterListRes.json()) as unknown[];
    expect(after).toHaveLength(countBefore);
  });
});

describe("AC-1.4 — PUT with over-size content → 413 Problem, prior stored version intact", () => {
  it("PUT over-size content → 413; GET still returns the prior version unchanged (no partial write)", async () => {
    const app = buildApp();
    const jwt = await tokenA();
    const originalContent = makeContent("prior-version");

    // Create a valid in-limit estimate.
    const postRes = await app.request("/estimates", {
      method: "POST",
      headers: bearerHeader(jwt),
      body: JSON.stringify({ name: "Original estimate", author: "Alice", content: originalContent }),
    });
    expect(postRes.status).toBe(201);
    const { id, updatedAt: originalUpdatedAt } = (await postRes.json()) as {
      id: string;
      updatedAt: string;
    };

    // Attempt a PUT with over-size content — must be rejected.
    const putRes = await app.request(`/estimates/${id}`, {
      method: "PUT",
      headers: bearerHeader(jwt),
      body: JSON.stringify({ name: "Updated name", author: "Alice", content: makeOverSizeContent() }),
    });
    expect(putRes.status).toBe(413);
    const putBody = (await putRes.json()) as {
      type: string;
      title: string;
      status: number;
      detail: string;
    };
    expect(putBody.type).toBe("https://httpstatuses.com/413");
    expect(putBody.title).toBe("Payload Too Large");
    expect(putBody.status).toBe(413);
    expect(putBody.detail).toContain("Nothing was saved");

    // GET must return the ORIGINAL version — no partial write (AC-1.4).
    const getRes = await app.request(`/estimates/${id}`, {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    expect(getRes.status).toBe(200);
    const fetched = (await getRes.json()) as {
      id: string;
      name: string;
      content: unknown;
      updatedAt: string;
    };
    // id is unchanged
    expect(fetched.id).toBe(id);
    // name is the ORIGINAL name, not "Updated name" from the failed PUT
    expect(fetched.name).toBe("Original estimate");
    // content deep-equals the original (not the oversized one)
    expect(fetched.content).toEqual(originalContent);
    // updatedAt has NOT advanced — the write never happened
    expect(fetched.updatedAt).toBe(originalUpdatedAt);
  });
});

describe("AC-1.4 regression — in-limit POST / PUT still return 201 / 200", () => {
  it("POST with in-limit content → 201 (size guard does not block valid payloads)", async () => {
    const app = buildApp();
    const jwt = await tokenA();

    const res = await app.request("/estimates", {
      method: "POST",
      headers: bearerHeader(jwt),
      body: JSON.stringify({ name: "In-limit estimate", author: "Alice", content: makeContent() }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string };
    expect(body.id).toBeTruthy();
  });

  it("PUT with in-limit content → 200 (size guard does not block valid payloads)", async () => {
    const app = buildApp();
    const jwt = await tokenA();

    const postRes = await app.request("/estimates", {
      method: "POST",
      headers: bearerHeader(jwt),
      body: JSON.stringify({ name: "In-limit estimate", author: "Alice", content: makeContent() }),
    });
    expect(postRes.status).toBe(201);
    const { id } = (await postRes.json()) as { id: string };

    const updatedContent = makeContent("updated-in-limit");
    const putRes = await app.request(`/estimates/${id}`, {
      method: "PUT",
      headers: bearerHeader(jwt),
      body: JSON.stringify({ name: "In-limit updated", author: "Alice", content: updatedContent }),
    });
    expect(putRes.status).toBe(200);
    const updated = (await putRes.json()) as { id: string; name: string };
    expect(updated.id).toBe(id);
    expect(updated.name).toBe("In-limit updated");
  });
});

describe("bodyLimit middleware — raw request body > 2 MiB → 413 before handler logic", () => {
  it("POST with a 3 MiB raw body → 413 Problem (bodyLimit middleware fires before handler)", async () => {
    const app = buildApp();
    const jwt = await tokenA();

    // Build a raw body that is ~3 MiB. It does not need to be a valid
    // EstimateUpsert — bodyLimit rejects before Zod validation or handler logic.
    // We use a large JSON string value to avoid any request parsing overhead.
    const rawBody = `{"name":"huge","author":"","content":"${"X".repeat(3 * 1024 * 1024)}"}`;

    const res = await app.request("/estimates", {
      method: "POST",
      headers: bearerHeader(jwt),
      body: rawBody,
    });

    expect(res.status).toBe(413);
    const body = (await res.json()) as { type: string; title: string; status: number };
    expect(body.type).toBe("https://httpstatuses.com/413");
    expect(body.title).toBe("Payload Too Large");
    expect(body.status).toBe(413);
  });
});

// ─── AC-1.4: No count cap — unlimited estimates per user ─────────────────────
//
// The spec explicitly states "No count quota anywhere (spec non-goal): unlimited
// number of estimates per user." We verify by creating N estimates in a loop
// and confirming all succeed.

describe("AC-1.4 — no count cap: multiple in-limit estimates all succeed", () => {
  it("loop: creating 5 estimates in sequence → all 201, all appear in list", async () => {
    const app = buildApp();
    const jwt = await tokenA();
    const N = 5;
    const ids: string[] = [];

    for (let i = 1; i <= N; i++) {
      const res = await app.request("/estimates", {
        method: "POST",
        headers: bearerHeader(jwt),
        body: JSON.stringify({
          name: `No-cap estimate ${i}`,
          author: "Alice",
          content: makeContent(`no-cap-${i}`),
        }),
      });
      // Every single creation must succeed — no quota blocks it.
      expect(res.status).toBe(201);
      const { id } = (await res.json()) as { id: string };
      ids.push(id);
    }

    // List must contain all N estimates (plus any from other tests — but
    // afterEach cleans up by userId, so only this test's estimates appear here).
    const listRes = await app.request("/estimates", {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as Array<{ id: string }>;
    // All created ids must be in the list
    for (const id of ids) {
      expect(list.some((item) => item.id === id)).toBe(true);
    }
    expect(list.length).toBeGreaterThanOrEqual(N);
  });
});

// ─── AC-4.2: No/invalid JWT → 401 on every endpoint ─────────────────────────

describe("AC-4.2 — unauthenticated requests rejected on all endpoints", () => {
  const endpoints: Array<{ method: string; path: string }> = [
    { method: "POST", path: "/estimates" },
    { method: "GET", path: "/estimates" },
    { method: "GET", path: "/estimates/some-id" },
    { method: "PUT", path: "/estimates/some-id" },
    { method: "DELETE", path: "/estimates/some-id" },
  ];

  for (const { method, path } of endpoints) {
    it(`${method} ${path} without Bearer → 401 Problem JSON`, async () => {
      const app = buildApp();
      const res = await app.request(path, {
        method,
        headers: { "Content-Type": "application/json" },
        body: method === "POST" || method === "PUT"
          ? JSON.stringify({ name: "x", author: "", content: makeContent() })
          : undefined,
      });
      expect(res.status).toBe(401);
      const body = (await res.json()) as { status: number; type: string; title: string };
      expect(body.status).toBe(401);
      expect(body.type).toBe("https://httpstatuses.com/401");
      expect(body.title).toBe("Unauthorized");
    });

    it(`${method} ${path} with invalid/expired Bearer → 401 Problem JSON`, async () => {
      const app = buildApp();
      const res = await app.request(path, {
        method,
        headers: {
          Authorization: "Bearer not-a-valid-jwt",
          "Content-Type": "application/json",
        },
        body: method === "POST" || method === "PUT"
          ? JSON.stringify({ name: "x", author: "", content: makeContent() })
          : undefined,
      });
      expect(res.status).toBe(401);
      const body = (await res.json()) as { status: number; type: string };
      expect(body.status).toBe(401);
      expect(body.type).toBe("https://httpstatuses.com/401");
    });
  }

  it("AC-4.2 follow-up: DB is unchanged after an unauthenticated POST attempt", async () => {
    const app = buildApp();
    const jwtA = await tokenA();

    // Unauthenticated POST — must fail
    const badRes = await app.request("/estimates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "should-not-persist",
        author: "Eve",
        content: makeContent(),
      }),
    });
    expect(badRes.status).toBe(401);

    // A's list should still be empty (nothing was persisted)
    const listRes = await app.request("/estimates", {
      headers: { Authorization: `Bearer ${jwtA}` },
    });
    expect(listRes.status).toBe(200);
    const list = await listRes.json();
    expect(list).toEqual([]);
  });
});

// ─── ADR-0010: JWT audience (`aud`) enforcement (T9, specs/005-notification-center) ──
//
// Closes the cross-service replay gap ADR-0005 deferred: a token missing the `aud`
// claim entirely, or carrying a value other than AUTH_AUDIENCE, must be rejected —
// even though its signature, issuer, and expiry are otherwise perfectly valid. This
// is the concrete regression guard for "a token minted for a different resource
// server must not be accepted here."

describe("ADR-0010 — audience (aud) claim enforcement", () => {
  it("token with no 'aud' claim at all — 401, nothing persisted", async () => {
    const app = buildApp();
    const jwtNoAud = await signToken(
      userAPrivateKey,
      TEST_KID_A,
      USER_A_ID,
      USER_A_EMAIL,
      null, // omit setAudience() entirely
    );

    const res = await app.request("/estimates", {
      headers: { Authorization: `Bearer ${jwtNoAud}` },
    });

    expect(res.status).toBe(401);
    const body = (await res.json()) as { status: number; type: string };
    expect(body.status).toBe(401);
    expect(body.type).toBe("https://httpstatuses.com/401");
  });

  it("token with a wrong 'aud' value — 401, nothing persisted", async () => {
    const app = buildApp();
    const jwtWrongAud = await signToken(
      userAPrivateKey,
      TEST_KID_A,
      USER_A_ID,
      USER_A_EMAIL,
      "some-other-resource-server",
    );

    const res = await app.request("/estimates", {
      headers: { Authorization: `Bearer ${jwtWrongAud}` },
    });

    expect(res.status).toBe(401);
    const body = (await res.json()) as { status: number; type: string };
    expect(body.status).toBe(401);
    expect(body.type).toBe("https://httpstatuses.com/401");
  });

  it("token with the correct 'aud' value (default tokenA()) — 200, list returned", async () => {
    const app = buildApp();
    const jwtA = await tokenA();

    const res = await app.request("/estimates", {
      headers: { Authorization: `Bearer ${jwtA}` },
    });

    // Correct audience — the request must pass the auth layer (200), regardless
    // of list contents (other tests may have created rows for USER_A_ID).
    expect(res.status).toBe(200);
  });

  it("POST /estimates with wrong 'aud' → 401 and the row is NOT persisted", async () => {
    const app = buildApp();
    const jwtWrongAud = await signToken(
      userAPrivateKey,
      TEST_KID_A,
      USER_A_ID,
      USER_A_EMAIL,
      "some-other-resource-server",
    );

    const postRes = await app.request("/estimates", {
      method: "POST",
      headers: bearerHeader(jwtWrongAud),
      body: JSON.stringify({
        name: "should-not-persist-wrong-aud",
        author: "Eve",
        content: makeContent(),
      }),
    });
    expect(postRes.status).toBe(401);

    // Confirm with a validly-audienced token that nothing was written.
    const jwtA = await tokenA();
    const listRes = await app.request("/estimates", {
      headers: { Authorization: `Bearer ${jwtA}` },
    });
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as Array<{ name: string }>;
    expect(list.some((e) => e.name === "should-not-persist-wrong-aud")).toBe(
      false,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// T6 — POST /estimates/import (AC-5.2, AC-5.4, specs/001-estimate-persistence)
// ═══════════════════════════════════════════════════════════════════════════════
//
// These tests share the fixture keypair, JWKS proxy, JWT helpers, and Hono app
// from the T4/T5 tests above (same file — no multi-file mock-module collision).
//
// SECURITY PROPERTIES TESTED
// ──────────────────────────
// Per-element isolation (AC-5.4):
//   One failing element must NOT abort/rollback the others. If the endpoint used a
//   single spanning transaction, the partial-failure test would fail (either all or
//   none succeed). The test asserts that good elements are retrievable via GET/{id}
//   even when a sibling element failed — impossible if the batch were rolled back.
//
// Ownership (AC-5.2 + AC-4.1):
//   All imported rows are created under the JWT sub (userId from jwt) — never from
//   any field in the request body. User B cannot see user A's imported estimates.
//
// Body smuggling guard (OWASP A01):
//   A body element with a `userId` or `id` field must be silently stripped
//   (EstimateUpsert has no such fields) and the row created under the JWT sub.
//
// Unauthenticated (AC-4.2): no/invalid JWT → 401; nothing written.
//
// Malformed envelope: missing or wrong `estimates` field → 400 Problem.

// ─── T6 fixture: over-size content for per-element size guard tests ───────────
//
// Identical construction to the T5 fixture above (2500 releases × 500-char name).
// Defined here separately so T6 tests are self-contained and don't depend on T5's
// helper being in scope (they are, but naming the intent explicitly is clearer).

const makeOverSizeContentForImport = () => {
  const longName = "N".repeat(500);
  const releases = Array.from({ length: 2500 }, (_, i) => ({
    id: `rel-import-${i}`,
    name: longName,
    fte: 2,
  }));
  return {
    params: {
      parallelism: 0.7,
      sprintDays: 10,
      workingDaysMonth: 20,
      qaDeployDays: 0,
      qaTestDays: 0,
      pmDays: 0,
      aiCostCoef: 10,
      aiGain: 0.3,
    },
    releases,
    acts: [],
  };
};

// ─── AC-5.2: Happy path — 3 elements all imported, content round-trips ────────
//
// Tests that each import element is persisted and retrievable via GET/{id} with
// content deep-equal to what was sent. Covers the "accept → each appears in
// account with identical content" assertion in AC-5.2.

describe("T6 / AC-5.2 — happy path: 3 elements all imported, content round-trips", () => {
  it("POST /estimates/import with 3 valid elements → all status:imported, content deep-equals sent payload", async () => {
    const app = buildApp();
    const jwt = await tokenA();

    const elements = [
      { localId: "local-1", name: "Import Estimate 1", author: "Alice", content: makeContent("imp-e1") },
      { localId: "local-2", name: "Import Estimate 2", author: "Bob", content: makeContent("imp-e2") },
      { localId: "local-3", name: "Import Estimate 3", author: "Charlie", content: makeContent("imp-e3") },
    ];

    const importRes = await app.request("/estimates/import", {
      method: "POST",
      headers: bearerHeader(jwt),
      body: JSON.stringify({ estimates: elements }),
    });

    expect(importRes.status).toBe(200);
    const body = (await importRes.json()) as {
      results: Array<{ localId: string; status: string; id?: string; error?: string }>;
    };

    expect(body.results).toHaveLength(3);

    // Every element must be imported.
    for (const result of body.results) {
      expect(result.status).toBe("imported");
      expect(typeof result.id).toBe("string");
      expect(result.id).toBeTruthy();
    }

    // localIds must correspond to the input order.
    expect(body.results[0]?.localId).toBe("local-1");
    expect(body.results[1]?.localId).toBe("local-2");
    expect(body.results[2]?.localId).toBe("local-3");

    // AC-5.2: each imported estimate is retrievable via GET/{id} and content
    // deep-equals what was sent. Semantic deep-equal = JSONB preserves values.
    for (let i = 0; i < elements.length; i++) {
      const result = body.results[i]!;
      // Narrow: after asserting status === "imported", id is present.
      if (result.status !== "imported" || !result.id) continue;
      const importedId: string = result.id;

      const getRes = await app.request(`/estimates/${importedId}`, {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      expect(getRes.status).toBe(200);
      const fetched = (await getRes.json()) as {
        id: string;
        name: string;
        author: string;
        content: unknown;
      };

      expect(fetched.id).toBe(importedId);
      expect(fetched.name).toBe(elements[i]!.name);
      expect(fetched.author).toBe(elements[i]!.author);
      // AC-5.2 — semantic round-trip through JSONB preserves all values.
      expect(fetched.content).toEqual(elements[i]!.content);
    }
  });
});

// ─── AC-5.4: Partial failure ──────────────────────────────────────────────────
//
// ISOLATION INVARIANT (KEY for AC-5.4, plan.md security target):
//
//   If the endpoint used a single spanning transaction (or aborted-on-first-error),
//   a DB error on the bad element would roll back the good ones too — the good
//   elements would NOT be retrievable via GET/{id}.
//
//   This test FAILS if per-element isolation is dropped.
//
// The test asserts:
//   1. The bad (over-size) element → status:"failed" with a non-empty error message.
//   2. The good elements → status:"imported" and retrievable via GET/{id} (AC-5.2).
//   3. The bad element did NOT persist — GET /estimates count = 2, not 3.
//   4. The overall endpoint response is 200 (not 413 or 500) — well-formed envelope.

describe("T6 / AC-5.4 — partial failure: over-size element fails; valid elements are still imported", () => {
  it("batch with one over-size element → that element is failed; others are imported and retrievable", async () => {
    const app = buildApp();
    const jwt = await tokenA();

    const goodContent1 = makeContent("import-good-1");
    const goodContent2 = makeContent("import-good-2");
    const badContent = makeOverSizeContentForImport();

    // Verify the over-size fixture is actually over-limit (guard against silently
    // shrinking the fixture and making this test vacuous).
    const badBytes = new TextEncoder().encode(JSON.stringify(badContent)).length;
    expect(badBytes).toBeGreaterThan(1048576);

    const batch = [
      { localId: "import-good-a", name: "Good Import A", author: "Alice", content: goodContent1 },
      { localId: "import-bad-oversized", name: "Bad Import (over-size)", author: "Alice", content: badContent },
      { localId: "import-good-b", name: "Good Import B", author: "Alice", content: goodContent2 },
    ];

    const importRes = await app.request("/estimates/import", {
      method: "POST",
      headers: bearerHeader(jwt),
      body: JSON.stringify({ estimates: batch }),
    });

    // Endpoint returns 200 for a well-formed envelope regardless of per-element outcome.
    expect(importRes.status).toBe(200);

    const body = (await importRes.json()) as {
      results: Array<{ localId: string; status: string; id?: string; error?: string }>;
    };
    expect(body.results).toHaveLength(3);

    const [resultA, resultBad, resultB] = body.results as Array<{
      localId: string;
      status: string;
      id?: string;
      error?: string;
    }>;

    // Good elements must be imported.
    expect(resultA!.localId).toBe("import-good-a");
    expect(resultA!.status).toBe("imported");
    expect(resultA!.id).toBeTruthy();

    // Bad element must be failed with an error.
    expect(resultBad!.localId).toBe("import-bad-oversized");
    expect(resultBad!.status).toBe("failed");
    expect(typeof resultBad!.error).toBe("string");
    expect(resultBad!.error!.length).toBeGreaterThan(0);
    expect(resultBad!.id).toBeUndefined(); // no id on failed element

    expect(resultB!.localId).toBe("import-good-b");
    expect(resultB!.status).toBe("imported");
    expect(resultB!.id).toBeTruthy();

    // Narrow to string (asserted truthy above).
    const idA = resultA!.id as string;
    const idB = resultB!.id as string;

    // ISOLATION PROOF: good elements are retrievable via GET/{id}.
    // If the endpoint had used a single transaction, both would return 404 here.
    const getResA = await app.request(`/estimates/${idA}`, {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    expect(getResA.status).toBe(200);
    const fetchedA = (await getResA.json()) as { content: unknown };
    expect(fetchedA.content).toEqual(goodContent1); // AC-5.2 round-trip

    const getResB = await app.request(`/estimates/${idB}`, {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    expect(getResB.status).toBe(200);
    const fetchedB = (await getResB.json()) as { content: unknown };
    expect(fetchedB.content).toEqual(goodContent2); // AC-5.2 round-trip

    // ISOLATION PROOF: the bad element did NOT persist.
    // List must contain exactly the 2 good imports — not 3, not 1.
    const listRes = await app.request("/estimates", {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as Array<{ id: string; name: string }>;

    expect(list).toHaveLength(2);
    const ids = list.map((item) => item.id);
    expect(ids).toContain(idA);
    expect(ids).toContain(idB);
    // The bad element must not have snuck into the DB.
    expect(ids).not.toContain(resultBad!.id ?? "__none__");
  });
});

// ─── Ownership: imported rows belong to the caller's userId only ──────────────
//
// OWNERSHIP INVARIANT:
//   All imported rows must be created under the JWT sub (USER_A_ID), never under
//   any body-supplied value. User B's GET must not see them.
//
//   If userId were taken from the body, a smuggled `userId` field could write under
//   B's account. EstimateUpsert strips unknown fields (zod default — no .passthrough()),
//   so the import schema carries no `userId`. This test catches both cases:
//     1. Ownership via GET/{id} with user B's token → 404.
//     2. Body smuggling: element with `userId: USER_B_ID` → row created under USER_A_ID.

describe("T6 — ownership: imported rows belong to the caller's userId", () => {
  it("imported rows are retrievable by user A; user B's list does not include them (AC-4.1)", async () => {
    const app = buildApp();
    const jwtA = await tokenA();
    const jwtB = await tokenB();

    const importRes = await app.request("/estimates/import", {
      method: "POST",
      headers: bearerHeader(jwtA),
      body: JSON.stringify({
        estimates: [
          { localId: "own-test-1", name: "Ownership Test Estimate", author: "Alice", content: makeContent("own") },
        ],
      }),
    });
    expect(importRes.status).toBe(200);
    const body = (await importRes.json()) as {
      results: Array<{ localId: string; status: string; id?: string }>;
    };
    const [result] = body.results;
    expect(result!.status).toBe("imported");
    const importedId = result!.id as string;

    // User A can fetch the imported estimate.
    const getResA = await app.request(`/estimates/${importedId}`, {
      headers: { Authorization: `Bearer ${jwtA}` },
    });
    expect(getResA.status).toBe(200);

    // User B cannot see user A's imported estimate (AC-4.1).
    // Without userId scoping in createEstimate, the row might be accessible to anyone.
    const getResB = await app.request(`/estimates/${importedId}`, {
      headers: { Authorization: `Bearer ${jwtB}` },
    });
    expect(getResB.status).toBe(404); // falsifiable: without scoping → 200

    // User B's list must not contain user A's imported estimate.
    const listResB = await app.request("/estimates", {
      headers: { Authorization: `Bearer ${jwtB}` },
    });
    expect(listResB.status).toBe(200);
    const listB = (await listResB.json()) as Array<{ id: string }>;
    expect(listB.every((item) => item.id !== importedId)).toBe(true);
  });

  it("body field 'userId' is stripped — caller cannot override ownership via body (OWASP A01)", async () => {
    const app = buildApp();
    const jwtA = await tokenA();
    const jwtB = await tokenB();

    // Attempt: user A sends an element with `userId` = USER_B_ID in the body.
    // EstimateUpsert.extend({localId}) strips unknown fields — `userId` in body
    // must be silently dropped and the row created under USER_A_ID (JWT sub).
    const importRes = await app.request("/estimates/import", {
      method: "POST",
      headers: bearerHeader(jwtA),
      body: JSON.stringify({
        estimates: [
          {
            localId: "smuggle-userid",
            name: "Body userId smuggle attempt",
            author: "Alice",
            content: makeContent("smuggle"),
            // Extra field — must be stripped by EstimateUpsert schema
            userId: USER_B_ID,
          },
        ],
      }),
    });
    expect(importRes.status).toBe(200);
    const body = (await importRes.json()) as {
      results: Array<{ localId: string; status: string; id?: string }>;
    };
    const [result] = body.results;
    expect(result!.status).toBe("imported");
    const importedId = result!.id as string;

    // The row must be under USER_A_ID — user A can read it.
    const getResA = await app.request(`/estimates/${importedId}`, {
      headers: { Authorization: `Bearer ${jwtA}` },
    });
    expect(getResA.status).toBe(200);

    // The row must NOT be under USER_B_ID.
    // If the body userId were used, user B would be able to read it → 200.
    // Without smuggling prevention → 200 here, failing the test. (OWASP A01 guard)
    const getResB = await app.request(`/estimates/${importedId}`, {
      headers: { Authorization: `Bearer ${jwtB}` },
    });
    expect(getResB.status).toBe(404);
  });
});

// ─── AC-4.2: Unauthenticated import → 401; nothing written ───────────────────
//
// jwtMiddleware is applied to all routes on the router via `use("*")`.
// These tests verify the middleware guards /estimates/import too.

describe("T6 / AC-4.2 — unauthenticated import requests are rejected", () => {
  it("POST /estimates/import without Bearer → 401 Problem JSON", async () => {
    const app = buildApp();

    const res = await app.request("/estimates/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        estimates: [
          { localId: "no-auth", name: "No auth estimate", author: "", content: makeContent() },
        ],
      }),
    });

    expect(res.status).toBe(401);
    const body = (await res.json()) as { type: string; title: string; status: number };
    expect(body.status).toBe(401);
    expect(body.type).toBe("https://httpstatuses.com/401");
    expect(body.title).toBe("Unauthorized");
  });

  it("POST /estimates/import with invalid Bearer → 401; nothing persisted in DB", async () => {
    const app = buildApp();
    const jwtA = await tokenA();

    // Unauthenticated POST — must fail.
    const res = await app.request("/estimates/import", {
      method: "POST",
      headers: {
        Authorization: "Bearer not-a-valid-jwt",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        estimates: [
          { localId: "bad-auth", name: "Bad auth estimate", author: "", content: makeContent() },
        ],
      }),
    });
    expect(res.status).toBe(401);

    // Verify nothing was persisted — user A's list is still empty.
    const listRes = await app.request("/estimates", {
      headers: { Authorization: `Bearer ${jwtA}` },
    });
    expect(listRes.status).toBe(200);
    const list = await listRes.json();
    expect(list).toEqual([]);
  });
});

// ─── Malformed envelope → 400 Problem JSON ────────────────────────────────────
//
// A malformed envelope (missing/wrong `estimates` field) must return 400.
// Per-element outcomes live in `results` only when the envelope is valid (plan.md).
// The 400 is returned by @hono/zod-openapi validation before the handler runs.

describe("T6 — malformed envelope → 400 Problem JSON", () => {
  it("missing 'estimates' field → 400", async () => {
    const app = buildApp();
    const jwt = await tokenA();

    const res = await app.request("/estimates/import", {
      method: "POST",
      headers: bearerHeader(jwt),
      body: JSON.stringify({ wrong_field: [] }),
    });

    expect(res.status).toBe(400);
  });

  it("'estimates' is not an array (string) → 400", async () => {
    const app = buildApp();
    const jwt = await tokenA();

    const res = await app.request("/estimates/import", {
      method: "POST",
      headers: bearerHeader(jwt),
      body: JSON.stringify({ estimates: "not-an-array" }),
    });

    expect(res.status).toBe(400);
  });

  it("empty 'estimates' array → 400 (schema requires min 1 element)", async () => {
    const app = buildApp();
    const jwt = await tokenA();

    const res = await app.request("/estimates/import", {
      method: "POST",
      headers: bearerHeader(jwt),
      body: JSON.stringify({ estimates: [] }),
    });

    expect(res.status).toBe(400);
  });

  it("element missing 'localId' → 400 (required field by schema)", async () => {
    const app = buildApp();
    const jwt = await tokenA();

    const res = await app.request("/estimates/import", {
      method: "POST",
      headers: bearerHeader(jwt),
      body: JSON.stringify({
        estimates: [
          { name: "No localId", author: "", content: makeContent() },
        ],
      }),
    });

    expect(res.status).toBe(400);
  });

  it("element missing 'name' → 400 (EstimateUpsert: z.string().min(1))", async () => {
    const app = buildApp();
    const jwt = await tokenA();

    const res = await app.request("/estimates/import", {
      method: "POST",
      headers: bearerHeader(jwt),
      body: JSON.stringify({
        estimates: [
          { localId: "no-name", author: "", content: makeContent() },
        ],
      }),
    });

    expect(res.status).toBe(400);
  });

  it("batch with 201 elements (exceeds cap of 200) → 400 (schema .max(200) enforced)", async () => {
    // QE-added test: verifies the array-length cap is actually enforced by zod
    // validation. Without this, the cap could be silently removed from the schema
    // and callers could send unbounded batches (DoS risk).
    const app = buildApp();
    const jwt = await tokenA();

    // Build 201 elements — one over the allowed cap of 200.
    const oversizedBatch = Array.from({ length: 201 }, (_, i) => ({
      localId: `cap-test-${i}`,
      name: `Estimate ${i}`,
      author: "Alice",
      content: makeContent(`cap-${i}`),
    }));

    const res = await app.request("/estimates/import", {
      method: "POST",
      headers: bearerHeader(jwt),
      body: JSON.stringify({ estimates: oversizedBatch }),
    });

    // The schema .max(200) must reject the batch before the handler runs.
    // Without the cap, this returns 200 — the test would FAIL.
    expect(res.status).toBe(400);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// OWASP A04 fix — import body-limit guard composition (regression tests)
// ═══════════════════════════════════════════════════════════════════════════════
//
// These three tests cover the A04 MEDIUM finding: the router-wide 2 MiB
// bodyLimit was incorrectly capping POST /estimates/import, causing legitimate
// multi-element batches (total > 2 MiB, each element < 1 MiB) to be rejected
// with 413 BEFORE per-element handling could run.
//
// The fix: /estimates/import lives on importEstimatesRouter which has its own
// larger bodyLimit (min(MAX_ESTIMATE_BYTES × 200 + 64 KiB, 32 MiB) = 32 MiB).
// The 2 MiB cap on estimatesRouter no longer applies to the import path.
//
// Test (a) — THE REGRESSION: batch total > 2 MiB, each element < 1 MiB → 200.
//   Before the fix this would return 413 from the router-wide bodyLimit before
//   any handler logic ran. Now it returns 200 with per-element results.
//
// Test (b) — Over-import-limit body → 413 (outer envelope guard still works).
//
// Test (c) — Element over 1 MiB inside otherwise-fine batch → that element
//   fails; others succeed (AC-5.4 still holds with the new larger limit).

// Helper: builds content that serialises to ~700 KiB (deterministically under the
// 1 MiB per-element cap but large enough that 3 copies exceed 2 MiB total).
// Construction: 1300 releases × 500-char name → each release ≈ 550 bytes,
// 1300 × 550 ≈ 715 KiB. We verify the exact range in the guard test below.
const makeMediumContent = (tag: string) => {
  const longName = "M".repeat(500);
  const releases = Array.from({ length: 1300 }, (_, i) => ({
    id: `rel-${tag}-${i}`,
    name: longName,
    fte: 2,
  }));
  return {
    params: {
      parallelism: 0.7,
      sprintDays: 10,
      workingDaysMonth: 20,
      qaDeployDays: 0,
      qaTestDays: 0,
      pmDays: 0,
      aiCostCoef: 10,
      aiGain: 0.3,
    },
    releases,
    acts: [],
  };
};

describe("OWASP A04 fix — import body-limit fixture guards (test determinism)", () => {
  it("makeMediumContent() is < 1 MiB per element (under per-element cap)", () => {
    const bytes = new TextEncoder().encode(JSON.stringify(makeMediumContent("guard"))).length;
    expect(bytes).toBeLessThan(1048576); // under 1 MiB per-element cap
  });

  it("3 × makeMediumContent() total exceeds 2 MiB (triggers the old router-wide cap)", () => {
    const single = new TextEncoder().encode(
      JSON.stringify(makeMediumContent("guard-sum")),
    ).length;
    // 3 copies must exceed 2 MiB to make the regression meaningful.
    expect(single * 3).toBeGreaterThan(2 * 1024 * 1024);
  });
});

describe("OWASP A04 fix (a) — multi-element batch > 2 MiB total, each element < 1 MiB → 200 with per-element results", () => {
  it("[REGRESSION] batch whose total body > 2 MiB but each element < 1 MiB → 200 imported (was 413 before fix)", async () => {
    // This is the exact scenario described in the MEDIUM finding:
    // a legitimate batch of individually-valid estimates whose combined body
    // exceeds the old router-wide 2 MiB limit. Before the fix, the bodyLimit
    // middleware on estimatesRouter rejected the entire request with 413 — the
    // caller never received a `results` array. After the fix, importEstimatesRouter's
    // larger limit allows the batch through and all elements are processed.
    const app = buildApp();
    const jwt = await tokenA();

    const batch = [
      { localId: "medium-1", name: "Medium Import 1", author: "Alice", content: makeMediumContent("m1") },
      { localId: "medium-2", name: "Medium Import 2", author: "Alice", content: makeMediumContent("m2") },
      { localId: "medium-3", name: "Medium Import 3", author: "Alice", content: makeMediumContent("m3") },
    ];

    // Verify total body size crosses the old 2 MiB threshold (non-vacuous guard).
    const totalBytes = new TextEncoder().encode(JSON.stringify({ estimates: batch })).length;
    expect(totalBytes).toBeGreaterThan(2 * 1024 * 1024); // would have 413'd before fix

    const importRes = await app.request("/estimates/import", {
      method: "POST",
      headers: bearerHeader(jwt),
      body: JSON.stringify({ estimates: batch }),
    });

    // Must return 200 — not 413. Before the fix this would be 413.
    expect(importRes.status).toBe(200);

    const body = (await importRes.json()) as {
      results: Array<{ localId: string; status: string; id?: string; error?: string }>;
    };

    expect(body.results).toHaveLength(3);

    // All elements must be imported (no per-element size failure — each is < 1 MiB).
    for (const result of body.results) {
      expect(result.status).toBe("imported");
      expect(typeof result.id).toBe("string");
      expect(result.id).toBeTruthy();
    }

    expect(body.results[0]?.localId).toBe("medium-1");
    expect(body.results[1]?.localId).toBe("medium-2");
    expect(body.results[2]?.localId).toBe("medium-3");
  });
});

describe("OWASP A04 fix (b) — import body over IMPORT_BODY_SIZE_LIMIT → 413", () => {
  it("POST /estimates/import with raw body > import limit → 413 (outer envelope guard)", async () => {
    // Build a raw body that exceeds the 32 MiB import limit.
    // We do NOT need a syntactically valid estimates payload — bodyLimit rejects
    // before Zod parsing or handler logic runs.
    const app = buildApp();
    const jwt = await tokenA();

    // 33 MiB of raw body (slightly over the 32 MiB ceiling).
    const rawBody = `{"estimates":"${"X".repeat(33 * 1024 * 1024)}"}`;

    const res = await app.request("/estimates/import", {
      method: "POST",
      headers: bearerHeader(jwt),
      body: rawBody,
    });

    expect(res.status).toBe(413);
    const body = (await res.json()) as { type: string; title: string; status: number };
    expect(body.type).toBe("https://httpstatuses.com/413");
    expect(body.title).toBe("Payload Too Large");
    expect(body.status).toBe(413);
  });
});

describe("OWASP A04 fix (c) — element over 1 MiB in otherwise-fine large batch → that element failed; others imported (AC-5.4)", () => {
  it("batch > 2 MiB total with one over-size element → over-size element failed; in-limit elements imported", async () => {
    // Combines the regression scenario (total body > 2 MiB) with AC-5.4 partial
    // failure: the large batch is accepted (over-import-limit body guard no longer
    // applies), and the over-size element is caught by per-element checkContentSize.
    const app = buildApp();
    const jwt = await tokenA();

    const batch = [
      { localId: "mix-good-1", name: "Good Mix 1", author: "Alice", content: makeMediumContent("mix1") },
      { localId: "mix-oversized", name: "Over-size", author: "Alice", content: makeOverSizeContentForImport() },
      { localId: "mix-good-2", name: "Good Mix 2", author: "Alice", content: makeMediumContent("mix2") },
    ];

    // Verify the good elements are each under 1 MiB (per-element guard must not fire).
    const goodBytes = new TextEncoder().encode(JSON.stringify(makeMediumContent("check"))).length;
    expect(goodBytes).toBeLessThan(1048576);

    // Verify the bad element is over 1 MiB (per-element guard must fire).
    const badBytes = new TextEncoder().encode(JSON.stringify(makeOverSizeContentForImport())).length;
    expect(badBytes).toBeGreaterThan(1048576);

    const importRes = await app.request("/estimates/import", {
      method: "POST",
      headers: bearerHeader(jwt),
      body: JSON.stringify({ estimates: batch }),
    });

    // Envelope is accepted (body is within import limit).
    expect(importRes.status).toBe(200);

    const body = (await importRes.json()) as {
      results: Array<{ localId: string; status: string; id?: string; error?: string }>;
    };
    expect(body.results).toHaveLength(3);

    const [r1, rBad, r2] = body.results as Array<{
      localId: string;
      status: string;
      id?: string;
      error?: string;
    }>;

    // Good elements imported.
    expect(r1!.status).toBe("imported");
    expect(r1!.id).toBeTruthy();

    // Over-size element failed with an error message (SizeError — safe to forward).
    expect(rBad!.status).toBe("failed");
    expect(typeof rBad!.error).toBe("string");
    expect(rBad!.error!.length).toBeGreaterThan(0);
    // Error must reference the size (not a generic DB message).
    expect(rBad!.error).toContain("MB");

    expect(r2!.status).toBe("imported");
    expect(r2!.id).toBeTruthy();

    // Verify good elements are retrievable via GET/{id} (AC-5.4 isolation proof).
    const getRes1 = await app.request(`/estimates/${r1!.id}`, {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    expect(getRes1.status).toBe(200);

    const getRes2 = await app.request(`/estimates/${r2!.id}`, {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    expect(getRes2.status).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// BUG FIX: z.coerce.number() — UI stores numeric fields as strings
// ═══════════════════════════════════════════════════════════════════════════════
//
// The EstimAI UI stores numeric activity/parameter inputs as strings
// (e.g. ml:"5", risk:"2", aiGain:"0.15") and coerces them to numbers only at
// compute time.  The prior z.number() schemas rejected any real saved estimate,
// causing POST /estimates, PUT, and POST /estimates/import to return 400.
//
// These tests use the PaperJudge-shaped payload (mixed string and number values
// as they appear in real localStorage exports) to verify the fix is complete.
//
// Test structure:
//   (1) import: string-valued acts/fte → status:"imported"; GET → fields coerced to numbers
//   (2) upsert: POST with string-valued content → 201; GET → fields coerced to numbers
//   (3) regression: all-numeric fixture still works (numbers coerce to themselves)
//   (4) garbage string "abc" in a numeric field → that import element "failed" / upsert 400s

// PaperJudge-shaped content: ml/risk/aiGain as strings, o/p as numbers, fte as number.
// This mirrors the exact shape that caused the bug (confirmed by reproduction).
const makePaperJudgeContent = () => ({
  params: {
    parallelism: "0.7",   // string — UI stores as string
    sprintDays: 10,       // number — some fields may already be coerced
    workingDaysMonth: "20",
    qaDeployDays: "0",
    qaTestDays: 0,
    pmDays: "0",
    aiCostCoef: "10",
    aiGain: "0.15",       // string — the triggering field in the bug report
  },
  releases: [{ id: "rel-pj", name: "PaperJudge Release", fte: 1 }],
  acts: [
    {
      id: "act-pj-1",
      num: "1",
      epic: "Auth",
      act: "Login implementation",
      prof: "Backend Dev",
      o: 3,               // number — mixed with strings below
      ml: "5",            // string — the triggering field (bug report)
      p: 8,               // number
      risk: "2",          // string — the triggering field (bug report)
      aiGain: "0.15",     // string — the triggering field (bug report)
      notes: "PaperJudge project activity",
      release: "rel-pj",
    },
    {
      id: "act-pj-2",
      num: "2",
      epic: "UI",
      act: "Dashboard layout",
      prof: "Frontend Dev",
      o: 1,
      ml: "3",
      p: 6,
      risk: "0",
      aiGain: "0",        // string "0" — edge case: Number("0") === 0, not NaN
      release: "rel-pj",
    },
  ],
});

// Expected shape after coercion: all numeric fields are numbers, not strings.
const paperJudgeCoerced = () => ({
  params: {
    parallelism: 0.7,
    sprintDays: 10,
    workingDaysMonth: 20,
    qaDeployDays: 0,
    qaTestDays: 0,
    pmDays: 0,
    aiCostCoef: 10,
    aiGain: 0.15,
  },
  releases: [{ id: "rel-pj", name: "PaperJudge Release", fte: 1 }],
  acts: [
    {
      id: "act-pj-1",
      num: "1",
      epic: "Auth",
      act: "Login implementation",
      prof: "Backend Dev",
      o: 3,
      ml: 5,
      p: 8,
      risk: 2,
      aiGain: 0.15,
      notes: "PaperJudge project activity",
      release: "rel-pj",
    },
    {
      id: "act-pj-2",
      num: "2",
      epic: "UI",
      act: "Dashboard layout",
      prof: "Frontend Dev",
      o: 1,
      ml: 3,
      p: 6,
      risk: 0,
      aiGain: 0,
      release: "rel-pj",
    },
  ],
});

// (1) import: string-valued acts → status:"imported"; GET → fields coerced to numbers
describe("coerce fix (1) — import with string-valued numeric fields → imported; GET round-trips as numbers", () => {
  it("POST /estimates/import with PaperJudge-shaped content (ml:'5', risk:'2', aiGain:'0.15') → status:imported; GET returns coerced numbers", async () => {
    const app = buildApp();
    const jwt = await tokenA();

    const importRes = await app.request("/estimates/import", {
      method: "POST",
      headers: bearerHeader(jwt),
      body: JSON.stringify({
        estimates: [
          {
            localId: "paperjudge-import-1",
            name: "PaperJudge Import Test",
            author: "QA",
            content: makePaperJudgeContent(),
          },
        ],
      }),
    });

    // Before the fix this would be 400 (z.number() rejected "5", "2", "0.15").
    expect(importRes.status).toBe(200);
    const body = (await importRes.json()) as {
      results: Array<{ localId: string; status: string; id?: string; error?: string }>;
    };
    expect(body.results).toHaveLength(1);
    const [result] = body.results;
    // Must be "imported", not "failed" — this is the primary regression assertion.
    expect(result!.status).toBe("imported");
    expect(typeof result!.id).toBe("string");
    expect(result!.id).toBeTruthy();

    // GET the imported estimate — fields must be coerced to numbers (not strings).
    const getRes = await app.request(`/estimates/${result!.id}`, {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    expect(getRes.status).toBe(200);
    const fetched = (await getRes.json()) as { content: unknown };

    // Deep-equal to the coerced shape: ml:5 not "5", risk:2 not "2", etc.
    expect(fetched.content).toEqual(paperJudgeCoerced());
  });
});

// (2) upsert: POST with string-valued content → 201; GET → fields coerced to numbers
describe("coerce fix (2) — POST /estimates with string-valued numeric fields → 201; GET round-trips as numbers", () => {
  it("POST /estimates with PaperJudge content → 201; GET returns coerced numbers", async () => {
    const app = buildApp();
    const jwt = await tokenA();

    const postRes = await app.request("/estimates", {
      method: "POST",
      headers: bearerHeader(jwt),
      body: JSON.stringify({
        name: "PaperJudge Upsert Test",
        author: "QA",
        content: makePaperJudgeContent(),
      }),
    });

    // Before the fix this would be 400.
    expect(postRes.status).toBe(201);
    const created = (await postRes.json()) as { id: string; content: unknown };
    expect(created.id).toBeTruthy();

    // GET — fields coerced to numbers, not strings.
    const getRes = await app.request(`/estimates/${created.id}`, {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    expect(getRes.status).toBe(200);
    const fetched = (await getRes.json()) as { content: unknown };
    expect(fetched.content).toEqual(paperJudgeCoerced());
  });

  it("PUT /estimates/{id} with string-valued numeric fields → 200; GET returns coerced numbers", async () => {
    const app = buildApp();
    const jwt = await tokenA();

    // First create with numeric content so the row exists.
    const postRes = await app.request("/estimates", {
      method: "POST",
      headers: bearerHeader(jwt),
      body: JSON.stringify({
        name: "PaperJudge PUT Test (original)",
        author: "QA",
        content: makeContent("before-put"),
      }),
    });
    expect(postRes.status).toBe(201);
    const { id } = (await postRes.json()) as { id: string };

    // PUT with string-valued content — before the fix this would be 400.
    const putRes = await app.request(`/estimates/${id}`, {
      method: "PUT",
      headers: bearerHeader(jwt),
      body: JSON.stringify({
        name: "PaperJudge PUT Test (updated)",
        author: "QA",
        content: makePaperJudgeContent(),
      }),
    });
    expect(putRes.status).toBe(200);

    // GET — fields coerced to numbers.
    const getRes = await app.request(`/estimates/${id}`, {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    expect(getRes.status).toBe(200);
    const fetched = (await getRes.json()) as { content: unknown };
    expect(fetched.content).toEqual(paperJudgeCoerced());
  });
});

// (3) regression: all-numeric fixture still works (numbers coerce to themselves)
describe("coerce fix (3) — regression: all-numeric content still accepted (numbers coerce to themselves)", () => {
  it("POST /estimates with fully numeric content (existing fixture shape) → 201; GET round-trips identical", async () => {
    const app = buildApp();
    const jwt = await tokenA();
    const numericContent = makeContent("coerce-regression");

    const postRes = await app.request("/estimates", {
      method: "POST",
      headers: bearerHeader(jwt),
      body: JSON.stringify({
        name: "Numeric Regression Estimate",
        author: "QA",
        content: numericContent,
      }),
    });
    expect(postRes.status).toBe(201);
    const { id } = (await postRes.json()) as { id: string };

    const getRes = await app.request(`/estimates/${id}`, {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    expect(getRes.status).toBe(200);
    const fetched = (await getRes.json()) as { content: unknown };
    // Numeric content must deep-equal the input — coercion does not corrupt numbers.
    expect(fetched.content).toEqual(numericContent);
  });
});

// (4) garbage string "abc" in a numeric field → envelope validation rejects (400)
//
// Both the single-estimate and import endpoints validate the entire request body
// at the envelope level via @hono/zod-openapi before the handler runs. A genuinely
// non-numeric string (e.g. "abc") coerces to NaN, and z.coerce.number() rejects NaN
// → the envelope fails zod validation → 400. This is stricter than per-element
// isolation (only size/DB errors produce per-element "failed" results).
describe("coerce fix (4) — garbage string in a numeric field is rejected at envelope level", () => {
  it("POST /estimates/import with ml:'abc' in one element → 400 (envelope zod validation rejects NaN)", async () => {
    const app = buildApp();
    const jwt = await tokenA();

    const garbageContent = {
      params: {
        parallelism: 0.7,
        sprintDays: 10,
        workingDaysMonth: 20,
        qaDeployDays: 0,
        qaTestDays: 0,
        pmDays: 0,
        aiCostCoef: 10,
        aiGain: 0.3,
      },
      releases: [{ id: "rel-garbage", name: "Garbage Release", fte: 1 }],
      acts: [
        {
          id: "act-garbage",
          ml: "abc", // genuinely non-numeric → NaN → zod rejects at envelope level
          release: "rel-garbage",
        },
      ],
    };

    // @hono/zod-openapi validates the full request body before the handler runs.
    // z.coerce.number() applied to "abc" → NaN → zod rejects → 400 on the envelope.
    // This is correct: garbage values must never reach the DB.
    const importRes = await app.request("/estimates/import", {
      method: "POST",
      headers: bearerHeader(jwt),
      body: JSON.stringify({
        estimates: [
          {
            localId: "garbage-ml",
            name: "Garbage ML estimate",
            author: "QA",
            content: garbageContent,
          },
        ],
      }),
    });

    // Envelope-level 400: the entire batch is rejected (NaN is not valid input).
    expect(importRes.status).toBe(400);
  });

  it("POST /estimates with aiGain:'not-a-number' → 400 (envelope validation rejects NaN)", async () => {
    const app = buildApp();
    const jwt = await tokenA();

    const res = await app.request("/estimates", {
      method: "POST",
      headers: bearerHeader(jwt),
      body: JSON.stringify({
        name: "Garbage aiGain estimate",
        author: "QA",
        content: {
          params: {
            parallelism: 0.7,
            sprintDays: 10,
            workingDaysMonth: 20,
            qaDeployDays: 0,
            qaTestDays: 0,
            pmDays: 0,
            aiCostCoef: 10,
            aiGain: "not-a-number", // NaN → rejected
          },
          releases: [{ id: "rel-g", name: "R", fte: 1 }],
          acts: [],
        },
      }),
    });

    // Envelope-level validation rejects NaN — must return 400.
    expect(res.status).toBe(400);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// T6 — Access resolution + denial taxonomy (specs/013-estimate-sharing)
// ═══════════════════════════════════════════════════════════════════════════
//
// Collaborator grants are seeded DIRECTLY via testDb.estimateCollaborator
// (T8/T9's collaborator-management routes don't exist yet) — this is
// deliberately a T6-scoped test of the read/list/delete access predicates,
// not of the (not-yet-built) grant-creation flow.
//
// USER_C has NO relationship (no ownership, no grant) to anything — the
// "stranger" fixture for the AC-1.6 404 tests.
//
// No live `auth` server runs in this test environment, so every
// resolveIdentities() call degrades to {status:"unknown", name:null}
// (ADR-0039, fail-soft) — asserted explicitly below as the CORRECT
// behaviour, not a test gap.

describe("T6 / AC-1.6 — denial taxonomy: a stranger's 404 is byte-identical to a genuinely absent id", () => {
  it("GET /estimates/{id}: same id, stranger-with-no-relationship vs. genuinely-deleted → identical Problem bodies", async () => {
    const app = buildApp();
    const jwtA = await tokenA();
    const jwtC = await tokenC();

    const postRes = await app.request("/estimates", {
      method: "POST",
      headers: bearerHeader(jwtA),
      body: JSON.stringify({
        name: "T6 AC-1.6 GET estimate",
        author: "Alice",
        content: makeContent(),
      }),
    });
    expect(postRes.status).toBe(201);
    const { id } = (await postRes.json()) as { id: string };

    // C has no relationship at all — 404.
    const strangerRes = await app.request(`/estimates/${id}`, {
      headers: { Authorization: `Bearer ${jwtC}` },
    });
    expect(strangerRes.status).toBe(404);
    const strangerBody = await strangerRes.json();

    // Owner deletes — the SAME id is now genuinely absent.
    const delRes = await app.request(`/estimates/${id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${jwtA}` },
    });
    expect(delRes.status).toBe(204);

    const absentRes = await app.request(`/estimates/${id}`, {
      headers: { Authorization: `Bearer ${jwtC}` },
    });
    expect(absentRes.status).toBe(404);
    const absentBody = await absentRes.json();

    // The whole point of AC-1.6/ADR-0005: "not yours" and "does not exist"
    // must be indistinguishable, even to the same caller probing the same
    // id twice.
    expect(strangerBody).toEqual(absentBody);
  });

  it("PUT /estimates/{id}: same id, stranger-with-no-relationship vs. genuinely-deleted → identical Problem bodies", async () => {
    const app = buildApp();
    const jwtA = await tokenA();
    const jwtC = await tokenC();

    const postRes = await app.request("/estimates", {
      method: "POST",
      headers: bearerHeader(jwtA),
      body: JSON.stringify({
        name: "T6 AC-1.6 PUT estimate",
        author: "Alice",
        content: makeContent(),
      }),
    });
    expect(postRes.status).toBe(201);
    const { id } = (await postRes.json()) as { id: string };

    const strangerAttempt = () =>
      app.request(`/estimates/${id}`, {
        method: "PUT",
        headers: bearerHeader(jwtC),
        body: JSON.stringify({
          name: "hijack attempt",
          author: "Eve",
          content: makeContent("hijack"),
        }),
      });

    const strangerRes = await strangerAttempt();
    expect(strangerRes.status).toBe(404);
    const strangerBody = await strangerRes.json();

    const delRes = await app.request(`/estimates/${id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${jwtA}` },
    });
    expect(delRes.status).toBe(204);

    const absentRes = await strangerAttempt();
    expect(absentRes.status).toBe(404);
    const absentBody = await absentRes.json();

    expect(strangerBody).toEqual(absentBody);
  });

  it("DELETE /estimates/{id}: same id, stranger-with-no-relationship vs. genuinely-deleted → identical Problem bodies", async () => {
    const app = buildApp();
    const jwtA = await tokenA();
    const jwtC = await tokenC();

    const postRes = await app.request("/estimates", {
      method: "POST",
      headers: bearerHeader(jwtA),
      body: JSON.stringify({
        name: "T6 AC-1.6 DELETE estimate",
        author: "Alice",
        content: makeContent(),
      }),
    });
    expect(postRes.status).toBe(201);
    const { id } = (await postRes.json()) as { id: string };

    const strangerAttempt = () =>
      app.request(`/estimates/${id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${jwtC}` },
      });

    const strangerRes = await strangerAttempt();
    expect(strangerRes.status).toBe(404);
    const strangerBody = await strangerRes.json();

    // Owner deletes for real this time.
    const delRes = await app.request(`/estimates/${id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${jwtA}` },
    });
    expect(delRes.status).toBe(204);

    const absentRes = await strangerAttempt();
    expect(absentRes.status).toBe(404);
    const absentBody = await absentRes.json();

    expect(strangerBody).toEqual(absentBody);
  });
});

// ─── T6 / AC-3.3 — a collaborator (editor or viewer) cannot delete ───────────

describe("T6 / AC-3.3 — a collaborator (editor or viewer) cannot delete the estimate", () => {
  it("editor collaborator's DELETE /estimates/{id} → 403 owner_only; estimate + grant unchanged", async () => {
    const app = buildApp();
    const jwtA = await tokenA();
    const jwtB = await tokenB();

    const postRes = await app.request("/estimates", {
      method: "POST",
      headers: bearerHeader(jwtA),
      body: JSON.stringify({
        name: "T6 AC-3.3 editor estimate",
        author: "Alice",
        content: makeContent(),
      }),
    });
    expect(postRes.status).toBe(201);
    const { id } = (await postRes.json()) as { id: string };

    await testDb.estimateCollaborator.create({
      data: {
        estimateId: id,
        userId: USER_B_ID,
        email: USER_B_EMAIL,
        accessLevel: "editor",
        grantedByUserId: USER_A_ID,
      },
    });

    const delRes = await app.request(`/estimates/${id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${jwtB}` },
    });
    expect(delRes.status).toBe(403);
    const body = (await delRes.json()) as { code: string; status: number };
    expect(body.code).toBe("owner_only");
    expect(body.status).toBe(403);

    // The estimate and the grant are both unchanged — B's attempt did nothing.
    const getRes = await app.request(`/estimates/${id}`, {
      headers: { Authorization: `Bearer ${jwtA}` },
    });
    expect(getRes.status).toBe(200);
    const grantCount = await testDb.estimateCollaborator.count({
      where: { estimateId: id },
    });
    expect(grantCount).toBe(1);
  });

  it("viewer collaborator's DELETE /estimates/{id} → 403 owner_only", async () => {
    const app = buildApp();
    const jwtA = await tokenA();
    const jwtB = await tokenB();

    const postRes = await app.request("/estimates", {
      method: "POST",
      headers: bearerHeader(jwtA),
      body: JSON.stringify({
        name: "T6 AC-3.3 viewer estimate",
        author: "Alice",
        content: makeContent(),
      }),
    });
    expect(postRes.status).toBe(201);
    const { id } = (await postRes.json()) as { id: string };

    await testDb.estimateCollaborator.create({
      data: {
        estimateId: id,
        userId: USER_B_ID,
        email: USER_B_EMAIL,
        accessLevel: "viewer",
        grantedByUserId: USER_A_ID,
      },
    });

    const delRes = await app.request(`/estimates/${id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${jwtB}` },
    });
    expect(delRes.status).toBe(403);
    const body = (await delRes.json()) as { code: string };
    expect(body.code).toBe("owner_only");
  });
});

// ─── T6 / AC-2.1/2.2/2.3 — GET /estimates: owned ∪ shared, access + owner ────

describe("T6 / AC-2.1/2.2/2.3 — GET /estimates includes owned UNION shared, with access/owner populated", () => {
  it("a user with ONLY grants (no owned estimates) gets a non-empty list; owner is null on owned rows, populated on shared rows", async () => {
    const app = buildApp();
    const jwtA = await tokenA();
    const jwtB = await tokenB();

    const postRes = await app.request("/estimates", {
      method: "POST",
      headers: bearerHeader(jwtA),
      body: JSON.stringify({
        name: "T6 AC-2.1 shared list estimate",
        author: "Alice",
        content: makeContent(),
      }),
    });
    expect(postRes.status).toBe(201);
    const { id } = (await postRes.json()) as { id: string };

    await testDb.estimateCollaborator.create({
      data: {
        estimateId: id,
        userId: USER_B_ID,
        email: USER_B_EMAIL,
        accessLevel: "viewer",
        grantedByUserId: USER_A_ID,
      },
    });

    // Owner's list: their own row is access:"owner", owner:null.
    const listA = await app.request("/estimates", {
      headers: { Authorization: `Bearer ${jwtA}` },
    });
    expect(listA.status).toBe(200);
    const rowsA = (await listA.json()) as Array<{
      id: string;
      access: string;
      owner: unknown;
    }>;
    const ownRow = rowsA.find((r) => r.id === id);
    expect(ownRow).toBeDefined();
    expect(ownRow?.access).toBe("owner");
    expect(ownRow?.owner).toBeNull();

    // B has ZERO owned estimates — the list must still be NON-EMPTY (AC-2.3),
    // containing the shared row with access:"viewer" and a populated
    // (never-null) owner identity.
    const listB = await app.request("/estimates", {
      headers: { Authorization: `Bearer ${jwtB}` },
    });
    expect(listB.status).toBe(200);
    const rowsB = (await listB.json()) as Array<{
      id: string;
      access: string;
      owner: { status: string; name: string | null } | null;
    }>;
    expect(rowsB.length).toBeGreaterThan(0);
    const sharedRow = rowsB.find((r) => r.id === id);
    expect(sharedRow).toBeDefined();
    expect(sharedRow?.access).toBe("viewer");
    expect(sharedRow?.owner).not.toBeNull();
    // No live `auth` server in this test environment — resolveIdentities
    // fails SOFT (ADR-0039). "unknown" is the correct degraded value here,
    // proving GET /estimates never breaks when `auth` is unreachable.
    expect(sharedRow?.owner?.status).toBe("unknown");
  });

  it("GET /estimates/{id} as the editor collaborator: access:'editor', owner populated, no collaboratorCount", async () => {
    const app = buildApp();
    const jwtA = await tokenA();
    const jwtB = await tokenB();

    const postRes = await app.request("/estimates", {
      method: "POST",
      headers: bearerHeader(jwtA),
      body: JSON.stringify({
        name: "T6 AC-2.1 editor GET estimate",
        author: "Alice",
        content: makeContent(),
      }),
    });
    expect(postRes.status).toBe(201);
    const { id } = (await postRes.json()) as { id: string };

    await testDb.estimateCollaborator.create({
      data: {
        estimateId: id,
        userId: USER_B_ID,
        email: USER_B_EMAIL,
        accessLevel: "editor",
        grantedByUserId: USER_A_ID,
      },
    });

    const getRes = await app.request(`/estimates/${id}`, {
      headers: { Authorization: `Bearer ${jwtB}` },
    });
    expect(getRes.status).toBe(200);
    const body = (await getRes.json()) as {
      access: string;
      owner: { status: string } | null;
      collaboratorCount?: number;
    };
    expect(body.access).toBe("editor");
    expect(body.owner).not.toBeNull();
    expect(body.owner?.status).toBe("unknown");
    // A collaborator is never told how many other collaborators exist.
    expect(body.collaboratorCount).toBeUndefined();
  });

  it("GET /estimates/{id} as the owner: access:'owner', owner:null, collaboratorCount reflects the grant count", async () => {
    const app = buildApp();
    const jwtA = await tokenA();

    const postRes = await app.request("/estimates", {
      method: "POST",
      headers: bearerHeader(jwtA),
      body: JSON.stringify({
        name: "T6 AC-2.1 owner GET estimate",
        author: "Alice",
        content: makeContent(),
      }),
    });
    expect(postRes.status).toBe(201);
    const { id } = (await postRes.json()) as { id: string };

    await testDb.estimateCollaborator.create({
      data: {
        estimateId: id,
        userId: USER_B_ID,
        email: USER_B_EMAIL,
        accessLevel: "viewer",
        grantedByUserId: USER_A_ID,
      },
    });

    const getRes = await app.request(`/estimates/${id}`, {
      headers: { Authorization: `Bearer ${jwtA}` },
    });
    expect(getRes.status).toBe(200);
    const body = (await getRes.json()) as {
      access: string;
      owner: unknown;
      collaboratorCount?: number;
      version: number;
    };
    expect(body.access).toBe("owner");
    expect(body.owner).toBeNull();
    expect(body.collaboratorCount).toBe(1);
    // T4's version column is exposed on every EstimateFull response.
    expect(body.version).toBe(1);
  });
});

// ─── T6 / AC-5.2 (partial) — a removed collaborator is refused exactly like ──
// a stranger. The removal MECHANISM (DELETE …/collaborators/{id}) is T9's
// scope; this test only proves the READ-SIDE consequence already holds once
// a grant row is gone — i.e. resolveAccess() correctly treats "grant deleted"
// identically to "grant never existed".

describe("T6 / AC-5.2 (read-side) — once a grant is gone, the former collaborator is refused exactly like a stranger", () => {
  it("GET /estimates/{id} after the grant row is deleted → 404, identical to a stranger's 404", async () => {
    const app = buildApp();
    const jwtA = await tokenA();
    const jwtB = await tokenB();
    const jwtC = await tokenC();

    const postRes = await app.request("/estimates", {
      method: "POST",
      headers: bearerHeader(jwtA),
      body: JSON.stringify({
        name: "T6 AC-5.2 revoked estimate",
        author: "Alice",
        content: makeContent(),
      }),
    });
    expect(postRes.status).toBe(201);
    const { id } = (await postRes.json()) as { id: string };

    const grant = await testDb.estimateCollaborator.create({
      data: {
        estimateId: id,
        userId: USER_B_ID,
        email: USER_B_EMAIL,
        accessLevel: "viewer",
        grantedByUserId: USER_A_ID,
      },
    });

    // B can read it while the grant exists.
    const beforeRes = await app.request(`/estimates/${id}`, {
      headers: { Authorization: `Bearer ${jwtB}` },
    });
    expect(beforeRes.status).toBe(200);

    // Revoke (T9's route doesn't exist yet — delete the row directly).
    await testDb.estimateCollaborator.delete({ where: { id: grant.id } });

    const afterRes = await app.request(`/estimates/${id}`, {
      headers: { Authorization: `Bearer ${jwtB}` },
    });
    expect(afterRes.status).toBe(404);
    const afterBody = await afterRes.json();

    const strangerRes = await app.request(`/estimates/${id}`, {
      headers: { Authorization: `Bearer ${jwtC}` },
    });
    expect(strangerRes.status).toBe(404);
    const strangerBody = await strangerRes.json();

    expect(afterBody).toEqual(strangerBody);
  });
});

// ─── T6 regression: existing spec-001 estimate tests still pass unchanged ────
// (covered structurally: every describe block above this comment in this
// file is unmodified spec-001/T5 test code, run in the same `bun test`
// invocation as the T6 blocks above — a regression in the widened
// listEstimates/getEstimateById/deleteEstimate predicates would fail one of
// those pre-existing AC-1.1 through AC-4.2 tests.)
