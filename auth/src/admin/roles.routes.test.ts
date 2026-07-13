/**
 * Integration tests for the admin roles API (spec 004, T8 — refs AC-1.1,
 * AC-2.1–2.4, AC-3.2).
 *
 * Strategy: mock `../auth/auth.config` (the `auth` object `sessionMiddleware`
 * reads via `auth.api.getSession`) so we can flip between "no session",
 * "authenticated as a non-admin", and "authenticated as an admin" without a
 * real OAuth flow — mirrors `departments.routes.test.ts`/`users.routes.test.ts`
 * in this same directory. The router itself, its middleware chain (the real
 * `requireAdmin` role-membership query), and every Prisma write run for real
 * against the local Postgres (shared dev DB on localhost:5435). Run this file
 * in isolation (`bun test src/admin/roles.routes.test.ts`) — Bun's
 * `mock.module` replaces a module for the whole test PROCESS, not just this
 * file (see `auth/src/auth/auth.middleware.test.ts`'s doc comment for the
 * full rationale), so mixing this file into a repo-wide `bun test` run
 * alongside files that need the REAL `auth.config` would be order-dependent;
 * scoping the run to this file avoids that.
 *
 * DB-ISOLATION: every fixture row (role/catalog/user names+emails+appIds) is
 * suffixed with a per-run random id so concurrent `bun test` runs (this file
 * re-run, or other spec-004 task suites) never collide on a unique
 * constraint; every id created is tracked and removed in `afterAll`
 * regardless of which test created it. The single shared "admin" `Role` row
 * is `upsert`ed (never deleted) per the same convention used everywhere else
 * in this authz test suite. The catalog fixture uses a per-run-unique
 * `appId` (`t8-catalog-<RUN_ID>`), mirroring `catalog.routes.test.ts`'s
 * isolation strategy — `permission_rule.resource`/`.action` are plain
 * strings, not FKs, so `isKnownPermission`/`isConditionSupported` only care
 * that SOME catalog entry matches the (resource, action) pair, not which
 * app registered it.
 */

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { db } from "../lib/db";

const RUN_ID = crypto.randomUUID().slice(0, 8);
const APP_ID = `t8-catalog-${RUN_ID}`;
const KNOWN_RESOURCE = `t8-resource-${RUN_ID}`;

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

const createdUserIds = new Set<string>();
const createdRoleIds = new Set<string>();

let adminActorId: string;
let nonAdminUserId: string;

