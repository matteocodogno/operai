/**
 * Integration tests for the SSE endpoints (T7, specs/005-notification-center, ADR-0008).
 *
 * done when (tasks.md T7): integration tests — invalid/expired/used ticket → 401
 * (stream never opens); valid ticket streams a `notification` event on raise and
 * `unread-reset` event on mark-all-read; two connections for one sub both
 * receive fan-out.
 *
 * EXPIRY TEST STRATEGY: rather than mocking the `./ticketStore` singleton
 * module (Bun's `mock.module()` mutates the shared module-exports object
 * process-wide — per its own docs, "If the module is already loaded, exports
 * are overwritten" — which would leak into ticketStore.test.ts's own import of
 * `InProcessTicketStore` when the whole suite runs together), the "expired
 * ticket" test uses the REAL singleton (real ~30s TTL, ADR-0008) together with
 * `setSystemTime()` to fast-forward the clock past the TTL without a real 30s
 * wait, then restores real time immediately after. ticketStore.test.ts (unit)
 * separately covers the TTL mechanics generically with a parameterized TTL;
 * this file proves the ROUTE reacts correctly to an undefined consume() result.
 *
 * Heartbeat (`: heartbeat` every ~15s) is intentionally NOT asserted here — the
 * tasks.md T7 done-when list does not require it, and a real-time 15s wait per
 * test would make the suite unacceptably slow; heartbeat cadence is a constant
 * reviewed by inspection (stream.routes.ts HEARTBEAT_INTERVAL_MS).
 */

import { describe, it, expect, beforeAll, afterEach, mock, setSystemTime } from "bun:test";
import { Hono } from "hono";
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } from "jose";

// ─── Fixture keypair & jwtMiddleware mock (needed for POST stream-ticket) ────

let userAPrivateKey: CryptoKey;
const TEST_KID_A = "operai-auth-rs256-v1";
const TEST_ISSUER = "http://localhost:3001";
const TEST_AUDIENCE = "operai-suite-test";

const USER_A_ID = "test-user-a-t7";
const USER_A_EMAIL = "user-a-t7@example.com";

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

  return { jwtMiddleware, JwtVariables: {}, isJwksReady: () => true };
});

process.env["ALLOWED_ORIGINS"] = "http://localhost:5173";
process.env["AUTH_JWKS_URL"] = "http://localhost:3001/auth/jwks";
process.env["AUTH_ISSUER"] = TEST_ISSUER;
process.env["AUTH_AUDIENCE"] = TEST_AUDIENCE;
process.env["MAX_STREAM_DURATION"] = "1800";
process.env["NODE_ENV"] = "test";

const { streamRouter } = await import("./stream.routes");
const { eventBus } = await import("./eventBus");
const { ticketStore } = await import("./ticketStore");

// ─── Helpers ──────────────────────────────────────────────────────────────────

const buildApp = () => {
  const app = new Hono();
  app.route("/", streamRouter);
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

type SSEEvent = { event?: string | undefined; data?: string | undefined };

/**
 * Reads Server-Sent Events off a streaming Response body until `untilCount`
 * parsed events (heartbeats excluded) have arrived or `timeoutMs` elapses.
 * ALWAYS cancels the reader before returning — otherwise the route's
 * setInterval/setTimeout handles (heartbeat, MAX_STREAM_DURATION) are never
 * cleared and the connection is never unsubscribed from the EventBus.
 */
const collectSSE = async (
  response: Response,
  untilCount: number,
  timeoutMs = 2000,
): Promise<SSEEvent[]> => {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events: SSEEvent[] = [];
  const deadline = Date.now() + timeoutMs;

  try {
    while (events.length < untilCount && Date.now() < deadline) {
      const remaining = deadline - Date.now();
      const result = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>((resolve) =>
          setTimeout(() => resolve({ done: true, value: undefined }), Math.max(0, remaining)),
        ),
      ]);
      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true });

      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (raw.startsWith(":")) continue; // heartbeat comment — not a parsed event
        const eventMatch = /^event: (.+)$/m.exec(raw);
        const dataMatch = /^data: (.+)$/m.exec(raw);
        events.push({ event: eventMatch?.[1], data: dataMatch?.[1] });
        if (events.length >= untilCount) break;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }

  return events;
};

