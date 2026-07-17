/**
 * Integration tests for GET /authz/resolve (T1, specs/007-refund-service —
 * refs AC-5.4, AC-6.4, AC-7.5; ADR-0014).
 *
 * Strategy: exercise the REAL token-mint flow end-to-end against the live
 * local Postgres (no mocks on auth.config/definePayload/the jwt plugin) —
 * mirrors `jwt-claims.contract.test.ts`'s pattern rather than
 * `authz/authz.routes.test.ts`'s session-cookie mock (there is no session
 * cookie in this flow; the whole point of T1 is the Bearer-only seam):
 *
 *   1. POST /test-auth/session → mints a real better-auth session + cookie
 *      for a freshly created, uniquely-emailed test user.
 *   2. GET  /auth/token        → better-auth's jwt plugin signs a real RS256
 *      JWT (the SAME rotating-kid keypair `authz/resolveAuth.middleware.ts`
 *      verifies against via `/auth/jwks` — never the unrelated static
 *      `/.well-known/jwks.json` env keypair, per ADR-0005's correction).
 *   3. Authorization: Bearer <token> → GET /authz/resolve.
 *
 * WHY THIS FILE LIVES IN `src/auth/`, NOT `src/authz/` (its "natural" home
 * next to the route it tests): empirically, resolving `auth.config` via
 * `authRouter` imported as `"../auth/auth.routes"` from OUTSIDE this
 * directory collides with sibling test files elsewhere in the suite that
 * `mock.module("../auth/auth.config", ...)` and never restore it (the SAME
 * confirmed Bun `mock.module` hazard `authz/seed.test.ts`'s doc comment
 * describes) — but resolving it as `"./auth.routes"` FROM `src/auth/`
 * itself (exactly what `jwt-claims.contract.test.ts` already does, right
 * next to this file) reliably escapes it. Confirmed by direct experiment:
 * the identical mint flow fails when the test file lives in `src/authz/`
 * and imports `authRouter` via `"../auth/auth.routes"`, and passes when it
 * lives here and imports it via `"./auth.routes"`. This file tests
 * `authz/resolve.routes.ts` (imported via `"../authz/resolve.routes"`,
 * which is safe — only the `auth.config` resolution path is collision-
 * prone) from this safer location rather than risk full-suite flakiness.
 *
 * DB-ISOLATION: other spec-007/spec-004 tasks may run `bun test` concurrently
 * against the same shared local Postgres. Every fixture email/role name is
 * suffixed with a random run id + `crypto.randomUUID()` so concurrent runs
 * cannot collide, and every id this file creates is tracked and deleted in
 * `afterAll` regardless of test outcome.
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
const { resolveRouter } = await import("../authz/resolve.routes");

const RUN_ID = crypto.randomUUID().slice(0, 8);

const createdUserIds = new Set<string>();
const createdRoleIds = new Set<string>();

afterAll(async () => {
  await db.role.deleteMany({ where: { id: { in: Array.from(createdRoleIds) } } });
  await db.user.deleteMany({ where: { id: { in: Array.from(createdUserIds) } } });
});

/** Mints a real session + exchanges it for a real RS256 Bearer token for a fresh user. */
async function mintTokenForNewUser(
  label: string,
  attrs: { entity?: string; jobTitle?: string } = {},
): Promise<{ userId: string; email: string; token: string }> {
  const email = `t1-resolve-${label}-${RUN_ID}-${crypto.randomUUID()}@operai.test`;
  const name = `T1 fixture — ${label}`;

  const sessionRes = await testAuthRouter.request("/test-auth/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, name }),
  });
  expect(sessionRes.status).toBe(200);
  const sessionBody = (await sessionRes.json()) as { userId: string; email: string };
  createdUserIds.add(sessionBody.userId);

  if (attrs.entity !== undefined || attrs.jobTitle !== undefined) {
    await db.user.update({
      where: { id: sessionBody.userId },
      data: {
        ...(attrs.entity !== undefined ? { entity: attrs.entity } : {}),
        ...(attrs.jobTitle !== undefined ? { jobTitle: attrs.jobTitle } : {}),
      },
    });
  }

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

async function makeRole(label: string) {
  const role = await db.role.create({
    data: { name: `t1-resolve-role-${label}-${RUN_ID}-${crypto.randomUUID()}` },
  });
  createdRoleIds.add(role.id);
  return role;
}

