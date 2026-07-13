/**
 * Integration tests for the permission catalog (T5, specs/004-auth-roles-
 * permissions — refs AC-3.1, AC-3.2) — `PUT /authz/catalog`,
 * `GET /admin/catalog`, and the `isKnownPermission`/`isConditionSupported`
 * validation helpers T8's roles API is expected to import.
 *
 * Strategy: mock `../auth/auth.config` (the `auth` object `sessionMiddleware`
 * reads via `auth.api.getSession`) so we can flip between "no session" and
 * "authenticated as <user>" without a real OAuth flow — mirrors
 * `authz/audit.routes.test.ts` / `authz/authz.routes.test.ts` in this same
 * directory (see those files' doc comments for why this mock is safe here
 * but must NOT be reused inside `src/auth/` test files). The router itself,
 * its middleware chain (incl. the real `requireAdmin` role-membership
 * query), and every `catalog.ts` Prisma call run for real against the local
 * Postgres (shared dev DB on localhost:5435). Each test app is mounted
 * locally in this file — `catalog.routes.ts` is NOT mounted on the shared
 * `src/index.ts` app by this task (left to the orchestrator, per this task's
 * scope).
 *
 * DB-ISOLATION: `catalog_resource` is keyed `@@unique([appId, key])`, not
 * per-user, so every fixture below uses a per-run-unique `appId`
 * (`t5-catalog-<RUN_ID>`) — this is the SAME isolation strategy the
 * "app declares its own catalog" design implies (a real app's `appId` is
 * stable and global), so a random per-run appId is the correct stand-in for
 * "an app nobody else has registered". The shared "admin" `Role` row is
 * `upsert`ed (never deleted), matching every other spec-004 test file's
 * convention (see `auth/src/auth/auth.middleware.test.ts`).
 */

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { db } from "../lib/db";

const RUN_ID = crypto.randomUUID().slice(0, 8);
const APP_ID = `t5-catalog-${RUN_ID}`;
// `isKnownPermission`/`isConditionSupported` (catalog.ts) look up
// (resource, action) GLOBALLY — no `appId` filter, by design (a
// `permission_rule` doesn't carry one; see catalog.ts's module doc). A
// literal `"estimate"` fixture key would therefore collide with EstimAI's
// own real, persistent `estimate` resource (T26, `catalogs/estimai.ts`),
// which declares different `supportedConditions` — so this fixture's
// resource key must be run-scoped like `APP_ID`, not the literal domain name.
const RESOURCE_KEY = `estimate-${RUN_ID}`;

// ─── Mock the session source ───────────────────────────────────────────────

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