beforeAll(async () => {
  const kpA = await generateKeyPair("RS256", { extractable: true });
  userAPrivateKey = kpA.privateKey;
  const pubJwkA = await exportJWK(kpA.publicKey);

  localJWKS = createLocalJWKSet({
    keys: [{ ...pubJwkA, use: "sig", alg: "RS256", kid: TEST_KID_A }],
  });
  jwksProxy = localJWKS;
});

afterEach(() => {
  // Give any just-cancelled stream's onAbort cleanup a tick to run before the
  // next test asserts on eventBus.connectionCount().
});

// ─── POST /notifications/stream-ticket — mint ────────────────────────────────

describe("POST /notifications/stream-ticket", () => {
  it("200: authenticated caller receives an opaque ticket + expiresIn: 30", async () => {
    const app = buildApp();
    const jwt = await tokenA();

    const res = await app.request("/notifications/stream-ticket", {
      method: "POST",
      headers: { Authorization: `Bearer ${jwt}` },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ticket: string; expiresIn: number };
    expect(typeof body.ticket).toBe("string");
    expect(body.ticket.length).toBeGreaterThan(0);
    expect(body.expiresIn).toBe(30);
  });

  it("401: unauthenticated caller cannot mint a ticket", async () => {
    const app = buildApp();
    const res = await app.request("/notifications/stream-ticket", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("mints a fresh ticket on each call", async () => {
    const app = buildApp();
    const jwt = await tokenA();

    const res1 = await app.request("/notifications/stream-ticket", {
      method: "POST",
      headers: { Authorization: `Bearer ${jwt}` },
    });
    const res2 = await app.request("/notifications/stream-ticket", {
      method: "POST",
      headers: { Authorization: `Bearer ${jwt}` },
    });
    const body1 = (await res1.json()) as { ticket: string };
    const body2 = (await res2.json()) as { ticket: string };
    expect(body1.ticket).not.toBe(body2.ticket);
  });
});

// ─── GET /notifications/stream — auth rejection paths (stream never opens) ──

describe("GET /notifications/stream — invalid/expired/used ticket → 401, stream never opens", () => {
  it("missing ticket query param → 401 Problem JSON", async () => {
    const app = buildApp();
    const res = await app.request("/notifications/stream");
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as { status: number; type: string };
    expect(body.status).toBe(401);
    expect(body.type).toBe("https://httpstatuses.com/401");
  });

  it("unknown / never-minted ticket → 401", async () => {
    const app = buildApp();
    const res = await app.request("/notifications/stream?ticket=never-minted-ticket-xyz");
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it("expired ticket → 401 (real ~30s TTL, fast-forwarded via setSystemTime)", async () => {
    const app = buildApp();
    const ticket = ticketStore.mint(USER_A_ID);

    try {
      // Fast-forward past the real ADR-0008 ~30s TTL without a real 30s wait
      // (see file header EXPIRY TEST STRATEGY).
      setSystemTime(new Date(Date.now() + 31_000));

      const res = await app.request(`/notifications/stream?ticket=${ticket}`);
      expect(res.status).toBe(401);
    } finally {
      setSystemTime(); // restore real time for every subsequent test
    }
  });

  it("already-used ticket → 401 on the second attempt (single-use)", async () => {
    const app = buildApp();
    const ticket = ticketStore.mint(USER_A_ID);

    // First connection consumes the ticket.
    const first = await app.request(`/notifications/stream?ticket=${ticket}`);
    expect(first.status).toBe(200);
    await first.body?.cancel();

    // Second attempt with the SAME ticket must be rejected.
    const second = await app.request(`/notifications/stream?ticket=${ticket}`);
    expect(second.status).toBe(401);
  });
});

// ─── GET /notifications/stream — valid ticket opens the stream ──────────────

describe("GET /notifications/stream — valid ticket", () => {
  it("200 with Content-Type: text/event-stream", async () => {
    const app = buildApp();
    const ticket = ticketStore.mint(USER_A_ID);

    const res = await app.request(`/notifications/stream?ticket=${ticket}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    await res.body?.cancel();
  });

  it("streams a `notification` event when one is published to the bound sub (AC-1.4/1.5)", async () => {
    const app = buildApp();
    const ticket = ticketStore.mint(USER_A_ID);

    const res = await app.request(`/notifications/stream?ticket=${ticket}`);
    expect(res.status).toBe(200);

    // Give the route's eventBus.subscribe() a tick to register before publishing.
    await new Promise((resolve) => setTimeout(resolve, 10));

    const payload = {
      id: "notif-stream-1",
      title: "Export finished",
      body: "Ready",
      severity: "success",
      originApp: "estimai",
      toastWorthy: true,
      readAt: null,
      createdAt: new Date().toISOString(),
    };
    eventBus.publish(USER_A_ID, { type: "notification", data: payload });

    const events = await collectSSE(res, 1);
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toBe("notification");
    expect(JSON.parse(events[0]?.data ?? "{}")).toEqual(payload);
  });

  it("streams an `unread-reset` event on mark-all-read (AC-3.1 across tabs)", async () => {
    const app = buildApp();
    const ticket = ticketStore.mint(USER_A_ID);

    const res = await app.request(`/notifications/stream?ticket=${ticket}`);
    expect(res.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 10));

    eventBus.publish(USER_A_ID, { type: "unread-reset", data: { count: 0 } });

    const events = await collectSSE(res, 1);
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toBe("unread-reset");
    expect(JSON.parse(events[0]?.data ?? "{}")).toEqual({ count: 0 });
  });

  it("does NOT receive an event published to a different sub (AC-6.2 isolation)", async () => {
    const app = buildApp();
    const ticket = ticketStore.mint(USER_A_ID);

    const res = await app.request(`/notifications/stream?ticket=${ticket}`);
    expect(res.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 10));

    eventBus.publish("some-other-user", {
      type: "notification",
      data: {
        id: "notif-not-mine",
        title: "Not for you",
        body: "…",
        severity: "info",
        originApp: "estimai",
        toastWorthy: false,
        readAt: null,
        createdAt: new Date().toISOString(),
      },
    });

    // Nothing arrives — collectSSE times out at 300ms with zero events.
    const events = await collectSSE(res, 1, 300);
    expect(events).toHaveLength(0);
  });

  it("two connections for the SAME sub both receive one published event (T7 done-when: fan-out)", async () => {
    const app = buildApp();
    const ticket1 = ticketStore.mint(USER_A_ID);
    const ticket2 = ticketStore.mint(USER_A_ID);

    const res1 = await app.request(`/notifications/stream?ticket=${ticket1}`);
    const res2 = await app.request(`/notifications/stream?ticket=${ticket2}`);
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const payload = {
      id: "notif-fanout-1",
      title: "Fan-out test",
      body: "…",
      severity: "info",
      originApp: "estimai",
      toastWorthy: false,
      readAt: null,
      createdAt: new Date().toISOString(),
    };
    eventBus.publish(USER_A_ID, { type: "notification", data: payload });

    const [events1, events2] = await Promise.all([collectSSE(res1, 1), collectSSE(res2, 1)]);

    expect(events1).toHaveLength(1);
    expect(events2).toHaveLength(1);
    expect(JSON.parse(events1[0]?.data ?? "{}")).toEqual(payload);
    expect(JSON.parse(events2[0]?.data ?? "{}")).toEqual(payload);
  });

  it("cancelling the connection unsubscribes from the EventBus (connectionCount drops)", async () => {
    const app = buildApp();
    const ticket = ticketStore.mint(USER_A_ID);

    const before = eventBus.connectionCount();
    const res = await app.request(`/notifications/stream?ticket=${ticket}`);
    expect(res.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(eventBus.connectionCount()).toBe(before + 1);

    await res.body?.cancel();
    // onAbort's cleanup runs synchronously inside the cancel callback chain —
    // give it a tick to settle.
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(eventBus.connectionCount()).toBe(before);
  });
});
