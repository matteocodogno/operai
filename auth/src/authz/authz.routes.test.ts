/**
 * Integration tests for GET /authz/me (T6, specs/20260713-auth-roles-permissions
 * — AC-4.1, AC-3.3, AC-4.4).
 *
 * Strategy: mock `../auth/auth.config` (the `auth` object `sessionMiddleware`
 * reads via `auth.api.getSession`) so we can flip between "no session" and
 * "authenticated as <user>" without a real OAuth flow or the dev/test-only
 * session-mint endpoint — mirrors `authz/audit.routes.test.ts`. The router
 * itself, its middleware chain, the resolver (T2), and the Prisma queries all
 * run for real against the local Postgres (shared dev DB on localhost:5435).
 *
 * DB-ISOLATION: other spec-004 tasks may run `bun test` concurrently against
 * the SAME database. Every fixture row (user/role/department email/name) uses
 * a random per-run suffix so concurrent runs cannot collide on the
 * `role.name`/`department.name`/`user.email` unique constraints, and every id
 * this file creates is tracked and deleted in `afterAll` regardless of which
 * test created it, so a failure mid-file still cleans up. Assertions only
 * ever inspect THIS file's own fixture users' responses, never global counts,
 * so concurrent unrelated rows in the same tables cannot make this file flaky.
 */

import { afterAll, describe, expect, mock, test } from "bun:test";
import { db } from "../lib/db";
import type { Prisma } from "../lib/generated/prisma/client";

const RUN_ID = crypto.randomUUID().slice(0, 8);

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

// ─── DB fixture helpers ───────────────────────────────────────────────────

const createdUserIds = new Set<string>();
const createdRoleIds = new Set<string>();
const createdDepartmentIds = new Set<string>();

function unique(): string {
  return crypto.randomUUID();
}

async function makeUser(label: string, entity: string | null = null) {
  const user = await db.user.create({
    data: {
      name: `T6 fixture — ${label}`,
      email: `t6-authz-me-${label}-${RUN_ID}-${unique()}@authzme.test`,
      entity,
    },
  });
  createdUserIds.add(user.id);
  return user;
}

async function makeRole(label: string) {
  const role = await db.role.create({
    data: { name: `t6-authz-me-role-${label}-${RUN_ID}-${unique()}` },
  });
  createdRoleIds.add(role.id);
  return role;
}

async function makeDepartment(label: string) {
  const department = await db.department.create({
    data: { name: `t6-authz-me-dept-${label}-${RUN_ID}-${unique()}` },
  });
  createdDepartmentIds.add(department.id);
  return department;
}

async function addRule(
  roleId: string,
  resource: string,
  action: string,
  conditions?: Record<string, unknown>,
) {
  if (conditions === undefined) {
    await db.permissionRule.create({ data: { roleId, resource, action } });
    return;
  }
  await db.permissionRule.create({
    data: { roleId, resource, action, conditions: conditions as Prisma.InputJsonValue },
  });
}

async function assignUserRole(userId: string, roleId: string) {
  await db.userRole.create({ data: { userId, roleId } });
}

async function assignDepartmentRole(departmentId: string, roleId: string) {
  await db.departmentRole.create({ data: { departmentId, roleId } });
}

async function addUserToDepartment(userId: string, departmentId: string) {
  await db.userDepartment.create({ data: { userId, departmentId } });
}

function asSession(user: { id: string; email: string; name: string }): FakeSession {
  return { user, session: { id: `sess-${user.id}` } };
}

afterAll(async () => {
  // Deleting Role/Department cascades permission_rule/user_role/
  // department_role/user_department rows tied to them (schema.prisma
  // `onDelete: Cascade`); deleting User cascades any remaining user_role/
  // user_department rows. Order is irrelevant — each cascades independently.
  await db.role.deleteMany({ where: { id: { in: Array.from(createdRoleIds) } } });
  await db.department.deleteMany({
    where: { id: { in: Array.from(createdDepartmentIds) } },
  });
  await db.user.deleteMany({ where: { id: { in: Array.from(createdUserIds) } } });
});

// ─── Tests ────────────────────────────────────────────────────────────────

