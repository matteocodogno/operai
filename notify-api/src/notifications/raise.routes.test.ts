/**
 * Integration tests for POST /notifications (T4, specs/005-notification-center).
 *
 * Strategy mirrors estimai-api/src/estimates/estimates.routes.test.ts:
 * - Real Postgres (compose, host:5435, database: notify) — no DB mocking.
 * - Fixture RS256 keypair generated in beforeAll; jwtMiddleware is mocked to
 *   verify against a local in-memory JWKS (same approach as jwt.middleware.test.ts,
 *   avoiding the mock.module("jose") collision documented in estimates.routes.test.ts).
 * - Test data is cleaned up per-test (deleteMany by recipientId).
 *
 * done when (tasks.md T4): integration tests — 201 happy; 400 on empty title/body,
 * bad enum, non-relative link.href; persisted recipientId == sub; event published.
 */

import { describe, it, expect, beforeAll, afterEach, mock } from "bun:test";
import { Hono } from "hono";
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } from "jose";

// ─── Fixture keypair & jwtMiddleware mock ────────────────────────────────────

let userAPrivateKey: CryptoKey;
const TEST_KID_A = "operai-auth-rs256-v1";
const TEST_ISSUER = "http://localhost:3001";
const TEST_AUDIENCE = "operai-suite-test";

const USER_A_ID = "test-user-a-t4";
const USER_A_EMAIL = "user-a-t4@example.com";

let localJWKS: Awaited<ReturnType<typeof createLocalJWKSet>>;
let jwksProxy: typeof localJWKS | null = null;

