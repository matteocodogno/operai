/**
 * Integration tests for POST /notifications/mark-all-read (T6, specs/005-notification-center).
 *
 * Strategy mirrors list.routes.test.ts / raise.routes.test.ts.
 *
 * done when (tasks.md T6): integration tests — marks unread→read, idempotent
 * 200 no-op, unread-reset published.
 */

import { describe, it, expect, beforeAll, afterEach, mock } from "bun:test";
import { Hono } from "hono";
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } from "jose";

let userAPrivateKey: CryptoKey;
let userBPrivateKey: CryptoKey;
const TEST_KID_A = "operai-auth-rs256-v1";
const TEST_KID_B = "operai-auth-rs256-v2";
const TEST_ISSUER = "http://localhost:3001";
const TEST_AUDIENCE = "operai-suite-test";

const USER_A_ID = "test-user-a-t6";
const USER_B_ID = "test-user-b-t6";
const USER_A_EMAIL = "user-a-t6@example.com";
const USER_B_EMAIL = "user-b-t6@example.com";

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

const { markReadRouter } = await import("./markRead.routes");
const { eventBus } = await import("./eventBus");

const testDb = freshDb;

const buildApp = () => {
  const app = new Hono();
  app.route("/", markReadRouter);
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

const seedUnread = async (recipientId: string, n: number): Promise<string[]> => {
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
        readAt: null,
      },
    });
    ids.push(row.id);
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

// ─── AC-3.1: marks unread → read ─────────────────────────────────────────────