describe("GET /authz/me (T6)", () => {
  test("401s (RFC 7807 Problem JSON) when there is no session", async () => {
    currentSession = null;

    const { authzRouter } = await import("./authz.routes");
    const res = await authzRouter.request("/authz/me");

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
    expect(body.instance).toBe("/authz/me");
  });

  test("a user with grants gets enumerable permissions, correct apps, roles and departments (AC-4.1, AC-3.3)", async () => {
    const user = await makeUser("grants");
    const directRole = await makeRole("grants-direct");
    const deptRole = await makeRole("grants-dept");
    const department = await makeDepartment("grants");

    // Direct role: an app-access grant ("access" on the app-as-resource) plus
    // an ownership-conditioned data grant.
    await addRule(directRole.id, "estimai", "access");
    await addRule(directRole.id, "estimate", "view", { ownership: "own" });
    // Department-derived role: a second, DIFFERENT app-access grant plus a
    // second data grant — proves the union (AC-4.2) surfaces through here too.
    await addRule(deptRole.id, "admin", "access");
    await addRule(deptRole.id, "estimate", "delete", { ownership: "any" });

    await assignUserRole(user.id, directRole.id);
    await assignDepartmentRole(department.id, deptRole.id);
    await addUserToDepartment(user.id, department.id);

    currentSession = asSession({ id: user.id, email: user.email, name: user.name });

    const { authzRouter } = await import("./authz.routes");
    const res = await authzRouter.request("/authz/me");

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      epoch: number;
      apps: string[];
      roles: string[];
      departments: string[];
      permissions: Array<{
        resource: string;
        action: string;
        conditions: unknown;
      }>;
    };

    expect(body.epoch).toBe(0);

    // apps = resources granted the "access" action, from EITHER path.
    expect(new Set(body.apps)).toEqual(new Set(["estimai", "admin"]));

    // roles = the caller's DIRECTLY assigned role names only.
    expect(body.roles).toEqual([directRole.name]);

    // departments = the caller's department memberships.
    expect(body.departments).toEqual([department.name]);

    // permissions = the full enumerable (resource, action, conditions) set,
    // union of direct + department-derived, nothing lost.
    expect(body.permissions).toHaveLength(4);
    expect(body.permissions).toContainEqual({
      resource: "estimai",
      action: "access",
      conditions: null,
    });
    expect(body.permissions).toContainEqual({
      resource: "admin",
      action: "access",
      conditions: null,
    });
    expect(body.permissions).toContainEqual({
      resource: "estimate",
      action: "view",
      conditions: { ownership: "own" },
    });
    expect(body.permissions).toContainEqual({
      resource: "estimate",
      action: "delete",
      conditions: { ownership: "any" },
    });
  });

  test("a user with no grants gets empty permissions/apps/roles/departments — default-deny (AC-4.4)", async () => {
    const user = await makeUser("no-grants");

    currentSession = asSession({ id: user.id, email: user.email, name: user.name });

    const { authzRouter } = await import("./authz.routes");
    const res = await authzRouter.request("/authz/me");

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      epoch: number;
      apps: string[];
      roles: string[];
      departments: string[];
      permissions: unknown[];
    };

    expect(body.epoch).toBe(0);
    expect(body.apps).toEqual([]);
    expect(body.roles).toEqual([]);
    expect(body.departments).toEqual([]);
    expect(body.permissions).toEqual([]);
  });

  test("an ungranted (resource,action) pair never appears alongside a granted one on the same resource — default-deny is per-pair, not per-resource (AC-4.4)", async () => {
    const user = await makeUser("partial-deny");
    const role = await makeRole("partial-deny");

    // Only "view" is granted on "estimate" — "delete" must stay absent.
    await addRule(role.id, "estimate", "view");
    await assignUserRole(user.id, role.id);

    currentSession = asSession({ id: user.id, email: user.email, name: user.name });

    const { authzRouter } = await import("./authz.routes");
    const res = await authzRouter.request("/authz/me");

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      permissions: Array<{ resource: string; action: string; conditions: unknown }>;
      apps: string[];
    };

    expect(body.permissions).toEqual([
      { resource: "estimate", action: "view", conditions: null },
    ]);
    expect(
      body.permissions.find(
        (permission) => permission.resource === "estimate" && permission.action === "delete",
      ),
    ).toBeUndefined();
    // No "access" grant anywhere → no apps.
    expect(body.apps).toEqual([]);
  });

  test("epoch reflects the caller's current permissionEpoch", async () => {
    const user = await makeUser("epoch");

    await db.user.update({
      where: { id: user.id },
      data: { permissionEpoch: { increment: 3 } },
    });

    currentSession = asSession({ id: user.id, email: user.email, name: user.name });

    const { authzRouter } = await import("./authz.routes");
    const res = await authzRouter.request("/authz/me");

    expect(res.status).toBe(200);
    const body = (await res.json()) as { epoch: number };
    expect(body.epoch).toBe(3);
  });
});

