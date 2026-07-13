/**
 * Integration tests for GET /notifications + GET /notifications/unread-count
 * (T5, specs/005-notification-center).
 *
 * Strategy mirrors raise.routes.test.ts (real Postgres, mocked jwtMiddleware
 * against a local JWKS, fresh Prisma client pointed at the real DATABASE_URL).
 *
 * done when (tasks.md T5): integration tests — ordering, empty list, sub-scope
 * isolation, not-owned 404, correct count.
 *
 * DRIFT NOTE: see list.routes.ts file header — there is no id-based GET
 * endpoint in plan.md's §API contracts, so "not-owned → 404" has no route to
 * test against. AC-6.2 (sub-scope isolation) is covered instead by the
 * "user B's list never contains user A's notifications" test below, which is
 * the literal documented contract for GET /notifications.
 */

import { describe, it, expect, beforeAll, afterEach, mock } from "bun:test";
import { Hono } from "hono";
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } from "jose";

// ─── Fixture keypairs & jwtMiddleware mock ────────────────────────────────────

let userAPrivateKey: CryptoKey;
let userBPrivateKey: CryptoKey;
const TEST_KID_A = "operai-auth-rs256-v1";
const TEST_KID_B = "operai-auth-rs256-v2";
const TEST_ISSUER = "http://localhost:3001";
const TEST_AUDIENCE = "operai-suite-test";

const USER_A_ID = "test-user-a-t5";
const USER_B_ID = "test-user-b-t5";
const USER_A_EMAIL = "user-a-t5@example.com";
const USER_B_EMAIL = "user-b-t5@example.com";

let localJWKS: Awaited<ReturnType<typeof createLocalJWKSet>>;
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
          {
            type: "https://httpstatuses.com/401",
            title: "Unauthorized",
            status: 401,
            detail: "A valid Bearer token is required",
            instance: c.req.path,
          },
          { status: 401 },
        );
      }
      const token = authHeader.slice(7);
      try {
        if (!jwksProxy) throw new Error("JWKS proxy not initialised");
        const { payload } = await jose.jwtVerify(token, jwksProxy, {
          issuer: TEST_ISSUER,
          audience: TEST_AUDIENCE,
          algorithms: ["RS256"],
        });
        const userId = payload.sub;
        const email = typeof payload.email === "string" ? payload.email : undefined;
        if (!userId || !email) throw new Error("missing claims");
        c.set("userId", userId);
        c.set("email", email);
        return next();
      } catch {
        return Response.json(
          {
            type: "https://httpstatuses.com/401",
            title: "Unauthorized",
            status: 401,
            detail: "The provided token is invalid or has expired",
            instance: c.req.path,
          },
          { status: 401 },
        );
      }
    },
  );

  return { jwtMiddleware, JwtVariables: {} };
});

import { config as dotenvConfig } from "dotenv";
dotenvConfig({ path: new URL("../../.env", import.meta.url).pathname, override: true });

process.env["ALLOWED_ORIGINS"] = "http://localhost:5173";
process.env["AUTH_JWKS_URL"] = "http://localhost:3001/auth/jwks";
process.env["AUTH_ISSUER"] = TEST_ISSUER;
process.env["AUTH_AUDIENCE"] = TEST_AUDIENCE;
process.env["NODE_ENV"] = "test";

const { PrismaClient } = await import("@/lib/generated/prisma/client");
const { PrismaPg } = await import("@prisma/adapter-pg");

const realDatabaseUrl = process.env["DATABASE_URL"]!;
const freshAdapter = new PrismaPg({ connectionString: realDatabaseUrl });
const freshDb = new PrismaClient({ adapter: freshAdapter });

mock.module("@/lib/db", () => ({ db: freshDb }));

const { listRouter } = await import("./list.routes");

const testDb = freshDb;

// ─── Helpers ──────────────────────────────────────────────────────────────────

const buildApp = () => {
  const app = new Hono();
  app.route("/", listRouter);
  return app;
};

