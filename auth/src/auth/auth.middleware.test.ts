/**
 * Integration tests for `requireAdmin` (spec 004, T4 — AC-1.5).
 *
 * Strategy: these tests exercise `requireAuth` + `requireAdmin` directly
 * against a minimal Hono app, injecting `user` into context with a tiny
 * fixture middleware instead of going through `sessionMiddleware` (which
 * would require mocking `./auth.config`'s `auth.api.getSession`). This is
 * deliberate: Bun's `mock.module` replaces a module for the ENTIRE test
 * process, not just the file that calls it (unlike Vitest's per-file mock
 * isolation) — an earlier version of this file mocked `./auth.config` the
 * same way `authz/audit.routes.test.ts` does, and because this file sorts
 * alphabetically BEFORE `jwt-claims.contract.test.ts` within `src/auth/`,
 * that mock silently replaced better-auth's real config for every later
 * file in the same `bun test` run — breaking `jwt-claims.contract.test.ts`,
 * which needs the real `auth.$context` internal adapter. Neither
 * `requireAuth` nor `requireAdmin` reads `auth.config` at all (only
 * `sessionMiddleware` does), so setting `user` directly is not a lesser
 * test — it exercises the exact same exported middleware functions with no
 * risk of cross-file module-mock pollution.
 *
 * The `requireAdmin` role-membership query itself runs for real against the
 * local Postgres (shared dev DB on localhost:5435) — that query is the
 * actual security boundary under test and must not be mocked.
 *
 * DB-ISOLATION: other spec-004 tasks (T5/T6/T8/T9/T10/T11) may run `bun
 * test` concurrently against the SAME database, and some of those tasks'
 * own fixtures (and the eventual T11 seed) also need a `Role` row named
 * "admin" — it is meant to be a single, shared, system-wide row once T11's
 * seed lands, not a per-test fixture. So this file `upsert`s (never
 * `create`s) the "admin" role by its unique `name`, and never deletes it in
 * cleanup; only the per-run `User`/`UserRole` fixture rows this file itself
 * creates are cleaned up (via cascade delete from `User`).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { User, Session } from "better-auth";
import { db } from "../lib/db";
import { requireAdmin, requireAuth } from "./auth.middleware";

const RUN_ID = crypto.randomUUID().slice(0, 8);

type AuthVariables = {
  user: User | null;
  session: Session | null;
};

// ─── Fixtures ─────────────────────────────────────────────────────────────────

let adminRoleId: string;
let nonAdminUserId: string;
let adminUserId: string;

/**
 * Idempotently ensures a single shared `Role` row named "admin" exists and
 * returns its id. Uses `upsert` (keyed on the unique `name` column) rather
 * than `create` so concurrent test processes (this file re-run, plus any
 * other spec-004 task's fixtures/seed that also need the real "admin" role)
 * never collide on the unique constraint; a transient P2002 from a genuine
 * create/create race is treated the same as "already exists" and resolved
 * by re-reading the row.
 */
async function ensureAdminRole(): Promise<string> {
  try {
    const role = await db.role.upsert({
      where: { name: "admin" },
      update: {},
      create: { name: "admin", isSystem: true },
    });
    return role.id;
  } catch {
    const existing = await db.role.findUnique({ where: { name: "admin" } });
    if (existing) return existing.id;
    throw new Error("Failed to ensure the shared 'admin' role exists");
  }
}

beforeAll(async () => {
  adminRoleId = await ensureAdminRole();

  const nonAdmin = await db.user.create({
    data: {
      email: `t4-requireadmin-nonadmin-${RUN_ID}@operai.test`,
      name: "T4 Fixture Non-Admin",
      emailVerified: true,
    },
  });
  nonAdminUserId = nonAdmin.id;

  const admin = await db.user.create({
    data: {
      email: `t4-requireadmin-admin-${RUN_ID}@operai.test`,
      name: "T4 Fixture Admin",
      emailVerified: true,
    },
  });
  adminUserId = admin.id;

  await db.userRole.create({
    data: { userId: adminUserId, roleId: adminRoleId },
  });
});

afterAll(async () => {
  // Cascades each user's `user_role` row (schema.prisma `onDelete: Cascade`
  // on User → UserRole); the shared "admin" Role row itself is
  // intentionally left in place — see `ensureAdminRole`'s doc comment.
  await db.user.deleteMany({
    where: { id: { in: [nonAdminUserId, adminUserId] } },
  });
});

// ─── Test app ─────────────────────────────────────────────────────────────────

/** Injects `c.set("user", user)` (+ a matching `session` when present). */
function fixtureUser(user: AuthVariables["user"]) {
  return async (c: { set: (k: keyof AuthVariables, v: unknown) => void }, next: () => Promise<void>) => {
    c.set("user", user);
    c.set("session", user ? ({ id: `sess_${RUN_ID}` } as Session) : null);
    await next();
  };
}

function buildApp(user: AuthVariables["user"]) {
  const app = new Hono<{ Variables: AuthVariables }>();

  app.get(
    "/admin-only",
    fixtureUser(user),
    requireAuth,
    requireAdmin,
    (c) => c.json({ ok: true }),
  );

  return app;
}

describe("requireAdmin (T4, AC-1.5)", () => {
  test("401s (RFC 7807) when there is no authenticated user — requireAuth runs first", async () => {
    const app = buildApp(null);
    const res = await app.request("/admin-only");

    expect(res.status).toBe(401);
    const body = (await res.json()) as { status: number; title: string };
    expect(body.status).toBe(401);
    expect(body.title).toBe("Unauthorized");
  });

  test("403s (RFC 7807) when the authenticated caller does not hold the admin role", async () => {
    const app = buildApp({ id: nonAdminUserId } as User);
    const res = await app.request("/admin-only");

    expect(res.status).toBe(403);
    const body = (await res.json()) as {
      type: string;
      title: string;
      status: number;
      detail: string;
      instance: string;
    };
    expect(body.status).toBe(403);
    expect(body.title).toBe("Forbidden");
    expect(body.type).toBe("https://httpstatuses.com/403");
    expect(body.instance).toBe("/admin-only");
    expect(typeof body.detail).toBe("string");
  });

  test("passes through to the handler when the caller holds the admin role", async () => {
    const app = buildApp({ id: adminUserId } as User);
    const res = await app.request("/admin-only");

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  test("a revoked admin role is denied on the next request (live check, no caching)", async () => {
    const app = buildApp({ id: adminUserId } as User);

    // Confirm the admin passes before revocation.
    const before = await app.request("/admin-only");
    expect(before.status).toBe(200);

    await db.userRole.delete({
      where: { userId_roleId: { userId: adminUserId, roleId: adminRoleId } },
    });

    const after = await app.request("/admin-only");
    expect(after.status).toBe(403);

    // Restore the fixture so this file's own afterAll cleanup and any
    // later test iteration still hold the expected admin assignment.
    await db.userRole.create({
      data: { userId: adminUserId, roleId: adminRoleId },
    });
  });
});