/**
 * Idempotently ensures the single shared `Role` row named "admin" exists
 * (see `auth.middleware.test.ts`/`departments.routes.test.ts` for the full
 * rationale — `upsert`ed by unique `name`, never deleted).
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

async function makeUser(label: string) {
  const user = await db.user.create({
    data: {
      name: `T8 fixture — ${label}`,
      email: `t8-roles-${label}-${RUN_ID}@operai.test`,
      emailVerified: true,
    },
  });
  createdUserIds.add(user.id);
  return user;
}

async function makeRole(label: string, opts: { isSystem?: boolean } = {}) {
  const role = await db.role.create({
    data: { name: `t8-role-${label}-${RUN_ID}`, isSystem: opts.isSystem ?? false },
  });
  createdRoleIds.add(role.id);
  return role;
}

function asAdmin() {
  currentSession = {
    user: { id: adminActorId, email: "admin@operai.test", name: "Admin" },
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

beforeAll(async () => {
  const adminRoleId = await ensureAdminRole();

  const actor = await makeUser("actor");
  adminActorId = actor.id;
  await db.userRole.create({ data: { userId: adminActorId, roleId: adminRoleId } });

  const nonAdmin = await makeUser("nonadmin");
  nonAdminUserId = nonAdmin.id;

  // Register a catalog so `isKnownPermission`/`isConditionSupported` (T5)
  // have something to validate T8's rules against. `view` supports
  // "ownership"; `edit` supports "ownership" + "entity"; `delete` supports
  // nothing.
  const resource = await db.catalogResource.create({
    data: { appId: APP_ID, key: KNOWN_RESOURCE, label: "T8 fixture resource" },
  });
  await db.catalogAction.createMany({
    data: [
      { resourceId: resource.id, key: "view", label: "View", supportedConditions: ["ownership"] },
      {
        resourceId: resource.id,
        key: "edit",
        label: "Edit",
        supportedConditions: ["ownership", "entity"],
      },
      { resourceId: resource.id, key: "delete", label: "Delete", supportedConditions: [] },
    ],
  });
});

afterAll(async () => {
  await db.catalogResource.deleteMany({ where: { appId: APP_ID } });
  await db.role.deleteMany({ where: { id: { in: Array.from(createdRoleIds) } } });
  await db.user.deleteMany({ where: { id: { in: Array.from(createdUserIds) } } });
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("Admin roles API (T8)", () => {
  test("401s (RFC 7807) with no session", async () => {
    noSession();
    const { rolesRouter } = await import("./roles.routes");

    const res = await rolesRouter.request("/admin/roles");

    expect(res.status).toBe(401);
    const body = (await res.json()) as { status: number; title: string };
    expect(body.status).toBe(401);
    expect(body.title).toBe("Unauthorized");
  });

  test("403s (RFC 7807) for an authenticated non-admin (T4, AC-1.5)", async () => {
    asNonAdmin();
    const { rolesRouter } = await import("./roles.routes");

    const res = await rolesRouter.request("/admin/roles");

    expect(res.status).toBe(403);
    const body = (await res.json()) as { status: number; title: string; type: string };
    expect(body.status).toBe(403);
    expect(body.title).toBe("Forbidden");
    expect(body.type).toBe("https://httpstatuses.com/403");
  });

  test("POST creates a role; duplicate name -> 409 (AC-1.1)", async () => {
    asAdmin();
    const { rolesRouter } = await import("./roles.routes");

    const name = `t8-role-create-${RUN_ID}`;
    const res = await rolesRouter.request("/admin/roles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, description: "Created by T8 tests" }),
    });

    expect(res.status).toBe(201);
    const created = (await res.json()) as {
      id: string;
      name: string;
      description: string | null;
      isSystem: boolean;
    };
    expect(created.name).toBe(name);
    expect(created.description).toBe("Created by T8 tests");
    expect(created.isSystem).toBe(false);
    createdRoleIds.add(created.id);

    const dupRes = await rolesRouter.request("/admin/roles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    expect(dupRes.status).toBe(409);
    const dupBody = (await dupRes.json()) as { status: number; type: string };
    expect(dupBody.status).toBe(409);
    expect(dupBody.type).toBe("https://httpstatuses.com/409");

    const auditRow = await db.auditLog.findFirst({
      where: { action: "role.create", targetId: created.id },
    });
    expect(auditRow).not.toBeNull();
    expect(auditRow?.actorUserId).toBe(adminActorId);
  });

  test("POST accepts description: null (empty-description role) -> 201, not 400", async () => {
    asAdmin();
    const { rolesRouter } = await import("./roles.routes");

    // The create-role modal sends `description: null` for an empty field; the
    // create schema must accept it (DB column is nullable) — regression for the
    // "Expected string, received null" 400.
    const res = await rolesRouter.request("/admin/roles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: `t8-role-nulldesc-${RUN_ID}`, description: null }),
    });

    expect(res.status).toBe(201);
    const created = (await res.json()) as { id: string; description: string | null };
    expect(created.description).toBeNull();
    createdRoleIds.add(created.id);
  });

  test("GET /admin/roles lists roles with rule counts and isSystem", async () => {
    asAdmin();
    const { rolesRouter } = await import("./roles.routes");

    const role = await makeRole("list");
    const rule = await db.permissionRule.create({
      data: { roleId: role.id, resource: KNOWN_RESOURCE, action: "view" },
    });

    const res = await rolesRouter.request("/admin/roles");
    expect(res.status).toBe(200);
    // Bare array (not an { items } envelope) — matches the admin-ui client's
    // listRoles(): Promise<Role[]> and the wire-shape convention.
    const body = (await res.json()) as Array<{ id: string; ruleCount: number; isSystem: boolean }>;
    expect(Array.isArray(body)).toBe(true);
    const item = body.find((r) => r.id === role.id);
    expect(item).toBeDefined();
    expect(item?.ruleCount).toBe(1);
    expect(item?.isSystem).toBe(false);

    await db.permissionRule.delete({ where: { id: rule.id } });
  });

  test("GET /:id 404s for an unknown id", async () => {
    asAdmin();
    const { rolesRouter } = await import("./roles.routes");

    const res = await rolesRouter.request("/admin/roles/does-not-exist");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { status: number };
    expect(body.status).toBe(404);
  });

  test("GET /:id returns the role and its rules", async () => {
    asAdmin();
    const { rolesRouter } = await import("./roles.routes");

    const role = await makeRole("detail");
    const rule = await db.permissionRule.create({
      data: {
        roleId: role.id,
        resource: KNOWN_RESOURCE,
        action: "view",
        conditions: { ownership: "own" },
      },
    });

    const res = await rolesRouter.request(`/admin/roles/${role.id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      rules: Array<{
        id: string;
        resource: string;
        action: string;
        conditions: { ownership?: string } | null;
      }>;
    };
    expect(body.id).toBe(role.id);
    expect(body.rules).toHaveLength(1);
    expect(body.rules[0]?.resource).toBe(KNOWN_RESOURCE);
    expect(body.rules[0]?.action).toBe("view");
    expect(body.rules[0]?.conditions).toEqual({ ownership: "own" });

    await db.permissionRule.delete({ where: { id: rule.id } });
  });

  test("PATCH renames a NON-system role and audits the change", async () => {
    asAdmin();
    const { rolesRouter } = await import("./roles.routes");

    const role = await makeRole("patch-nonsystem");

    const newName = `t8-role-patch-renamed-${RUN_ID}`;
    const res = await rolesRouter.request(`/admin/roles/${role.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newName, description: "Renamed" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string; description: string | null; isSystem: boolean };
    expect(body.name).toBe(newName);
    expect(body.description).toBe("Renamed");
    expect(body.isSystem).toBe(false);

    const auditRow = await db.auditLog.findFirst({
      where: { action: "role.update", targetId: role.id },
    });
    expect(auditRow).not.toBeNull();
  });

  test(
    "PATCH redescribes a system role (allowed) but rejects renaming it with 422 " +
      "(owasp/QE fix — renaming a system role, e.g. `admin`, would break " +
      "requireAdmin's literal-name gate and lock every admin out)",
    async () => {
      asAdmin();
      const { rolesRouter } = await import("./roles.routes");

      const systemRole = await makeRole("patch-system-redescribe", { isSystem: true });

      // Description-only edit is still allowed for system roles.
      const redescribeRes = await rolesRouter.request(`/admin/roles/${systemRole.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: "Redescribed" }),
      });
      expect(redescribeRes.status).toBe(200);
      const redescribed = (await redescribeRes.json()) as {
        name: string;
        description: string | null;
        isSystem: boolean;
      };
      expect(redescribed.name).toBe(systemRole.name);
      expect(redescribed.description).toBe("Redescribed");
      expect(redescribed.isSystem).toBe(true);

      // Renaming (even alongside a description change) is rejected.
      const renameRes = await rolesRouter.request(`/admin/roles/${systemRole.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: `t8-role-patch-system-renamed-${RUN_ID}`,
          description: "Attempted rename",
        }),
      });
      expect(renameRes.status).toBe(422);
      const renameBody = (await renameRes.json()) as { status: number; detail: string };
      expect(renameBody.status).toBe(422);
      expect(renameBody.detail).toContain(systemRole.name);

      // Unchanged in the DB.
      const stillThere = await db.role.findUnique({ where: { id: systemRole.id } });
      expect(stillThere?.name).toBe(systemRole.name);
      expect(stillThere?.description).toBe("Redescribed");

      // Sending the SAME name back (a no-op rename) is allowed, not rejected.
      const sameNameRes = await rolesRouter.request(`/admin/roles/${systemRole.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: systemRole.name, description: "Still same name" }),
      });
      expect(sameNameRes.status).toBe(200);
    },
  );

  test(
    "requireAdmin still authenticates /admin/* after a system role's rename attempt " +
      "was rejected (no lockout — the gate uses the shared ADMIN_ROLE_NAME constant)",
    async () => {
      asAdmin();
      const { rolesRouter } = await import("./roles.routes");

      const adminRole = await db.role.findUniqueOrThrow({ where: { name: "admin" } });

      const blockedRename = await rolesRouter.request(`/admin/roles/${adminRole.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: `admin-renamed-${RUN_ID}` }),
      });
      expect(blockedRename.status).toBe(422);

      // The admin actor's session still passes requireAdmin — the "admin"
      // role name was never actually changed.
      const stillAdmin = await rolesRouter.request("/admin/roles");
      expect(stillAdmin.status).toBe(200);
    },
  );

  test("DELETE of a system role -> 422 (AC-1.1)", async () => {
    asAdmin();
    const { rolesRouter } = await import("./roles.routes");

    const systemRole = await makeRole("delete-system", { isSystem: true });

    const res = await rolesRouter.request(`/admin/roles/${systemRole.id}`, {
      method: "DELETE",
    });

    expect(res.status).toBe(422);
    const body = (await res.json()) as { status: number };
    expect(body.status).toBe(422);

    // Still there.
    const stillThere = await db.role.findUnique({ where: { id: systemRole.id } });
    expect(stillThere).not.toBeNull();
  });

  test("DELETE of a custom role succeeds; subsequent GET 404s and audits the change", async () => {
    asAdmin();
    const { rolesRouter } = await import("./roles.routes");

    const role = await db.role.create({ data: { name: `t8-role-delete-${RUN_ID}` } });

    const delRes = await rolesRouter.request(`/admin/roles/${role.id}`, { method: "DELETE" });
    expect(delRes.status).toBe(204);

    const getRes = await rolesRouter.request(`/admin/roles/${role.id}`);
    expect(getRes.status).toBe(404);

    const auditRow = await db.auditLog.findFirst({
      where: { action: "role.delete", targetId: role.id },
    });
    expect(auditRow).not.toBeNull();
  });

  test("PUT /:id/rules 422s on an off-catalog (resource, action) pair (AC-2.1/AC-3.2)", async () => {
    asAdmin();
    const { rolesRouter } = await import("./roles.routes");

    const role = await makeRole("offcatalog");

    const res = await rolesRouter.request(`/admin/roles/${role.id}/rules`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        rules: [{ resource: "no-such-resource", action: "view" }],
      }),
    });

    expect(res.status).toBe(422);
    const body = (await res.json()) as { status: number; detail: string };
    expect(body.status).toBe(422);
    expect(body.detail).toContain("no-such-resource");

    // No rule was persisted.
    const rules = await db.permissionRule.findMany({ where: { roleId: role.id } });
    expect(rules).toHaveLength(0);
  });

  test("PUT /:id/rules 422s on a condition not declared as supported (AC-2.3/AC-3.2)", async () => {
    asAdmin();
    const { rolesRouter } = await import("./roles.routes");

    const role = await makeRole("badcondition");

    // "delete" declares zero supportedConditions -> "ownership" is rejected.
    const res = await rolesRouter.request(`/admin/roles/${role.id}/rules`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        rules: [
          {
            resource: KNOWN_RESOURCE,
            action: "delete",
            conditions: { ownership: "own" },
          },
        ],
      }),
    });

    expect(res.status).toBe(422);
    const body = (await res.json()) as { status: number; detail: string };
    expect(body.status).toBe(422);
    expect(body.detail).toContain("ownership");

    const rules = await db.permissionRule.findMany({ where: { roleId: role.id } });
    expect(rules).toHaveLength(0);
  });

  test(
    "PUT /:id/rules persists a conditioned rule, full-replaces the set, audits " +
      "the change, and bumps permissionEpoch for every current holder (direct + " +
      "department-derived) — AC-2.2/2.3/4.3",
    async () => {
      asAdmin();
      const { rolesRouter } = await import("./roles.routes");

      const role = await makeRole("rules-set");

      // One direct holder, one department-derived holder.
      const directHolder = await makeUser("rules-direct-holder");
      await db.userRole.create({ data: { userId: directHolder.id, roleId: role.id } });

      const department = await db.department.create({
        data: { name: `t8-role-rules-dept-${RUN_ID}` },
      });
      await db.departmentRole.create({ data: { departmentId: department.id, roleId: role.id } });
      const deptHolder = await makeUser("rules-dept-holder");
      await db.userDepartment.create({ data: { userId: deptHolder.id, departmentId: department.id } });

      const epochBefore = {
        direct: (
          await db.user.findUniqueOrThrow({
            where: { id: directHolder.id },
            select: { permissionEpoch: true },
          })
        ).permissionEpoch,
        dept: (
          await db.user.findUniqueOrThrow({
            where: { id: deptHolder.id },
            select: { permissionEpoch: true },
          })
        ).permissionEpoch,
      };

      // First write: an unconditional "view" + a conditioned "edit".
      const firstRes = await rolesRouter.request(`/admin/roles/${role.id}/rules`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rules: [
            { resource: KNOWN_RESOURCE, action: "view" },
            {
              resource: KNOWN_RESOURCE,
              action: "edit",
              conditions: {
                ownership: "own",
                attributes: [{ key: "entity", match: "user" }],
              },
            },
          ],
        }),
      });
      expect(firstRes.status).toBe(200);
      const firstBody = (await firstRes.json()) as {
        rules: Array<{ resource: string; action: string; conditions: unknown }>;
      };
      expect(firstBody.rules).toHaveLength(2);
      const editRule = firstBody.rules.find((r) => r.action === "edit");
      expect(editRule?.conditions).toEqual({
        ownership: "own",
        attributes: [{ key: "entity", match: "user" }],
      });

      const auditRow = await db.auditLog.findFirst({
        where: { action: "permission_rule.set", targetId: role.id },
        orderBy: { createdAt: "desc" },
      });
      expect(auditRow).not.toBeNull();

      const epochAfterFirst = {
        direct: (
          await db.user.findUniqueOrThrow({
            where: { id: directHolder.id },
            select: { permissionEpoch: true },
          })
        ).permissionEpoch,
        dept: (
          await db.user.findUniqueOrThrow({
            where: { id: deptHolder.id },
            select: { permissionEpoch: true },
          })
        ).permissionEpoch,
      };
      expect(epochAfterFirst.direct).toBeGreaterThan(epochBefore.direct);
      expect(epochAfterFirst.dept).toBeGreaterThan(epochBefore.dept);

      // Second write: full-replace with just "delete" -> "view"/"edit" gone.
      const secondRes = await rolesRouter.request(`/admin/roles/${role.id}/rules`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rules: [{ resource: KNOWN_RESOURCE, action: "delete" }],
        }),
      });
      expect(secondRes.status).toBe(200);
      const secondBody = (await secondRes.json()) as {
        rules: Array<{ resource: string; action: string }>;
      };
      expect(secondBody.rules).toHaveLength(1);
      expect(secondBody.rules[0]?.action).toBe("delete");

      // Cleanup this test's extra fixtures (role/rules are removed in afterAll
      // via createdRoleIds; department + its rows need explicit cleanup since
      // it isn't tracked there).
      await db.department.delete({ where: { id: department.id } });
    },
  );

  test("custom role assignable: creating a role, setting its rules, and assigning it to a user makes the resolver reflect it (AC-2.4)", async () => {
    asAdmin();
    const { rolesRouter } = await import("./roles.routes");
    const { resolveEffectivePermissions } = await import("../authz/resolver");
    const { Effect } = await import("effect");

    const role = await makeRole("assignable");
    const rulesRes = await rolesRouter.request(`/admin/roles/${role.id}/rules`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        rules: [{ resource: KNOWN_RESOURCE, action: "view" }],
      }),
    });
    expect(rulesRes.status).toBe(200);

    const user = await makeUser("assignable-target");

    const before = await Effect.runPromise(resolveEffectivePermissions(user.id));
    expect(before.some((p) => p.resource === KNOWN_RESOURCE && p.action === "view")).toBe(false);

    await db.userRole.create({ data: { userId: user.id, roleId: role.id } });

    const after = await Effect.runPromise(resolveEffectivePermissions(user.id));
    expect(after.some((p) => p.resource === KNOWN_RESOURCE && p.action === "view")).toBe(true);
  });
});