/**
 * Idempotently ensures the single shared `Role` row named "admin" exists and
 * returns its id (see `auth/src/auth/auth.middleware.test.ts` for the full
 * rationale — `upsert` keyed on the unique `name` column so concurrent test
 * processes never collide on the unique constraint).
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

let adminUserId: string;
let nonAdminUserId: string;

beforeAll(async () => {
  const adminRoleId = await ensureAdminRole();

  const admin = await db.user.create({
    data: {
      email: `t5-catalog-admin-${RUN_ID}@operai.test`,
      name: "T5 Catalog Fixture Admin",
      emailVerified: true,
    },
  });
  adminUserId = admin.id;
  await db.userRole.create({ data: { userId: adminUserId, roleId: adminRoleId } });

  const nonAdmin = await db.user.create({
    data: {
      email: `t5-catalog-nonadmin-${RUN_ID}@operai.test`,
      name: "T5 Catalog Fixture Non-Admin",
      emailVerified: true,
    },
  });
  nonAdminUserId = nonAdmin.id;
});

afterAll(async () => {
  // Cascades to catalog_action for every resource under this run's appId.
  await db.catalogResource.deleteMany({ where: { appId: APP_ID } });
  // Cascades each user's user_role row; the shared "admin" Role row itself
  // is intentionally left in place (see ensureAdminRole doc comment).
  await db.user.deleteMany({ where: { id: { in: [adminUserId, nonAdminUserId] } } });
});

function asAdmin() {
  currentSession = {
    user: { id: adminUserId, email: "admin@operai.test", name: "Admin" },
    session: { id: "sess_admin" },
  };
}

function asNonAdmin() {
  currentSession = {
    user: { id: nonAdminUserId, email: "nonadmin@operai.test", name: "Non-Admin" },
    session: { id: "sess_nonadmin" },
  };
}

function noSession() {
  currentSession = null;
}

const initialCatalogBody = {
  appId: APP_ID,
  resources: [
    {
      key: RESOURCE_KEY,
      label: "Estimate",
      actions: [
        { key: "view", label: "View", supportedConditions: ["ownership"] },
        {
          key: "edit",
          label: "Edit",
          supportedConditions: ["ownership", "entity"],
        },
        { key: "delete", label: "Delete", supportedConditions: [] },
      ],
    },
    {
      key: APP_ID,
      label: "App access",
      actions: [{ key: "access", label: "Access", supportedConditions: [] }],
    },
  ],
};

describe("PUT /authz/catalog + GET /admin/catalog (T5)", () => {
  test("401s (RFC 7807) with no session", async () => {
    noSession();
    const { catalogRouter } = await import("./catalog.routes");

    const putRes = await catalogRouter.request("/authz/catalog", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(initialCatalogBody),
    });
    expect(putRes.status).toBe(401);

    const getRes = await catalogRouter.request("/admin/catalog");
    expect(getRes.status).toBe(401);
  });

  test("403s (RFC 7807) when the caller is authenticated but not an admin (AC-1.5)", async () => {
    asNonAdmin();
    const { catalogRouter } = await import("./catalog.routes");

    const putRes = await catalogRouter.request("/authz/catalog", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(initialCatalogBody),
    });
    expect(putRes.status).toBe(403);
    const putBody = (await putRes.json()) as { title: string };
    expect(putBody.title).toBe("Forbidden");

    const getRes = await catalogRouter.request("/admin/catalog");
    expect(getRes.status).toBe(403);
  });

  test("400s (RFC 7807) on a malformed PUT body", async () => {
    asAdmin();
    const { catalogRouter } = await import("./catalog.routes");

    const res = await catalogRouter.request("/authz/catalog", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resources: [] }), // missing required appId
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { type: string; status: number };
    expect(body.status).toBe(400);
    expect(body.type).toBe("https://httpstatuses.com/400");
  });

  test("registers a catalog, then GET /admin/catalog returns it (AC-3.1)", async () => {
    asAdmin();
    const { catalogRouter } = await import("./catalog.routes");

    const putRes = await catalogRouter.request("/authz/catalog", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(initialCatalogBody),
    });
    expect(putRes.status).toBe(200);
    const putBody = (await putRes.json()) as typeof initialCatalogBody;
    expect(putBody.appId).toBe(APP_ID);
    expect(putBody.resources.length).toBe(2);

    const getRes = await catalogRouter.request("/admin/catalog");
    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as {
      apps: { appId: string; resources: unknown[] }[];
    };

    const mine = getBody.apps.find((app) => app.appId === APP_ID);
    expect(mine).toBeDefined();
    expect(mine?.resources).toHaveLength(2);

    const estimate = (
      mine as { resources: { key: string; actions: unknown[] }[] }
    ).resources.find((resource) => resource.key === RESOURCE_KEY);
    expect(estimate).toBeDefined();
    expect(estimate?.actions).toHaveLength(3);
  });

  test("re-PUTting the identical catalog is idempotent (no duplicate rows, same shape)", async () => {
    asAdmin();
    const { catalogRouter } = await import("./catalog.routes");

    const res = await catalogRouter.request("/authz/catalog", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(initialCatalogBody),
    });
    expect(res.status).toBe(200);

    const resourceCount = await db.catalogResource.count({
      where: { appId: APP_ID },
    });
    expect(resourceCount).toBe(2);

    const actionCount = await db.catalogAction.count({
      where: { resource: { appId: APP_ID } },
    });
    expect(actionCount).toBe(4);
  });

  test("re-PUT with a shrunken catalog prunes removed resources/actions (full-replace semantics)", async () => {
    asAdmin();
    const { catalogRouter } = await import("./catalog.routes");

    const shrunkenBody = {
      appId: APP_ID,
      resources: [
        {
          key: RESOURCE_KEY,
          label: "Estimate",
          actions: [{ key: "view", label: "View", supportedConditions: ["ownership"] }],
        },
      ],
    };

    const res = await catalogRouter.request("/authz/catalog", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(shrunkenBody),
    });
    expect(res.status).toBe(200);

    // The app-access resource is gone entirely; RESOURCE_KEY kept only "view".
    const resources = await db.catalogResource.findMany({
      where: { appId: APP_ID },
      include: { actions: true },
    });
    expect(resources).toHaveLength(1);
    expect(resources[0]?.key).toBe(RESOURCE_KEY);
    expect(resources[0]?.actions.map((action) => action.key)).toEqual(["view"]);

    // Restore the full catalog so the remaining tests in this file (and the
    // validation-helper tests below) see the original registered shape.
    const restoreRes = await catalogRouter.request("/authz/catalog", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(initialCatalogBody),
    });
    expect(restoreRes.status).toBe(200);
  });
});

describe("isKnownPermission / isConditionSupported (T5 validation helpers, AC-3.2)", () => {
  test("isKnownPermission accepts an on-catalog (resource, action) pair", async () => {
    const { isKnownPermission } = await import("./catalog");

    expect(await isKnownPermission(RESOURCE_KEY, "view")).toBe(true);
    expect(await isKnownPermission(APP_ID, "access")).toBe(true);
  });

  test("isKnownPermission rejects an off-catalog (resource, action) pair", async () => {
    const { isKnownPermission } = await import("./catalog");

    // Known resource, action never declared for it.
    expect(await isKnownPermission(RESOURCE_KEY, "approve")).toBe(false);
    // Resource never declared by any app.
    expect(await isKnownPermission(`${APP_ID}-nope`, "view")).toBe(false);
  });

  test("isConditionSupported accepts a condition declared in the catalog", async () => {
    const { isConditionSupported } = await import("./catalog");

    expect(await isConditionSupported(RESOURCE_KEY, "view", "ownership")).toBe(true);
    expect(await isConditionSupported(RESOURCE_KEY, "edit", "entity")).toBe(true);
  });

  test("isConditionSupported rejects a condition not declared for that (resource, action)", async () => {
    const { isConditionSupported } = await import("./catalog");

    // "view" only declares "ownership", not "entity".
    expect(await isConditionSupported(RESOURCE_KEY, "view", "entity")).toBe(false);
    // "delete" declares no conditions at all.
    expect(await isConditionSupported(RESOURCE_KEY, "delete", "ownership")).toBe(false);
  });

  test("isConditionSupported is false (not throwing) for an unknown (resource, action)", async () => {
    const { isConditionSupported } = await import("./catalog");

    expect(await isConditionSupported("no-such-resource", "view", "ownership")).toBe(
      false,
    );
  });
});