const signToken = async (
  privateKey: CryptoKey,
  kid: string,
  sub: string,
  email: string,
): Promise<string> =>
  new SignJWT({ email })
    .setProtectedHeader({ alg: "RS256", kid })
    .setIssuer(TEST_ISSUER)
    .setAudience(TEST_AUDIENCE)
    .setSubject(sub)
    .setExpirationTime("1h")
    .sign(privateKey);

const tokenA = () => signToken(userAPrivateKey, TEST_KID_A, USER_A_ID, USER_A_EMAIL);
const tokenB = () => signToken(userBPrivateKey, TEST_KID_B, USER_B_ID, USER_B_EMAIL);

const authHeader = (token: string) => ({ Authorization: `Bearer ${token}` });

/** Seed N notifications directly via Prisma (bypasses the raise endpoint — this
 * file tests list/count only), spaced 5ms apart so createdAt ordering is
 * deterministic even on fast hardware (Postgres timestamp has ms precision). */
const seed = async (
  recipientId: string,
  n: number,
  opts?: { unread?: boolean },
): Promise<string[]> => {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const row = await testDb.notification.create({
      data: {
        recipientId,
        title: `Notification ${i}`,
        body: `Body ${i}`,
        severity: "info",
        originApp: "estimai",
        toastWorthy: false,
        readAt: opts?.unread === false ? new Date() : null,
      },
    });
    ids.push(row.id);
    await Bun.sleep(5);
  }
  return ids;
};

beforeAll(async () => {
  const kpA = await generateKeyPair("RS256", { extractable: true });
  userAPrivateKey = kpA.privateKey;
  const pubJwkA = await exportJWK(kpA.publicKey);

  const kpB = await generateKeyPair("RS256", { extractable: true });
  userBPrivateKey = kpB.privateKey;
  const pubJwkB = await exportJWK(kpB.publicKey);

  localJWKS = createLocalJWKSet({
    keys: [
      { ...pubJwkA, use: "sig", alg: "RS256", kid: TEST_KID_A },
      { ...pubJwkB, use: "sig", alg: "RS256", kid: TEST_KID_B },
    ],
  });
  jwksProxy = localJWKS;
});

afterEach(async () => {
  await testDb.notification.deleteMany({
    where: { recipientId: { in: [USER_A_ID, USER_B_ID] } },
  });
});

// ─── AC-2.3: ordering ─────────────────────────────────────────────────────────

describe("GET /notifications — ordering (AC-2.3)", () => {
  it("returns notifications newest-first", async () => {
    const app = buildApp();
    const jwt = await tokenA();

    const ids = await seed(USER_A_ID, 3);

    const res = await app.request("/notifications", { headers: authHeader(jwt) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string }>; nextCursor: string | null };

    expect(body.items).toHaveLength(3);
    // Seeded oldest→newest; response must be newest→oldest.
    expect(body.items.map((i) => i.id)).toEqual([...ids].reverse());
    expect(body.nextCursor).toBeNull();
  });

  it("cursor pagination: a page with more results returns a nextCursor, and paging through it yields all items in order with no duplicates", async () => {
    const app = buildApp();
    const jwt = await tokenA();

    const ids = await seed(USER_A_ID, 5);

    const page1 = await app.request("/notifications?limit=2", { headers: authHeader(jwt) });
    expect(page1.status).toBe(200);
    const body1 = (await page1.json()) as { items: Array<{ id: string }>; nextCursor: string | null };
    expect(body1.items).toHaveLength(2);
    expect(body1.nextCursor).not.toBeNull();

    const page2 = await app.request(`/notifications?limit=2&cursor=${body1.nextCursor}`, {
      headers: authHeader(jwt),
    });
    const body2 = (await page2.json()) as { items: Array<{ id: string }>; nextCursor: string | null };
    expect(body2.items).toHaveLength(2);
    expect(body2.nextCursor).not.toBeNull();

    const page3 = await app.request(`/notifications?limit=2&cursor=${body2.nextCursor}`, {
      headers: authHeader(jwt),
    });
    const body3 = (await page3.json()) as { items: Array<{ id: string }>; nextCursor: string | null };
    expect(body3.items).toHaveLength(1);
    expect(body3.nextCursor).toBeNull();

    const allIds = [...body1.items, ...body2.items, ...body3.items].map((i) => i.id);
    expect(allIds).toEqual([...ids].reverse());
    // no duplicates across pages
    expect(new Set(allIds).size).toBe(allIds.length);
  });
});

