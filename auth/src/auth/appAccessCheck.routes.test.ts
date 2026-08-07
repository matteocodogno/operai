/**
 * Integration tests for POST /authz/app-access-check (T2, specs/013-estimate-
 * sharing — refs AC-1.1, AC-1.2).
 *
 * Strategy: exercise the REAL token-mint flow end-to-end against the live
 * local Postgres — mirrors `authz-resolve.routes.test.ts`'s pattern exactly
 * (same file, same reasoning):
 *
 *   1. POST /test-auth/session → mints a real better-auth session + cookie.
 *   2. GET  /auth/token        → a real RS256 JWT.
 *   3. Authorization: Bearer <token> → POST /authz/app-access-check.
 *
 * WHY THIS FILE LIVES IN `src/auth/`, NOT `src/authz/` (its "natural" home
 * next to the route it tests): the SAME confirmed Bun `mock.module` hazard
 * `authz/seed.test.ts` and `auth/authz-resolve.routes.test.ts` document —
 * resolving `auth.config` via `"../auth/auth.routes"` from a file living
 * OUTSIDE `src/auth/` collides, in a full repo-wide `bun test` run, with
 * sibling files in `src/authz/`/`src/admin/` that `mock.module` that exact
 * specifier string and never restore it. Living here and importing
 * `authRouter` via `"./auth.routes"` (a different specifier string)
 * reliably escapes it — confirmed by the identical reasoning already proven
 * out by `authz-resolve.routes.test.ts`. This file tests
 * `authz/appAccessCheck.routes.ts` (imported via
 * `"../authz/appAccessCheck.routes"`, which is safe — only the `auth.config`
 * resolution path is collision-prone) from this safer location.
 *
 * DB-ISOLATION: other tasks' tests may run concurrently against the same
 * shared local Postgres. Every fixture email/role name is suffixed with a
 * random run id + `crypto.randomUUID()`; every id this file creates is
 * tracked and deleted in `afterAll` regardless of outcome.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { db } from "../lib/db";

// ── Open the test-auth gate deterministically, independent of ambient .env ──
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
const { appAccessCheckRouter } = await import("../authz/appAccessCheck.routes");

const RUN_ID = crypto.randomUUID().slice(0, 8);
const APP_ID = `t2-app-${RUN_ID}`;

const createdUserIds = new Set<string>();
const createdRoleIds = new Set<string>();

afterAll(async () => {
  // Roles cascade-delete their permission_rule/user_role rows.
  await db.role.deleteMany({ where: { id: { in: Array.from(createdRoleIds) } } });
  await db.user.deleteMany({ where: { id: { in: Array.from(createdUserIds) } } });
});

/** Mints a real session + exchanges it for a real RS256 Bearer token for a fresh user. */
async function mintTokenForNewUser(
  label: string,
): Promise<{ userId: string; email: string; token: string }> {
  const email = `t2-${label}-${RUN_ID}-${crypto.randomUUID()}@operai.test`;
  const name = `T2 fixture — ${label}`;

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

  return { userId: sessionBody.userId, email: sessionBody.email, token };
}

/** Grants `(resource, action) = (appId, "access")` to `userId` via a fresh role. */
async function grantAppAccess(userId: string, appId: string, label: string): Promise<void> {
  const role = await db.role.create({
    data: { name: `t2-role-${label}-${RUN_ID}-${crypto.randomUUID()}` },
  });
  createdRoleIds.add(role.id);
  await db.permissionRule.create({
    data: { roleId: role.id, resource: appId, action: "access" },
  });
  await db.userRole.create({ data: { userId, roleId: role.id } });
}

async function callCheck(
  token: string,
  appId: string,
  email: string,
): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> {
  const res = await appAccessCheckRouter.request("/authz/app-access-check", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ appId, email }),
  });
  const body = (await res.json()) as Record<string, unknown>;
  return { status: res.status, body, headers: res.headers };
}