// Mock the JWT middleware module itself (not jose) — avoids collisions if this
// file ever runs in the same worker as another test file that mocks jose directly.
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
      if (!token) {
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
      try {
        if (!jwksProxy) throw new Error("JWKS proxy not initialised");
        const { payload } = await jose.jwtVerify(token, jwksProxy, {
          issuer: TEST_ISSUER,
          audience: TEST_AUDIENCE,
          algorithms: ["RS256"],
        });
        const userId = payload.sub;
        const email = typeof payload.email === "string" ? payload.email : undefined;
        if (!userId || !email) {
          return Response.json(
            {
              type: "https://httpstatuses.com/401",
              title: "Unauthorized",
              status: 401,
              detail: "Missing required claims",
              instance: c.req.path,
            },
            { status: 401 },
          );
        }
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

// ─── Env + fresh db client (real compose DB, not the test's fake DATABASE_URL) ─

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

const { raiseRouter } = await import("./raise.routes");
const { eventBus } = await import("./eventBus");

const testDb = freshDb;

// ─── Helpers ──────────────────────────────────────────────────────────────────

const buildApp = () => {
  const app = new Hono();
  app.route("/", raiseRouter);
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

const bearerHeader = (token: string) => ({
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
});

beforeAll(async () => {
  const kpA = await generateKeyPair("RS256", { extractable: true });
  userAPrivateKey = kpA.privateKey;
  const pubJwkA = await exportJWK(kpA.publicKey);

  localJWKS = createLocalJWKSet({
    keys: [{ ...pubJwkA, use: "sig", alg: "RS256", kid: TEST_KID_A }],
  });
  jwksProxy = localJWKS;
});

afterEach(async () => {
  await testDb.notification.deleteMany({ where: { recipientId: USER_A_ID } });
});

// ─── AC-4.1..4.4: happy path ──────────────────────────────────────────────────

describe("POST /notifications — happy path (AC-4.1, 4.2, 4.3, 4.4)", () => {
  it("201: full valid payload persists and echoes every field", async () => {
    const app = buildApp();
    const jwt = await tokenA();

    const receivedEvents: unknown[] = [];
    const unsubscribe = eventBus.subscribe(USER_A_ID, (event) => receivedEvents.push(event));

    const res = await app.request("/notifications", {
      method: "POST",
      headers: bearerHeader(jwt),
      body: JSON.stringify({
        title: "Export finished",
        body: "Your XLSX export is ready.",
        severity: "success",
        originApp: "estimai",
        link: { href: "/estimai/estimates/abc", label: "Open" },
        toast: true,
      }),
    });

    expect(res.status).toBe(201);
    const created = (await res.json()) as {
      id: string;
      title: string;
      body: string;
      severity: string;
      originApp: string;
      link?: { href: string; label?: string };
      toastWorthy: boolean;
      readAt: string | null;
      createdAt: string;
    };

    expect(created.title).toBe("Export finished");
    expect(created.body).toBe("Your XLSX export is ready.");
    expect(created.severity).toBe("success");
    expect(created.originApp).toBe("estimai");
    expect(created.link).toEqual({ href: "/estimai/estimates/abc", label: "Open" });
    expect(created.toastWorthy).toBe(true);
    expect(created.readAt).toBeNull();
    expect(typeof created.createdAt).toBe("string");
    expect(created.id).toBeTruthy();

    // Persisted recipientId == sub — verified by re-reading directly from the DB.
    const row = await testDb.notification.findUnique({ where: { id: created.id } });
    expect(row?.recipientId).toBe(USER_A_ID);

    // Event published to the caller's sub (T3 EventBus integration).
    expect(receivedEvents).toHaveLength(1);
    expect(receivedEvents[0]).toEqual({ type: "notification", data: created });

    unsubscribe();
  });

  it("201: severity defaults to 'info' and toast defaults to false when omitted", async () => {
    const app = buildApp();
    const jwt = await tokenA();

    const res = await app.request("/notifications", {
      method: "POST",
      headers: bearerHeader(jwt),
      body: JSON.stringify({
        title: "Minimal notification",
        body: "No severity or toast specified.",
        originApp: "refund",
      }),
    });

    expect(res.status).toBe(201);
    const created = (await res.json()) as { severity: string; toastWorthy: boolean; link?: unknown };
    expect(created.severity).toBe("info");
    expect(created.toastWorthy).toBe(false);
    expect(created.link).toBeUndefined();
  });

  it("201: notification without a link omits the link field entirely", async () => {
    const app = buildApp();
    const jwt = await tokenA();

    const res = await app.request("/notifications", {
      method: "POST",
      headers: bearerHeader(jwt),
      body: JSON.stringify({
        title: "No link here",
        body: "Just text.",
        originApp: "admin",
      }),
    });

    expect(res.status).toBe(201);
    const created = (await res.json()) as Record<string, unknown>;
    expect("link" in created).toBe(false);
  });
});

// ─── AC-4.5: 400 on missing/empty title or body, bad enums, non-relative link ─

describe("POST /notifications — validation failures → 400 (AC-4.5)", () => {
  const validBody = () => ({
    title: "Valid title",
    body: "Valid body",
    originApp: "estimai",
  });

  it("400: empty title", async () => {
    const app = buildApp();
    const jwt = await tokenA();
    const res = await app.request("/notifications", {
      method: "POST",
      headers: bearerHeader(jwt),
      body: JSON.stringify({ ...validBody(), title: "" }),
    });
    expect(res.status).toBe(400);
  });

  it("400: missing title", async () => {
    const app = buildApp();
    const jwt = await tokenA();
    const { title: _title, ...rest } = validBody();
    const res = await app.request("/notifications", {
      method: "POST",
      headers: bearerHeader(jwt),
      body: JSON.stringify(rest),
    });
    expect(res.status).toBe(400);
  });

  it("400: title over 200 characters", async () => {
    const app = buildApp();
    const jwt = await tokenA();
    const res = await app.request("/notifications", {
      method: "POST",
      headers: bearerHeader(jwt),
      body: JSON.stringify({ ...validBody(), title: "T".repeat(201) }),
    });
    expect(res.status).toBe(400);
  });

  it("400: empty body", async () => {
    const app = buildApp();
    const jwt = await tokenA();
    const res = await app.request("/notifications", {
      method: "POST",
      headers: bearerHeader(jwt),
      body: JSON.stringify({ ...validBody(), body: "" }),
    });
    expect(res.status).toBe(400);
  });

  it("400: missing body", async () => {
    const app = buildApp();
    const jwt = await tokenA();
    const { body: _body, ...rest } = validBody();
    const res = await app.request("/notifications", {
      method: "POST",
      headers: bearerHeader(jwt),
      body: JSON.stringify(rest),
    });
    expect(res.status).toBe(400);
  });

  it("400: body over 2000 characters", async () => {
    const app = buildApp();
    const jwt = await tokenA();
    const res = await app.request("/notifications", {
      method: "POST",
      headers: bearerHeader(jwt),
      body: JSON.stringify({ ...validBody(), body: "B".repeat(2001) }),
    });
    expect(res.status).toBe(400);
  });

  it("400: bad severity enum value", async () => {
    const app = buildApp();
    const jwt = await tokenA();
    const res = await app.request("/notifications", {
      method: "POST",
      headers: bearerHeader(jwt),
      body: JSON.stringify({ ...validBody(), severity: "critical" }),
    });
    expect(res.status).toBe(400);
  });

  it("400: missing originApp", async () => {
    const app = buildApp();
    const jwt = await tokenA();
    const { originApp: _originApp, ...rest } = validBody();
    const res = await app.request("/notifications", {
      method: "POST",
      headers: bearerHeader(jwt),
      body: JSON.stringify(rest),
    });
    expect(res.status).toBe(400);
  });

  it("400: bad originApp enum value", async () => {
    const app = buildApp();
    const jwt = await tokenA();
    const res = await app.request("/notifications", {
      method: "POST",
      headers: bearerHeader(jwt),
      body: JSON.stringify({ ...validBody(), originApp: "not-a-real-app" }),
    });
    expect(res.status).toBe(400);
  });

  // ─── link.href open-redirect guard ───────────────────────────────────────

  it("400: link.href is an absolute external URL (open-redirect guard)", async () => {
    const app = buildApp();
    const jwt = await tokenA();
    const res = await app.request("/notifications", {
      method: "POST",
      headers: bearerHeader(jwt),
      body: JSON.stringify({
        ...validBody(),
        link: { href: "https://evil.example.com/phish" },
      }),
    });
    expect(res.status).toBe(400);
  });

  it("400: link.href is protocol-relative (//evil.example.com)", async () => {
    const app = buildApp();
    const jwt = await tokenA();
    const res = await app.request("/notifications", {
      method: "POST",
      headers: bearerHeader(jwt),
      body: JSON.stringify({
        ...validBody(),
        link: { href: "//evil.example.com/phish" },
      }),
    });
    expect(res.status).toBe(400);
  });

  it("400: link.href uses a javascript: scheme", async () => {
    const app = buildApp();
    const jwt = await tokenA();
    const res = await app.request("/notifications", {
      method: "POST",
      headers: bearerHeader(jwt),
      body: JSON.stringify({
        ...validBody(),
        link: { href: "javascript:alert(1)" },
      }),
    });
    expect(res.status).toBe(400);
  });

  it("400: link.href contains a backslash (browser-normalisation trick)", async () => {
    const app = buildApp();
    const jwt = await tokenA();
    const res = await app.request("/notifications", {
      method: "POST",
      headers: bearerHeader(jwt),
      body: JSON.stringify({
        ...validBody(),
        link: { href: "/\\evil.example.com" },
      }),
    });
    expect(res.status).toBe(400);
  });

  it("201: link.href relative in-suite path is accepted", async () => {
    const app = buildApp();
    const jwt = await tokenA();
    const res = await app.request("/notifications", {
      method: "POST",
      headers: bearerHeader(jwt),
      body: JSON.stringify({
        ...validBody(),
        link: { href: "/estimai/estimates/xyz" },
      }),
    });
    expect(res.status).toBe(201);
  });

  it("nothing is persisted after a 400 (no partial write)", async () => {
    const app = buildApp();
    const jwt = await tokenA();

    const before = await testDb.notification.count({ where: { recipientId: USER_A_ID } });

    const res = await app.request("/notifications", {
      method: "POST",
      headers: bearerHeader(jwt),
      body: JSON.stringify({ ...validBody(), title: "" }),
    });
    expect(res.status).toBe(400);

    const after = await testDb.notification.count({ where: { recipientId: USER_A_ID } });
    expect(after).toBe(before);
  });
});

// ─── AC-4.1 (OWASP A01): body-sent recipient is ignored, sub is authoritative ─

describe("POST /notifications — recipient/identity (OWASP A01)", () => {
  it("a body-sent 'recipient' or 'recipientId' field is silently ignored — recipientId is always the JWT sub", async () => {
    const app = buildApp();
    const jwt = await tokenA();

    const res = await app.request("/notifications", {
      method: "POST",
      headers: bearerHeader(jwt),
      body: JSON.stringify({
        title: "Attempted spoof",
        body: "Trying to raise for someone else.",
        originApp: "estimai",
        recipient: "victim-user-id",
        recipientId: "another-victim-id",
      }),
    });

    expect(res.status).toBe(201);
    const created = (await res.json()) as { id: string };

    const row = await testDb.notification.findUnique({ where: { id: created.id } });
    // Regardless of the smuggled body fields, ownership is the caller's sub.
    expect(row?.recipientId).toBe(USER_A_ID);
    expect(row?.recipientId).not.toBe("victim-user-id");
    expect(row?.recipientId).not.toBe("another-victim-id");
  });
});

// ─── 401: unauthenticated ─────────────────────────────────────────────────────

describe("POST /notifications — unauthenticated → 401", () => {
  it("no Authorization header → 401, nothing persisted", async () => {
    const app = buildApp();
    const before = await testDb.notification.count({ where: { recipientId: USER_A_ID } });

    const res = await app.request("/notifications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "x", body: "y", originApp: "estimai" }),
    });
    expect(res.status).toBe(401);

    const after = await testDb.notification.count({ where: { recipientId: USER_A_ID } });
    expect(after).toBe(before);
  });
});

// ─── 413: body-size cap ───────────────────────────────────────────────────────

describe("POST /notifications — body-size cap → 413", () => {
  it("a raw body over the 16 KiB cap is rejected before validation", async () => {
    const app = buildApp();
    const jwt = await tokenA();

    const rawBody = `{"title":"x","body":"${"B".repeat(20 * 1024)}","originApp":"estimai"}`;

    const res = await app.request("/notifications", {
      method: "POST",
      headers: bearerHeader(jwt),
      body: rawBody,
    });

    expect(res.status).toBe(413);
  });
});
