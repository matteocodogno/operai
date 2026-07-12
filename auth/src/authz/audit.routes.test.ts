/**
 * Integration tests for GET /admin/audit (T7, AC-5.2/AC-5.3).
 *
 * Strategy: mock `../auth/auth.config` (the `auth` object `sessionMiddleware`
 * reads via `auth.api.getSession`) so we can flip between "no session" and
 * "authenticated as <user>" without needing a real OAuth flow or the
 * dev/test-only session-mint endpoint — mirrors the mocking style already
 * used in `test-auth/test-auth.routes.test.ts`. The router itself, its
 * middleware chain, and the `listAuditLog` query all run for real against
 * the local Postgres (shared dev DB on localhost:5435).
 *
 * DB-ISOLATION: audit_log is a suite-wide, unscoped resource (no per-user
 * filter in the contract), so this file may see rows written concurrently by
 * other auth-service test files (this one's own `audit.test.ts`, and future
 * T8/T9/T10 admin-route tests). Every assertion below is written to hold
 * regardless of *unrelated* concurrent rows: pagination mechanics (page
 * sizes, no overlap between consecutive pages, global reverse-chronological
 * order) are checked structurally, and this file's *own* seeded rows are
 * identified by a per-run unique marker rather than by absolute position.
 */

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { db } from "../lib/db";

const RUN_ID = crypto.randomUUID().slice(0, 8);
const MARKER_PREFIX = `t7-route-audit-${RUN_ID}-`;
const SEED_COUNT = 12;

// ─── Mock the session source ───────────────────────────────────────────────
//
// `sessionMiddleware` (auth/src/auth/auth.middleware.ts) calls
// `auth.api.getSession({ headers })`. Replacing the whole `auth.config`
// module lets us control that result per-test without touching better-auth,
// cookies, or the DB-backed session/JWKS tables at all.

type FakeSession = {
  user: { id: string; email: string; name: string };
  session: { id: string };
} | null;

let currentSession: FakeSession = null;

mock.module("../auth/auth.config", () => ({
  auth: {
    api: {
      getSession: mock(async () => currentSession),
    },
  },
}));

// ─── Fixtures ─────────────────────────────────────────────────────────────────

let actorId: string;
const seededAuditIds: string[] = [];

beforeAll(async () => {
  const actor = await db.user.create({
    data: {
      email: `t7-route-actor-${RUN_ID}@operai.test`,
      name: "T7 Route Fixture Actor",
      emailVerified: true,
    },
  });
  actorId = actor.id;

  // Seed SEED_COUNT rows with strictly increasing createdAt, all in the
  // past, so that among themselves they have a deterministic, known order
  // (index SEED_COUNT-1 is the most recent of the group).
  const now = Date.now();
  for (let i = 0; i < SEED_COUNT; i++) {
    const row = await db.auditLog.create({
      data: {
        actorUserId: actorId,
        action: "role.create",
        targetType: "role",
        targetId: `t7-route-target-${RUN_ID}-${i}`,
        summary: `${MARKER_PREFIX}${i}`,
        createdAt: new Date(now - (SEED_COUNT - i) * 1000),
      },
    });
    seededAuditIds.push(row.id);
  }
});

afterAll(async () => {
  await db.auditLog.deleteMany({ where: { id: { in: seededAuditIds } } });
  await db.user.deleteMany({ where: { id: actorId } });
});

