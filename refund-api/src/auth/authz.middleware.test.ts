/**
 * Integration tests for authzMiddleware (T6, specs/007-refund-service,
 * ADR-0014).
 *
 * Strategy
 * ────────
 * - `../authz/resolveClient` (the only network-calling module authzMiddleware
 *   depends on) is `mock.module()`d, so these tests never make a real HTTP
 *   call to `auth`. This mirrors `auth/src/invitations/invitations.routes
 *   .test.ts`'s pattern of mocking a dedicated HTTP-client module rather than
 *   mocking global `fetch` or re-mocking `jose` (which — per estimai-api's
 *   `estimates.routes.test.ts` comment — collides across test files sharing
 *   a bun worker process).
 * - Identity (`userId`/`permEpoch`) is supplied by a tiny test-only
 *   middleware reading `X-Test-Sub`/`X-Test-Epoch` request headers, standing
 *   in for jwtMiddleware (which authzMiddleware only depends on for its
 *   TYPES, not its runtime — no need to exercise real JWT verification here;
 *   that is jwt.middleware.test.ts's job).
 * - A dummy protected route applies `hasCapability` from `conditions.ts` to
 *   gate on `request:review`, proving the missing-capability → 403 path
 *   without wiring any real T7+ domain route (out of scope for T6).
 *
 * Done-when coverage (tasks.md T6)
 * ─────────────────────────────────
 * - missing capability → 403
 * - the cache serves a second call for the SAME epoch without re-hitting auth
 *   (asserted via the resolve-client call counter)
 * - a DIFFERENT epoch is a cache miss (re-hits auth) — proves the cache key
 *   is actually epoch-scoped, not just sub-scoped
 * - the 30s hard TTL backstop forces a refetch even within the same epoch
 * - auth-down → 503, NEVER 200
 */

import { describe, it, expect, beforeEach, mock, spyOn } from "bun:test";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { hasCapability } from "../authz/conditions";
import type { ResolvedPermission, ResolveResponse } from "../authz/resolveClient";

// ─── Set env vars BEFORE importing anything that evaluates env.ts ─────────
//
// DATABASE_URL uses `??=` (set ONLY if unset), never `=` — see
// jwt.middleware.test.ts's identical comment: `bun test` shares one process
// across every test file, so an unconditional overwrite here would
// permanently clobber the real DATABASE_URL for every file that runs after
// this one, including T5's real-Postgres `db.audit-immutability.test.ts`.
// This file never touches a database (its only dependency, resolveClient,
// is fully mocked below), so a placeholder is fine when nothing else has
// already supplied a real value.

process.env["DATABASE_URL"] ??= "postgresql://test:test@localhost:5435/test";
process.env["ALLOWED_ORIGINS"] = "http://localhost:5173";
process.env["AUTH_JWKS_URL"] = "http://localhost:3001/auth/jwks";
process.env["AUTH_ISSUER"] = "http://localhost:3001";
process.env["AUTH_AUDIENCE"] = "operai-suite";
process.env["AUTH_BASE_URL"] = "http://localhost:3001";
process.env["NODE_ENV"] = "test";
process.env["NOTIFY_INTERNAL_TOKEN"] = "test-notify-internal-token-at-least-32-characters";
process.env["NOTIFY_INTERNAL_URL"] = "http://localhost:8081";

// ─── Mock the resolve-client module (the only network dependency) ─────────

let resolveImpl: (authorizationHeader: string) => Promise<ResolveResponse> =
  async () => {
    throw new Error("resolveImpl not configured for this test");
  };
let resolveCallCount = 0;

mock.module("../authz/resolveClient", () => ({
  fetchAuthzResolve: async (authorizationHeader: string) => {
    resolveCallCount++;
    return resolveImpl(authorizationHeader);
  },
}));

const { authzMiddleware, __resetAuthzCacheForTests } = await import(
  "./authz.middleware"
);

// ─── Test fixtures ──────────────────────────────────────────────────────────

const REVIEW_PERMISSIONS: ResolveResponse = {
  sub: "user-accounting",
  epoch: 1,
  permissions: [
    { resource: "refund", action: "access", conditions: null },
    { resource: "request", action: "review", conditions: null },
  ],
  entity: "welld_it",
  jobTitle: null,
};

const NO_REVIEW_PERMISSIONS: ResolveResponse = {
  sub: "user-employee",
  epoch: 1,
  permissions: [{ resource: "refund", action: "access", conditions: null }],
  entity: "welld_it",
  jobTitle: null,
};

// ─── Test app: test-only identity middleware + authzMiddleware ────────────

type TestVariables = {
  userId: string;
  email: string;
  permEpoch: number;
  authz: { permissions: readonly ResolvedPermission[]; entity: string | null };
};

const fakeIdentityMiddleware = createMiddleware<{ Variables: TestVariables }>(
  async (c, next) => {
    c.set("userId", c.req.header("X-Test-Sub") ?? "user-1");
    c.set("email", "test@example.com");
    c.set("permEpoch", Number(c.req.header("X-Test-Epoch") ?? "0"));
    return next();
  },
);