// ─── The derived `admin` entry (T4, specs/20261117-legal-entities — AC-4.2, AC-4.3) ──

describe("GET /authz/me — `admin` derived from legal-entity:manage (T4)", () => {
  const ENTITY_CONDITION = { attributes: [{ key: "entity", match: "user" }] };

  async function appsOf(user: { id: string; email: string; name: string }): Promise<string[]> {
    currentSession = asSession(user);
    const { authzRouter } = await import("./authz.routes");
    const res = await authzRouter.request("/authz/me");
    expect(res.status).toBe(200);
    return ((await res.json()) as { apps: string[] }).apps;
  }

  async function withGrant(label: string, entity: string | null, conditions?: Record<string, unknown>) {
    const user = await makeUser(label, entity);
    const role = await makeRole(label);
    await addRule(role.id, "legal-entity", "manage", conditions);
    await assignUserRole(user.id, role.id);
    return user;
  }

  test("an unconditioned grant adds admin, with no admin:access and no user entity", async () => {
    const user = await withGrant("le-uncond", null);
    expect(await appsOf(user)).toEqual(["admin"]);
  });

  test("an entity-conditioned grant adds admin when the user has an entity", async () => {
    const user = await withGrant("le-cond", "welld_ch", ENTITY_CONDITION);
    expect(await appsOf(user)).toEqual(["admin"]);
  });

  test("an entity-conditioned grant with user entity null adds nothing", async () => {
    const user = await withGrant("le-cond-null", null, ENTITY_CONDITION);
    expect(await appsOf(user)).toEqual([]);
  });

  test("an entity-conditioned grant with an entity outside the registry's adds nothing", async () => {
    const user = await withGrant("le-cond-foreign", "CH", ENTITY_CONDITION);
    expect(await appsOf(user)).toEqual([]);
  });

  test("an unrecognised condition adds nothing (fail closed)", async () => {
    const user = await withGrant("le-unknown", "welld_ch", { ownership: "own" });
    expect(await appsOf(user)).toEqual([]);
  });

  test("admin appears once for an administrator who also holds the coverage", async () => {
    const user = await withGrant("le-both", null);
    const role = await makeRole("le-both-access");
    await addRule(role.id, "admin", "access");
    await assignUserRole(user.id, role.id);
    expect(await appsOf(user)).toEqual(["admin"]);
  });

  test("other apps are unchanged and admin is added after them", async () => {
    const user = await withGrant("le-others", null);
    const role = await makeRole("le-others-access");
    await addRule(role.id, "estimai", "access");
    await assignUserRole(user.id, role.id);
    expect(await appsOf(user)).toEqual(["estimai", "admin"]);
  });

  test("an administrator without the permission gets no change, and other grants do not derive admin", async () => {
    const admin = await makeUser("le-admin-only");
    const role = await makeRole("le-admin-only");
    await addRule(role.id, "admin", "access");
    await assignUserRole(admin.id, role.id);
    expect(await appsOf(admin)).toEqual(["admin"]);

    const other = await makeUser("le-other-perms", "welld_ch");
    const otherRole = await makeRole("le-other-perms");
    await addRule(otherRole.id, "legal-entity", "read");
    await addRule(otherRole.id, "letterhead", "manage");
    await assignUserRole(other.id, otherRole.id);
    expect(await appsOf(other)).toEqual([]);
  });

  test("a revoked grant removes admin on the next call", async () => {
    const user = await withGrant("le-revoke", null);
    expect(await appsOf(user)).toEqual(["admin"]);
    await db.userRole.deleteMany({ where: { userId: user.id } });
    expect(await appsOf(user)).toEqual([]);
  });
});