describe("GET /admin/audit (T7)", () => {
  test("401s (RFC 7807) when there is no session", async () => {
    currentSession = null;

    const { auditRouter } = await import("./audit.routes");
    const res = await auditRouter.request("/admin/audit");

    expect(res.status).toBe(401);
    const body = (await res.json()) as { status: number; title: string };
    expect(body.status).toBe(401);
    expect(body.title).toBe("Unauthorized");
  });

  test("400s (RFC 7807 Problem JSON) on an out-of-range page", async () => {
    currentSession = {
      user: { id: actorId, email: "actor@operai.test", name: "Actor" },
      session: { id: "sess_1" },
    };

    const { auditRouter } = await import("./audit.routes");
    const res = await auditRouter.request("/admin/audit?page=0");

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      status: number;
      title: string;
      type: string;
      detail: string;
      instance: string;
    };
    expect(body.status).toBe(400);
    expect(body.type).toBe("https://httpstatuses.com/400");
    expect(body.instance).toBe("/admin/audit");
    expect(typeof body.detail).toBe("string");
  });

  test("returns a page whose size matches pageSize and whose shape matches the contract", async () => {
    currentSession = {
      user: { id: actorId, email: "actor@operai.test", name: "Actor" },
      session: { id: "sess_1" },
    };

    const { auditRouter } = await import("./audit.routes");
    const res = await auditRouter.request("/admin/audit?page=1&pageSize=5");

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{
        id: string;
        actorUserId: string | null;
        actor: { id: string; name: string; email: string } | null;
        action: string;
        targetType: string;
        targetId: string | null;
        summary: string;
        data: unknown;
        createdAt: string;
      }>;
      page: number;
      pageSize: number;
      total: number;
      totalPages: number;
    };

    expect(body.page).toBe(1);
    expect(body.pageSize).toBe(5);
    expect(body.items.length).toBe(5);
    // We seeded SEED_COUNT rows ourselves; the table has at least that many.
    expect(body.total).toBeGreaterThanOrEqual(SEED_COUNT);
    expect(body.totalPages).toBe(Math.ceil(body.total / body.pageSize));

    // Shape check on the first item.
    const [first] = body.items;
    expect(first).toBeDefined();
    expect(typeof first?.id).toBe("string");
    expect(typeof first?.action).toBe("string");
    expect(typeof first?.summary).toBe("string");
    expect(typeof first?.createdAt).toBe("string");
  });

  test("consecutive pages do not overlap", async () => {
    currentSession = {
      user: { id: actorId, email: "actor@operai.test", name: "Actor" },
      session: { id: "sess_1" },
    };

    const { auditRouter } = await import("./audit.routes");

    const [resPage1, resPage2] = await Promise.all([
      auditRouter.request("/admin/audit?page=1&pageSize=3"),
      auditRouter.request("/admin/audit?page=2&pageSize=3"),
    ]);
    const page1 = (await resPage1.json()) as { items: Array<{ id: string }> };
    const page2 = (await resPage2.json()) as { items: Array<{ id: string }> };

    expect(page1.items.length).toBe(3);
    expect(page2.items.length).toBe(3);

    const idsPage1 = new Set(page1.items.map((item) => item.id));
    for (const item of page2.items) {
      expect(idsPage1.has(item.id)).toBe(false);
    }
  });

  test("is globally reverse-chronological (each item's createdAt >= the next item's)", async () => {
    currentSession = {
      user: { id: actorId, email: "actor@operai.test", name: "Actor" },
      session: { id: "sess_1" },
    };

    const { auditRouter } = await import("./audit.routes");
    const res = await auditRouter.request(
      `/admin/audit?page=1&pageSize=${Math.max(50, SEED_COUNT * 2)}`,
    );
    const body = (await res.json()) as {
      items: Array<{ createdAt: string }>;
    };

    for (let i = 0; i + 1 < body.items.length; i++) {
      const current = new Date(body.items[i]!.createdAt).getTime();
      const next = new Date(body.items[i + 1]!.createdAt).getTime();
      expect(current).toBeGreaterThanOrEqual(next);
    }
  });

  test("this run's own seeded rows are all present and internally ordered newest-first", async () => {
    currentSession = {
      user: { id: actorId, email: "actor@operai.test", name: "Actor" },
      session: { id: "sess_1" },
    };

    const { auditRouter } = await import("./audit.routes");

    // A page large enough to comfortably contain our SEED_COUNT rows even
    // amid reasonable concurrent writes from other test files.
    const res = await auditRouter.request("/admin/audit?page=1&pageSize=100");
    const body = (await res.json()) as {
      items: Array<{ summary: string; createdAt: string }>;
    };

    const mine = body.items.filter((item) =>
      item.summary.startsWith(MARKER_PREFIX),
    );
    expect(mine.length).toBe(SEED_COUNT);

    // Seeded with index i having createdAt further in the past for smaller i,
    // so index SEED_COUNT-1 is the most recent — reverse-chronological means
    // it must appear FIRST among our own rows.
    const indices = mine.map((item) =>
      Number(item.summary.slice(MARKER_PREFIX.length)),
    );
    const sortedDescending = [...indices].sort((a, b) => b - a);
    expect(indices).toEqual(sortedDescending);
    expect(indices[0]).toBe(SEED_COUNT - 1);
  });

  test("no mutate route exists — PATCH/PUT/DELETE all 404 (immutability, AC-5.3)", async () => {
    currentSession = {
      user: { id: actorId, email: "actor@operai.test", name: "Actor" },
      session: { id: "sess_1" },
    };

    const { auditRouter } = await import("./audit.routes");

    const patchRes = await auditRouter.request("/admin/audit", {
      method: "PATCH",
    });
    const putRes = await auditRouter.request("/admin/audit", {
      method: "PUT",
    });
    const deleteRes = await auditRouter.request(
      `/admin/audit/${seededAuditIds[0]}`,
      { method: "DELETE" },
    );

    // Hono routers 404 on unmatched method+path combinations by default
    // (there is no app-level notFound handler wired on this bare router, so
    // the shape is Hono's default 404 body — the important assertion is the
    // status: no handler exists that would let a caller mutate/delete a row).
    expect(patchRes.status).toBe(404);
    expect(putRes.status).toBe(404);
    expect(deleteRes.status).toBe(404);
  });
});