function buildApp() {
  const app = new Hono<{ Variables: TestVariables }>();
  app.use("/protected", fakeIdentityMiddleware);
  // biome-ignore lint: authzMiddleware's Variables type is a superset (JwtVariables & {authz}) — compatible at runtime.
  app.use("/protected", authzMiddleware as never);
  app.get("/protected", (c) => {
    const authz = c.get("authz");
    if (!hasCapability(authz.permissions, "request", "review")) {
      return c.json({ error: "forbidden" }, 403);
    }
    return c.json({ permissions: authz.permissions, entity: authz.entity }, 200);
  });
  return app;
}

const requestOptions = (sub: string, epoch: number) => ({
  headers: {
    Authorization: `Bearer fake-token-for-${sub}`,
    "X-Test-Sub": sub,
    "X-Test-Epoch": String(epoch),
  },
});

// ─── Test setup ─────────────────────────────────────────────────────────────

beforeEach(() => {
  __resetAuthzCacheForTests();
  resolveCallCount = 0;
  resolveImpl = async () => REVIEW_PERMISSIONS;
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("authzMiddleware", () => {
  it("missing capability → 403 (capability check, not a 404 — wholesale denial)", async () => {
    resolveImpl = async () => NO_REVIEW_PERMISSIONS;
    const app = buildApp();

    const res = await app.request(
      "/protected",
      requestOptions("user-employee", 1),
    );

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("forbidden");
  });

  it("a caller who holds the capability gets 200 with their resolved permissions/entity", async () => {
    const app = buildApp();

    const res = await app.request(
      "/protected",
      requestOptions("user-accounting", 1),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      permissions: unknown[];
      entity: string | null;
    };
    expect(body.entity).toBe("welld_it");
    expect(body.permissions).toHaveLength(2);
  });

  it("caches by (sub, perm_epoch) — a second call for the SAME sub+epoch does not re-hit auth", async () => {
    const app = buildApp();

    const res1 = await app.request(
      "/protected",
      requestOptions("user-accounting", 1),
    );
    const res2 = await app.request(
      "/protected",
      requestOptions("user-accounting", 1),
    );

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    // The resolve client must have been invoked exactly ONCE — the second
    // call is served entirely from the in-process cache.
    expect(resolveCallCount).toBe(1);
  });

  it("a DIFFERENT perm_epoch for the same sub is a cache MISS — re-resolves from auth", async () => {
    const app = buildApp();

    await app.request("/protected", requestOptions("user-accounting", 1));
    await app.request("/protected", requestOptions("user-accounting", 2));

    // Epoch bump (e.g. an admin grant change) must force a fresh resolve —
    // this is the whole point of keying the cache by epoch, not just sub.
    expect(resolveCallCount).toBe(2);
  });

  it("a DIFFERENT sub with the same epoch is also a cache MISS", async () => {
    const app = buildApp();

    await app.request("/protected", requestOptions("user-accounting", 1));
    await app.request("/protected", requestOptions("user-other", 1));

    expect(resolveCallCount).toBe(2);
  });

  it("the 30s hard TTL backstop forces a refetch even within the SAME (sub, epoch)", async () => {
    const app = buildApp();
    const realNow = Date.now;

    try {
      let simulatedNow = realNow();
      const nowSpy = spyOn(Date, "now").mockImplementation(
        () => simulatedNow,
      );

      await app.request("/protected", requestOptions("user-accounting", 1));
      expect(resolveCallCount).toBe(1);

      // Still within the 30s window — served from cache.
      simulatedNow += 10_000;
      await app.request("/protected", requestOptions("user-accounting", 1));
      expect(resolveCallCount).toBe(1);

      // Past the 30s TTL — cache entry is stale even though (sub, epoch)
      // hasn't changed; must re-resolve.
      simulatedNow += 25_000;
      await app.request("/protected", requestOptions("user-accounting", 1));
      expect(resolveCallCount).toBe(2);

      nowSpy.mockRestore();
    } finally {
      expect(Date.now).toBe(realNow);
    }
  });

  it("auth outage (resolve client throws) → 503, NEVER 200 (fail-closed, ADR-0014 point 4)", async () => {
    resolveImpl = async () => {
      throw new Error("simulated auth outage — connection refused");
    };
    const app = buildApp();

    const res = await app.request(
      "/protected",
      requestOptions("user-accounting", 1),
    );

    expect(res.status).toBe(503);
    expect(res.status).not.toBe(200);
    const body = (await res.json()) as {
      type: string;
      status: number;
      title: string;
    };
    expect(body.type).toBe("https://httpstatuses.com/503");
    expect(body.status).toBe(503);
    expect(body.title).toBe("Service Unavailable");
  });

  it("auth outage never serves a stale cache entry — a prior success does not paper over a later outage", async () => {
    const app = buildApp();

    // First call succeeds and populates the cache.
    const res1 = await app.request(
      "/protected",
      requestOptions("user-accounting", 1),
    );
    expect(res1.status).toBe(200);

    // Bump the epoch (simulating a grant change) and make auth fail for the
    // new epoch — the stale (now superseded) cache entry for epoch=1 must
    // NOT be reused for epoch=2; the caller must be denied, not silently
    // served epoch=1's permissions.
    resolveImpl = async () => {
      throw new Error("simulated auth outage");
    };
    const res2 = await app.request(
      "/protected",
      requestOptions("user-accounting", 2),
    );

    expect(res2.status).toBe(503);
  });
});
