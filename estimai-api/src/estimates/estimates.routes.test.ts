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

// Local in-memory JWKS used by the mocked jwtMiddleware.
// Type is the ReturnType of createLocalJWKSet from jose.
let localJWKS: Awaited<ReturnType<typeof createLocalJWKSet>>;

// Each user gets its own kid to avoid ERR_JWKS_MULTIPLE_MATCHING_KEYS when
// two public keys share the same kid in the in-memory JWKS.
const TEST_KID_A = "operai-auth-rs256-v1";
const TEST_KID_B = "operai-auth-rs256-v2";
const TEST_ISSUER = "http://localhost:3001";

const USER_A_ID = "test-user-a-t4";
const USER_B_ID = "test-user-b-t4";
const USER_A_EMAIL = "user-a-t4@example.com";
const USER_B_EMAIL = "user-b-t4@example.com";

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
process.env["NODE_ENV"] = "test";

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
const { estimatesRouter } = await import("./estimates.routes");

// Use the same freshDb for test cleanup.
const testDb = freshDb;

// ─── Minimal Hono app for testing ────────────────────────────────────────────

const buildApp = () => {
  const app = new Hono();
  app.route("/", estimatesRouter);
  return app;
};

// ─── JWT helpers ─────────────────────────────────────────────────────────────

const signToken = async (
  privateKey: CryptoKey,
  kid: string,
  sub: string,
  email: string,
): Promise<string> =>
  new SignJWT({ email })
    .setProtectedHeader({ alg: "RS256", kid })
    .setIssuer(TEST_ISSUER)
    .setSubject(sub)
    .setExpirationTime("1h")
    .sign(privateKey);

// Convenience wrappers — each user signs with their own keypair + kid.
const tokenA = () =>
  signToken(userAPrivateKey, TEST_KID_A, USER_A_ID, USER_A_EMAIL);
const tokenB = () =>
  signToken(userBPrivateKey, TEST_KID_B, USER_B_ID, USER_B_EMAIL);

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
  // Generate TWO fixture RS256 keypairs: one for user A, one for user B.
  // Each key gets its own kid to avoid ERR_JWKS_MULTIPLE_MATCHING_KEYS.
  const kpA = await generateKeyPair("RS256", { extractable: true });
  userAPrivateKey = kpA.privateKey;
  const pubJwkA = await exportJWK(kpA.publicKey);

  const kpB = await generateKeyPair("RS256", { extractable: true });
  userBPrivateKey = kpB.privateKey;
  const pubJwkB = await exportJWK(kpB.publicKey);

  // Each key registered with its own kid — jose resolves the correct key per token.
  localJWKS = createLocalJWKSet({
    keys: [
      { ...pubJwkA, use: "sig", alg: "RS256", kid: TEST_KID_A },
      { ...pubJwkB, use: "sig", alg: "RS256", kid: TEST_KID_B },
    ],
  });
  jwksProxy = localJWKS;
});

// Clean up test data after each test to keep runs idempotent.
afterEach(async () => {
  await testDb.estimate.deleteMany({
    where: { userId: { in: [USER_A_ID, USER_B_ID] } },
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