describe("GET /authz/resolve (T1, specs/007-refund-service)", () => {
  beforeAll(async () => {
    // Sanity: the test-auth gate must be live for this whole file's mint flow.
    const probe = await testAuthRouter.request("/test-auth/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: `t1-probe-${RUN_ID}@operai.test`, name: "probe" }),
    });
    expect(probe.status).toBe(200);
    const body = (await probe.json()) as { userId: string };
    createdUserIds.add(body.userId);
  });

  test("a valid Bearer token returns the caller's own permissions + epoch + entity/jobTitle (AC-5.4/6.4/7.5)", async () => {
    const role = await makeRole("grants");
    await db.permissionRule.create({
      data: {
        roleId: role.id,
        resource: "request",
        action: "review",
        conditions: { attributes: [{ key: "entity", match: "user" }] },
      },
    });

    const { userId, token } = await mintTokenForNewUser("grants", {
      entity: "welld_it",
      jobTitle: "Accountant",
    });
    await db.userRole.create({ data: { userId, roleId: role.id } });

    const res = await resolveRouter.request("/authz/resolve", {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sub: string;
      epoch: number;
      permissions: Array<{ resource: string; action: string; conditions: unknown }>;
      entity: string | null;
      jobTitle: string | null;
    };

    expect(body.sub).toBe(userId);
    expect(body.epoch).toBe(0);
    expect(body.entity).toBe("welld_it");
    expect(body.jobTitle).toBe("Accountant");
    expect(body.permissions).toContainEqual({
      resource: "request",
      action: "review",
      conditions: { attributes: [{ key: "entity", match: "user" }] },
    });
  });

  test("a caller with no grants and no entity/jobTitle set gets empty permissions and null attributes (default-deny)", async () => {
    const { userId, token } = await mintTokenForNewUser("no-grants");

    const res = await resolveRouter.request("/authz/resolve", {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sub: string;
      permissions: unknown[];
      entity: string | null;
      jobTitle: string | null;
    };
    expect(body.sub).toBe(userId);
    expect(body.permissions).toEqual([]);
    expect(body.entity).toBeNull();
    expect(body.jobTitle).toBeNull();
  });

  test("a token for user A can NEVER return user B's resolution — sub is always the token's own caller, no id parameter exists", async () => {
    const roleA = await makeRole("caller-a");
    const roleB = await makeRole("caller-b");
    await db.permissionRule.create({
      data: { roleId: roleA.id, resource: "refund", action: "access" },
    });
    await db.permissionRule.create({
      data: { roleId: roleB.id, resource: "admin", action: "access" },
    });

    const userA = await mintTokenForNewUser("caller-a", { entity: "welld_it" });
    const userB = await mintTokenForNewUser("caller-b", { entity: "welld_ch" });
    await db.userRole.create({ data: { userId: userA.userId, roleId: roleA.id } });
    await db.userRole.create({ data: { userId: userB.userId, roleId: roleB.id } });

    const resA = await resolveRouter.request("/authz/resolve", {
      headers: { Authorization: `Bearer ${userA.token}` },
    });
    const resB = await resolveRouter.request("/authz/resolve", {
      headers: { Authorization: `Bearer ${userB.token}` },
    });

    const bodyA = (await resA.json()) as {
      sub: string;
      entity: string | null;
      permissions: Array<{ resource: string; action: string; conditions: unknown }>;
    };
    const bodyB = (await resB.json()) as {
      sub: string;
      entity: string | null;
      permissions: Array<{ resource: string; action: string; conditions: unknown }>;
    };

    expect(bodyA.sub).toBe(userA.userId);
    expect(bodyA.sub).not.toBe(userB.userId);
    expect(bodyA.entity).toBe("welld_it");
    expect(bodyA.permissions).toContainEqual({
      resource: "refund",
      action: "access",
      conditions: null,
    });
    expect(bodyA.permissions.some((p) => p.resource === "admin")).toBe(false);

    expect(bodyB.sub).toBe(userB.userId);
    expect(bodyB.sub).not.toBe(userA.userId);
    expect(bodyB.entity).toBe("welld_ch");
    expect(bodyB.permissions).toContainEqual({
      resource: "admin",
      action: "access",
      conditions: null,
    });
    expect(bodyB.permissions.some((p) => p.resource === "refund")).toBe(false);
  });

  test("401s (RFC 7807 Problem JSON) when there is no Authorization header", async () => {
    const res = await resolveRouter.request("/authz/resolve");

    expect(res.status).toBe(401);
    const body = (await res.json()) as {
      status: number;
      title: string;
      type: string;
      instance: string;
    };
    expect(body.status).toBe(401);
    expect(body.title).toBe("Unauthorized");
    expect(body.type).toBe("https://httpstatuses.com/401");
    expect(body.instance).toBe("/authz/resolve");
  });

  test("401s when the Authorization header is not a Bearer token", async () => {
    const res = await resolveRouter.request("/authz/resolve", {
      headers: { Authorization: "Basic dXNlcjpwYXNz" },
    });
    expect(res.status).toBe(401);
  });

  test("401s when the Bearer token is garbage / not a real JWT", async () => {
    const res = await resolveRouter.request("/authz/resolve", {
      headers: { Authorization: "Bearer not-a-real-jwt" },
    });
    expect(res.status).toBe(401);
  });

  test("401s when the token's signature does not verify (tampered payload segment)", async () => {
    const { token } = await mintTokenForNewUser("tampered");
    const parts = token.split(".");
    // Flip a byte in the payload segment (base64url) — signature no longer matches.
    const tamperedPayload =
      (parts[1] ?? "").slice(0, -1) + ((parts[1] ?? "").endsWith("A") ? "B" : "A");
    const tampered = `${parts[0]}.${tamperedPayload}.${parts[2]}`;

    const res = await resolveRouter.request("/authz/resolve", {
      headers: { Authorization: `Bearer ${tampered}` },
    });
    expect(res.status).toBe(401);
  });

  test("401s when the token carries the wrong audience (ADR-0010)", async () => {
    // Temporarily mint under a DIFFERENT AUTH_AUDIENCE than what this
    // process's resolveAuth.middleware will verify against — produces a
    // validly-signed token whose `aud` claim mismatches, exactly like
    // estimai-api's/notify-api's own (d3) wrong-audience test.
    const originalAudience = env.AUTH_AUDIENCE;
    (env as unknown as Record<string, unknown>)["AUTH_AUDIENCE"] = "some-other-audience";
    let token: string;
    try {
      const minted = await mintTokenForNewUser("wrong-aud");
      token = minted.token;
    } finally {
      (env as unknown as Record<string, unknown>)["AUTH_AUDIENCE"] = originalAudience;
    }

    const res = await resolveRouter.request("/authz/resolve", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
  });

  test("401s when the Bearer value is empty", async () => {
    const res = await resolveRouter.request("/authz/resolve", {
      headers: { Authorization: "Bearer " },
    });
    expect(res.status).toBe(401);
  });
});