// ─── AC-2.4: empty list ───────────────────────────────────────────────────────

describe("GET /notifications — empty list (AC-2.4)", () => {
  it("a caller with no notifications gets { items: [], nextCursor: null } — not an error", async () => {
    const app = buildApp();
    const jwt = await tokenA();

    const res = await app.request("/notifications", { headers: authHeader(jwt) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[]; nextCursor: string | null };
    expect(body.items).toEqual([]);
    expect(body.nextCursor).toBeNull();
  });
});

// ─── AC-6.2: sub-scope isolation ──────────────────────────────────────────────

describe("GET /notifications — sub-scope isolation (AC-6.2)", () => {
  it("user B's list never contains user A's notifications, and vice versa", async () => {
    const app = buildApp();
    const jwtA = await tokenA();
    const jwtB = await tokenB();

    const idsA = await seed(USER_A_ID, 2);
    const idsB = await seed(USER_B_ID, 3);

    const resA = await app.request("/notifications", { headers: authHeader(jwtA) });
    const bodyA = (await resA.json()) as { items: Array<{ id: string }> };
    expect(bodyA.items).toHaveLength(2);
    expect(bodyA.items.map((i) => i.id).sort()).toEqual([...idsA].sort());

    const resB = await app.request("/notifications", { headers: authHeader(jwtB) });
    const bodyB = (await resB.json()) as { items: Array<{ id: string }> };
    expect(bodyB.items).toHaveLength(3);
    expect(bodyB.items.map((i) => i.id).sort()).toEqual([...idsB].sort());

    // Cross-contamination guard: no id from A's set appears in B's response or vice versa.
    const aIdSet = new Set(idsA);
    const bIdSet = new Set(idsB);
    expect(bodyA.items.some((i) => bIdSet.has(i.id))).toBe(false);
    expect(bodyB.items.some((i) => aIdSet.has(i.id))).toBe(false);
  });
});

// ─── 401 ──────────────────────────────────────────────────────────────────────

describe("GET /notifications — unauthenticated → 401", () => {
  it("no Authorization header → 401", async () => {
    const app = buildApp();
    const res = await app.request("/notifications");
    expect(res.status).toBe(401);
  });
});

// ─── GET /notifications/unread-count ─────────────────────────────────────────

describe("GET /notifications/unread-count — correct count", () => {
  it("counts only unread (readAt: null) notifications for the caller", async () => {
    const app = buildApp();
    const jwt = await tokenA();

    await seed(USER_A_ID, 3); // 3 unread
    await seed(USER_A_ID, 2, { unread: false }); // 2 already read

    const res = await app.request("/notifications/unread-count", { headers: authHeader(jwt) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { count: number };
    expect(body.count).toBe(3);
  });

  it("zero unread → count 0 (not an error)", async () => {
    const app = buildApp();
    const jwt = await tokenA();

    const res = await app.request("/notifications/unread-count", { headers: authHeader(jwt) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { count: number };
    expect(body.count).toBe(0);
  });

  it("sub-scoped: user A's unread count is unaffected by user B's unread notifications", async () => {
    const app = buildApp();
    const jwtA = await tokenA();

    await seed(USER_A_ID, 1);
    await seed(USER_B_ID, 5);

    const res = await app.request("/notifications/unread-count", { headers: authHeader(jwtA) });
    const body = (await res.json()) as { count: number };
    expect(body.count).toBe(1);
  });

  it("no Authorization header → 401", async () => {
    const app = buildApp();
    const res = await app.request("/notifications/unread-count");
    expect(res.status).toBe(401);
  });
});
