/**
 * Integration tests for POST /authz/users/identities (T3, specs/013-estimate-
 * sharing — refs AC-2.1, AC-10.5).
 *
 * Strategy + WHY THIS FILE LIVES IN `src/auth/`: identical to
 * `appAccessCheck.routes.test.ts` (same file, same reasoning) — the real
 * token-mint flow via `testAuthRouter`/`authRouter` collides with sibling
 * `src/authz/`/`src/admin/` files' `mock.module("../auth/auth.config", ...)`
 * in a full repo-wide `bun test` run unless resolved via `"./auth.routes"`
 * from within `src/auth/` itself (see `authz-resolve.routes.test.ts`'s doc
 * comment for the full, already-proven-out rationale).
 *
 * DB-ISOLATION: every fixture email/id is suffixed with a random run id +
 * `crypto.randomUUID()`; every id this file creates is tracked and deleted
 * in `afterAll` regardless of outcome.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { db } from "../lib/db";

process.env["ENABLE_TEST_AUTH"] = "true";
if (process.env["NODE_ENV"] === "production") {
  process.env["NODE_ENV"] = "test";
}

const { env } = await import("../lib/env");
(env as unknown as Record<string, unknown>)["ENABLE_TEST_AUTH"] = true;
if (env.NODE_ENV === "production") {
  (env as unknown as Record<string, unknown>)["NODE_ENV"] = "test";
}

const { testAuthRouter } = await import("../test-auth/test-auth.routes");
const { authRouter } = await import("./auth.routes");
const { identitiesRouter } = await import("../authz/identities.routes");

const RUN_ID = crypto.randomUUID().slice(0, 8);

const createdUserIds = new Set<string>();

afterAll(async () => {
  await db.user.deleteMany({ where: { id: { in: Array.from(createdUserIds) } } });
});

async function mintTokenForNewUser(
  label: string,
): Promise<{ userId: string; email: string; name: string; token: string }> {
  const email = `t3-${label}-${RUN_ID}-${crypto.randomUUID()}@operai.test`;
  const name = `T3 fixture — ${label}`;

  const sessionRes = await testAuthRouter.request("/test-auth/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, name }),
  });
  expect(sessionRes.status).toBe(200);
  const sessionBody = (await sessionRes.json()) as { userId: string; email: string };
  createdUserIds.add(sessionBody.userId);

  const setCookie = sessionRes.headers.get("set-cookie");
  const cookiePair = (setCookie as string).split(";")[0] ?? "";

  const tokenRes = await authRouter.request("/auth/token", {
    method: "GET",
    headers: { Cookie: cookiePair },
  });
  expect(tokenRes.status).toBe(200);
  const { token } = (await tokenRes.json()) as { token: string };

  return { userId: sessionBody.userId, email: sessionBody.email, name, token };
}

async function callIdentities(
  token: string,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await identitiesRouter.request("/authz/users/identities", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as Record<string, unknown>;
  return { status: res.status, body: json };
}

describe("POST /authz/users/identities (T3, specs/013-estimate-sharing)", () => {
  beforeAll(async () => {
    const probe = await testAuthRouter.request("/test-auth/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: `t3-probe-${RUN_ID}@operai.test`, name: "probe" }),
    });
    expect(probe.status).toBe(200);
    const body = (await probe.json()) as { userId: string };
    createdUserIds.add(body.userId);
  });

  test("resolves an active user to status:active with their name", async () => {
    const caller = await mintTokenForNewUser("active-caller");
    const target = await mintTokenForNewUser("active-target");

    const { status, body } = await callIdentities(caller.token, { ids: [target.userId] });

    expect(status).toBe(200);
    expect(body["users"]).toEqual([
      { id: target.userId, status: "active", name: target.name },
    ]);
  });

  test("resolves a soft-deleted user to status:deleted with name:null (AC-10.5 — never a stale name)", async () => {
    const caller = await mintTokenForNewUser("deleted-caller");
    const target = await mintTokenForNewUser("deleted-target");
    await db.user.update({ where: { id: target.userId }, data: { deletedAt: new Date() } });

    const { status, body } = await callIdentities(caller.token, { ids: [target.userId] });

    expect(status).toBe(200);
    expect(body["users"]).toEqual([{ id: target.userId, status: "deleted", name: null }]);
  });

  test("resolves an id with no matching row to status:unknown with name:null", async () => {
    const caller = await mintTokenForNewUser("unknown-caller");
    const bogusId = `nonexistent-${RUN_ID}-${crypto.randomUUID()}`;

    const { status, body } = await callIdentities(caller.token, { ids: [bogusId] });

    expect(status).toBe(200);
    expect(body["users"]).toEqual([{ id: bogusId, status: "unknown", name: null }]);
  });

  test("resolves all three statuses together, one entry per requested id", async () => {
    const caller = await mintTokenForNewUser("mixed-caller");
    const active = await mintTokenForNewUser("mixed-active");
    const deleted = await mintTokenForNewUser("mixed-deleted");
    await db.user.update({ where: { id: deleted.userId }, data: { deletedAt: new Date() } });
    const bogusId = `mixed-nonexistent-${RUN_ID}-${crypto.randomUUID()}`;

    const { status, body } = await callIdentities(caller.token, {
      ids: [active.userId, deleted.userId, bogusId],
    });

    expect(status).toBe(200);
    const users = body["users"] as Array<{ id: string; status: string; name: string | null }>;
    expect(users).toHaveLength(3);
    expect(users).toContainEqual({ id: active.userId, status: "active", name: active.name });
    expect(users).toContainEqual({ id: deleted.userId, status: "deleted", name: null });
    expect(users).toContainEqual({ id: bogusId, status: "unknown", name: null });
  });

  // ── Directory-shape contract test — the Non-goal boundary ─────────────────
  // Accepts ids ONLY. A body carrying email/name/query/prefix must be
  // rejected outright, not silently ignored.
  test.each([
    ["email", { ids: [], email: "someone@operai.test" }],
    ["name", { ids: [], name: "Marco Rossi" }],
    ["query", { ids: [], query: "marco" }],
    ["prefix", { ids: [], prefix: "mar" }],
  ])("rejects a body carrying a disallowed '%s' key (directory-shape contract)", async (_key, extra) => {
    const caller = await mintTokenForNewUser("directory-shape-caller");
    const { status } = await callIdentities(caller.token, extra);
    expect(status).toBe(400);
  });

  test("rejects an empty ids array", async () => {
    const caller = await mintTokenForNewUser("empty-ids-caller");
    const { status } = await callIdentities(caller.token, { ids: [] });
    expect(status).toBe(400);
  });

  test("rejects more than 100 ids", async () => {
    const caller = await mintTokenForNewUser("over-cap-caller");
    const ids = Array.from({ length: 101 }, (_, i) => `id-${i}`);
    const { status } = await callIdentities(caller.token, { ids });
    expect(status).toBe(400);
  });

  test("accepts exactly 100 ids", async () => {
    const caller = await mintTokenForNewUser("at-cap-caller");
    const ids = Array.from({ length: 100 }, (_, i) => `id-${i}-${RUN_ID}`);
    const { status, body } = await callIdentities(caller.token, { ids });
    expect(status).toBe(200);
    expect((body["users"] as unknown[]).length).toBe(100);
  });

  test("never returns an email field anywhere in the response", async () => {
    const caller = await mintTokenForNewUser("no-email-caller");
    const target = await mintTokenForNewUser("no-email-target");

    const { body } = await callIdentities(caller.token, { ids: [target.userId] });
    const users = body["users"] as Array<Record<string, unknown>>;
    for (const user of users) {
      expect(Object.keys(user).sort()).toEqual(["id", "name", "status"]);
      expect(user["email"]).toBeUndefined();
    }
  });

  test("401s when there is no Authorization header", async () => {
    const res = await identitiesRouter.request("/authz/users/identities", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: ["someid"] }),
    });
    expect(res.status).toBe(401);
  });

  // ── T27: rate limiting (specs/013-estimate-sharing) — closes the drift
  // documented in this route's header comment: plan.md's contract lists
  // 429 + Retry-After, but T3 shipped unthrottled. T27 reuses T1's
  // rateLimiter.ts with its own IDENTITIES_RATE_LIMIT/_WINDOW_MS pair.
  test("the (limit+1)th attempt within the window is rate-limited (429 + Retry-After), and the limiter is keyed per caller sub — a fresh caller is unaffected", async () => {
    const caller = await mintTokenForNewUser("rate-limit-caller");
    const target = await mintTokenForNewUser("rate-limit-target");

    const limit = env.IDENTITIES_RATE_LIMIT; // default 120
    for (let i = 0; i < limit; i++) {
      const { status } = await callIdentities(caller.token, { ids: [target.userId] });
      expect(status).toBe(200);
    }

    const overLimit = await callIdentities(caller.token, { ids: [target.userId] });
    expect(overLimit.status).toBe(429);
    expect(overLimit.body["code"]).toBe("rate_limited");

    const freshCaller = await mintTokenForNewUser("rate-limit-fresh-caller");
    const stillOk = await callIdentities(freshCaller.token, { ids: [target.userId] });
    expect(stillOk.status).toBe(200);
  }, 30000);

  test("a 429 response carries a Retry-After header", async () => {
    const caller = await mintTokenForNewUser("retry-after-caller");
    const target = await mintTokenForNewUser("retry-after-target");

    const limit = env.IDENTITIES_RATE_LIMIT;
    for (let i = 0; i < limit; i++) {
      const { status } = await callIdentities(caller.token, { ids: [target.userId] });
      expect(status).toBe(200);
    }

    const res = await identitiesRouter.request("/authz/users/identities", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${caller.token}` },
      body: JSON.stringify({ ids: [target.userId] }),
    });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
  }, 30000);
});