describe("POST /authz/app-access-check (T2, specs/013-estimate-sharing)", () => {
  beforeAll(async () => {
    const probe = await testAuthRouter.request("/test-auth/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: `t2-probe-${RUN_ID}@operai.test`, name: "probe" }),
    });
    expect(probe.status).toBe(200);
    const body = (await probe.json()) as { userId: string };
    createdUserIds.add(body.userId);
  });

  test("a caller WITH (appId,access), targeting an ACTIVE user WITH (appId,access), gets eligible:true + userId (happy path)", async () => {
    const caller = await mintTokenForNewUser("happy-caller");
    await grantAppAccess(caller.userId, APP_ID, "happy-caller");

    const target = await mintTokenForNewUser("happy-target");
    await grantAppAccess(target.userId, APP_ID, "happy-target");

    const { status, body } = await callCheck(caller.token, APP_ID, target.email);

    expect(status).toBe(200);
    expect(body).toEqual({ eligible: true, userId: target.userId });
  });

  test("no-such-user and user-exists-but-lacks-access return BYTE-IDENTICAL bodies with exactly one key (AC-1.2)", async () => {
    const caller = await mintTokenForNewUser("byte-identical-caller");
    await grantAppAccess(caller.userId, APP_ID, "byte-identical-caller");

    // Cause 1: no such user at all.
    const noSuchUserEmail = `nobody-${RUN_ID}-${crypto.randomUUID()}@operai.test`;
    const noSuchUser = await callCheck(caller.token, APP_ID, noSuchUserEmail);

    // Cause 2: a real, active user who simply never got (appId,"access").
    const noAccessTarget = await mintTokenForNewUser("no-access-target");
    const noAccess = await callCheck(caller.token, APP_ID, noAccessTarget.email);

    expect(noSuchUser.status).toBe(200);
    expect(noAccess.status).toBe(200);

    // Exactly one key, on BOTH — the anti-enumeration snapshot property.
    expect(Object.keys(noSuchUser.body)).toEqual(["eligible"]);
    expect(Object.keys(noAccess.body)).toEqual(["eligible"]);

    // Byte-identical bodies.
    expect(noSuchUser.body).toEqual({ eligible: false });
    expect(noAccess.body).toEqual({ eligible: false });
    expect(JSON.stringify(noSuchUser.body)).toBe(JSON.stringify(noAccess.body));
  });

  test("a soft-deleted target (even one that WOULD hold appId access) is eligible:false, never eligible:true", async () => {
    const caller = await mintTokenForNewUser("soft-delete-caller");
    await grantAppAccess(caller.userId, APP_ID, "soft-delete-caller");

    const target = await mintTokenForNewUser("soft-delete-target");
    await grantAppAccess(target.userId, APP_ID, "soft-delete-target");
    await db.user.update({ where: { id: target.userId }, data: { deletedAt: new Date() } });

    const { status, body } = await callCheck(caller.token, APP_ID, target.email);

    expect(status).toBe(200);
    expect(body).toEqual({ eligible: false });
  });

  test("a caller who does NOT hold (appId,access) themselves gets 403 app_access_required", async () => {
    const caller = await mintTokenForNewUser("no-grant-caller");
    // Deliberately no grantAppAccess call.

    const { status, body } = await callCheck(caller.token, APP_ID, "someone@operai.test");

    expect(status).toBe(403);
    expect(body["code"]).toBe("app_access_required");
  });

  test("a soft-deleted CALLER (residual JWT, ADR-0012) gets 403 app_access_required even though the token still verifies", async () => {
    const caller = await mintTokenForNewUser("soft-deleted-caller");
    await grantAppAccess(caller.userId, APP_ID, "soft-deleted-caller");
    await db.user.update({ where: { id: caller.userId }, data: { deletedAt: new Date() } });

    const { status, body } = await callCheck(caller.token, APP_ID, "someone@operai.test");

    expect(status).toBe(403);
    expect(body["code"]).toBe("app_access_required");
  });

  test("malformed appId/email → 400, without ever touching account existence", async () => {
    const caller = await mintTokenForNewUser("bad-input-caller");
    await grantAppAccess(caller.userId, APP_ID, "bad-input-caller");

    const badAppId = await callCheck(caller.token, "NOT VALID!!", "someone@operai.test");
    expect(badAppId.status).toBe(400);

    const badEmail = await callCheck(caller.token, APP_ID, "not-an-email");
    expect(badEmail.status).toBe(400);
  });

  test("401s when there is no Authorization header", async () => {
    const res = await appAccessCheckRouter.request("/authz/app-access-check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appId: APP_ID, email: "someone@operai.test" }),
    });
    expect(res.status).toBe(401);
  });

  test("the 41st attempt within the window is rate-limited (429 + Retry-After); the counter increments on both success and eligible:false (AC-1.2 rate limiting)", async () => {
    const caller = await mintTokenForNewUser("rate-limit-caller");
    await grantAppAccess(caller.userId, APP_ID, "rate-limit-caller");

    // Eligible target — success path is UNFLOORED, so this loop stays fast.
    const target = await mintTokenForNewUser("rate-limit-target");
    await grantAppAccess(target.userId, APP_ID, "rate-limit-target");

    const limit = env.APP_ACCESS_CHECK_RATE_LIMIT; // default 40
    for (let i = 0; i < limit; i++) {
      const { status } = await callCheck(caller.token, APP_ID, target.email);
      expect(status).toBe(200);
    }

    const overLimit = await callCheck(caller.token, APP_ID, target.email);
    expect(overLimit.status).toBe(429);
    expect(overLimit.body["code"]).toBe("rate_limited");
    expect(overLimit.headers.get("Retry-After")).toBeTruthy();
  }, 30000);

  test("timing identity (AC-1.2): both negative causes' medians are >= the floor and differ by < 10% of the floor over 50 samples each", async () => {
    // Fixed nonexistent email — reused across all "no-such-user" samples.
    const noSuchUserEmail = `timing-nobody-${RUN_ID}@operai.test`;

    // One fixed real, active, access-LESS target — reused across all
    // "lacks-access" samples.
    const lacksAccessTarget = await mintTokenForNewUser("timing-lacks-access-target");

    // Rate limit is 40/10min PER CALLER SUB — spread the 50+50 samples over
    // several callers (each well under the limit) so the limiter itself
    // never perturbs the measurement.
    const SAMPLES_PER_CAUSE = 50;
    const CALLS_PER_CALLER = 20; // < env.APP_ACCESS_CHECK_RATE_LIMIT (40)
    const callersNeeded = Math.ceil(SAMPLES_PER_CAUSE / CALLS_PER_CALLER);

    async function makeCallerPool(label: string): Promise<Array<{ token: string }>> {
      const pool: Array<{ token: string }> = [];
      for (let i = 0; i < callersNeeded; i++) {
        const caller = await mintTokenForNewUser(`timing-${label}-${i}`);
        await grantAppAccess(caller.userId, APP_ID, `timing-${label}-${i}`);
        pool.push({ token: caller.token });
      }
      return pool;
    }

    const noUserCallers = await makeCallerPool("no-user");
    const noAccessCallers = await makeCallerPool("no-access");

    async function sampleElapsedMs(token: string, email: string): Promise<number> {
      const start = performance.now();
      const { status, body } = await callCheck(token, APP_ID, email);
      const elapsed = performance.now() - start;
      expect(status).toBe(200);
      expect(body).toEqual({ eligible: false });
      return elapsed;
    }

    function median(values: number[]): number {
      const sorted = [...values].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
    }

    const noUserSamples: number[] = [];
    for (let i = 0; i < SAMPLES_PER_CAUSE; i++) {
      const caller = noUserCallers[i % noUserCallers.length]!;
      noUserSamples.push(await sampleElapsedMs(caller.token, noSuchUserEmail));
    }

    const noAccessSamples: number[] = [];
    for (let i = 0; i < SAMPLES_PER_CAUSE; i++) {
      const caller = noAccessCallers[i % noAccessCallers.length]!;
      noAccessSamples.push(await sampleElapsedMs(caller.token, lacksAccessTarget.email));
    }

    const medianNoUser = median(noUserSamples);
    const medianNoAccess = median(noAccessSamples);
    const floor = env.APP_ACCESS_CHECK_FLOOR_MS;

    // eslint-disable-next-line no-console
    console.log(
      `[T2 timing test] floor=${floor}ms medianNoUser=${medianNoUser.toFixed(2)}ms ` +
        `medianNoAccess=${medianNoAccess.toFixed(2)}ms delta=${Math.abs(medianNoUser - medianNoAccess).toFixed(2)}ms`,
    );

    expect(medianNoUser).toBeGreaterThanOrEqual(floor);
    expect(medianNoAccess).toBeGreaterThanOrEqual(floor);
    expect(Math.abs(medianNoUser - medianNoAccess)).toBeLessThan(floor * 0.1);
  }, 60000);
});