describe("POST /notifications/mark-all-read — marks unread → read (AC-3.1)", () => {
  it("200: all unread notifications for the caller become read; readAt is set", async () => {
    const app = buildApp();
    const jwt = await tokenA();

    const ids = await seedUnread(USER_A_ID, 4);

    const res = await app.request("/notifications/mark-all-read", {
      method: "POST",
      headers: authHeader(jwt),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { updated: number; count: number };
    expect(body.updated).toBe(4);
    expect(body.count).toBe(0);

    for (const id of ids) {
      const row = await testDb.notification.findUnique({ where: { id } });
      expect(row?.readAt).not.toBeNull();
    }
  });

  it("only marks the CALLER's unread notifications, not another user's (sub-scoped)", async () => {
    const app = buildApp();
    const jwtA = await tokenA();

    const idsA = await seedUnread(USER_A_ID, 2);
    const idsB = await seedUnread(USER_B_ID, 3);

    const res = await app.request("/notifications/mark-all-read", {
      method: "POST",
      headers: authHeader(jwtA),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { updated: number };
    expect(body.updated).toBe(2); // only A's rows

    for (const id of idsA) {
      const row = await testDb.notification.findUnique({ where: { id } });
      expect(row?.readAt).not.toBeNull();
    }
    // B's notifications must remain untouched.
    for (const id of idsB) {
      const row = await testDb.notification.findUnique({ where: { id } });
      expect(row?.readAt).toBeNull();
    }
  });
});

// ─── AC-3.4: idempotent no-op ─────────────────────────────────────────────────

describe("POST /notifications/mark-all-read — idempotent (AC-3.4)", () => {
  it("200 harmless no-op when nothing is unread", async () => {
    const app = buildApp();
    const jwt = await tokenA();

    // No notifications seeded at all.
    const res = await app.request("/notifications/mark-all-read", {
      method: "POST",
      headers: authHeader(jwt),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { updated: number; count: number };
    expect(body.updated).toBe(0);
    expect(body.count).toBe(0);
  });

  it("calling mark-all-read twice in a row: second call is a 200 no-op (updated: 0)", async () => {
    const app = buildApp();
    const jwt = await tokenA();

    await seedUnread(USER_A_ID, 3);

    const first = await app.request("/notifications/mark-all-read", {
      method: "POST",
      headers: authHeader(jwt),
    });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { updated: number };
    expect(firstBody.updated).toBe(3);

    const second = await app.request("/notifications/mark-all-read", {
      method: "POST",
      headers: authHeader(jwt),
    });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { updated: number; count: number };
    expect(secondBody.updated).toBe(0);
    expect(secondBody.count).toBe(0);
  });

  it("previously-read notifications from an earlier call are not re-touched (idempotent, no error)", async () => {
    const app = buildApp();
    const jwt = await tokenA();

    const ids = await seedUnread(USER_A_ID, 2);
    await app.request("/notifications/mark-all-read", { method: "POST", headers: authHeader(jwt) });

    const readAtAfterFirst = await Promise.all(
      ids.map(async (id) => (await testDb.notification.findUnique({ where: { id } }))?.readAt),
    );

    await Bun.sleep(5);
    await app.request("/notifications/mark-all-read", { method: "POST", headers: authHeader(jwt) });

    const readAtAfterSecond = await Promise.all(
      ids.map(async (id) => (await testDb.notification.findUnique({ where: { id } }))?.readAt),
    );

    // readAt timestamps must be unchanged by the second (no-op) call.
    expect(readAtAfterSecond.map((d) => d?.getTime())).toEqual(readAtAfterFirst.map((d) => d?.getTime()));
  });
});

// ─── unread-reset published ───────────────────────────────────────────────────

describe("POST /notifications/mark-all-read — publishes unread-reset (AC-3.1 across tabs)", () => {
  it("publishes an unread-reset event to the caller's EventBus subscribers", async () => {
    const app = buildApp();
    const jwt = await tokenA();

    await seedUnread(USER_A_ID, 2);

    const received: unknown[] = [];
    const unsubscribe = eventBus.subscribe(USER_A_ID, (event) => received.push(event));

    const res = await app.request("/notifications/mark-all-read", {
      method: "POST",
      headers: authHeader(jwt),
    });
    expect(res.status).toBe(200);

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ type: "unread-reset", data: { count: 0 } });

    unsubscribe();
  });

  it("publishes unread-reset to ALL of the caller's open subscriptions (multi-tab fan-out)", async () => {
    const app = buildApp();
    const jwt = await tokenA();

    await seedUnread(USER_A_ID, 1);

    const receivedTab1: unknown[] = [];
    const receivedTab2: unknown[] = [];
    const unsub1 = eventBus.subscribe(USER_A_ID, (event) => receivedTab1.push(event));
    const unsub2 = eventBus.subscribe(USER_A_ID, (event) => receivedTab2.push(event));

    await app.request("/notifications/mark-all-read", { method: "POST", headers: authHeader(jwt) });

    expect(receivedTab1).toHaveLength(1);
    expect(receivedTab2).toHaveLength(1);

    unsub1();
    unsub2();
  });

  it("even a no-op mark-all-read (nothing unread) still publishes unread-reset", async () => {
    const app = buildApp();
    const jwt = await tokenA();

    const received: unknown[] = [];
    const unsubscribe = eventBus.subscribe(USER_A_ID, (event) => received.push(event));

    const res = await app.request("/notifications/mark-all-read", {
      method: "POST",
      headers: authHeader(jwt),
    });
    expect(res.status).toBe(200);
    expect(received).toHaveLength(1);

    unsubscribe();
  });

  it("does NOT publish to a different user's subscribers", async () => {
    const app = buildApp();
    const jwtA = await tokenA();

    await seedUnread(USER_A_ID, 1);

    const receivedB: unknown[] = [];
    const unsubscribeB = eventBus.subscribe(USER_B_ID, (event) => receivedB.push(event));

    await app.request("/notifications/mark-all-read", { method: "POST", headers: authHeader(jwtA) });

    expect(receivedB).toHaveLength(0);

    unsubscribeB();
  });
});

// ─── 401 ──────────────────────────────────────────────────────────────────────

describe("POST /notifications/mark-all-read — unauthenticated → 401", () => {
  it("no Authorization header → 401, nothing marked", async () => {
    const app = buildApp();
    const ids = await seedUnread(USER_A_ID, 1);

    const res = await app.request("/notifications/mark-all-read", { method: "POST" });
    expect(res.status).toBe(401);

    const row = await testDb.notification.findUnique({ where: { id: ids[0]! } });
    expect(row?.readAt).toBeNull();
  });
});
