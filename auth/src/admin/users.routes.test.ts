/**
 * Integration tests for the admin Users API (T10, specs/004 — refs AC-1.3,
 * AC-1.4, AC-2.3, AC-6.4).
 *
 * Strategy: mock `../auth/auth.config` (the `auth` object `sessionMiddleware`
 * reads via `auth.api.getSession`) exactly like `authz/audit.routes.test.ts`
 * and `authz/authz.routes.test.ts` do, so we can flip between "no session"
 * and "authenticated as <user>" without a real OAuth flow. The router
 * itself, its middleware chain (incl. the real `requireAdmin` role-membership
 * query), the last-admin guard, and every Prisma query run for real against
 * the local Postgres (shared dev DB on localhost:5435).
 *
 * DB-ISOLATION: every fixture row (user/role/department name/email) uses a
 * random per-run suffix so concurrent `bun test` runs (other spec-004 tasks
 * against the same DB) cannot collide on unique constraints. The shared
 * "admin" `Role` row is `upsert`ed (never deleted) — see
 * `auth/src/auth/auth.middleware.test.ts`'s `ensureAdminRole` doc comment
 * for the rationale. GET /admin/users' pagination/search assertions only
 * ever inspect THIS file's own fixture users (matched by a unique marker in
 * the name), never global counts, so unrelated concurrent rows cannot make
 * this file flaky.
 */

import { afterAll, describe, expect, mock, test } from "bun:test";
import { db } from "../lib/db";

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

function actAs(userId: string, email: string) {
  currentSession = {
    user: { id: userId, email, name: email },
    session: { id: `sess_${RUN_ID}` },
  };
}

function actAsAnonymous() {
  currentSession = null;
}

// ─── Fixture helpers ──────────────────────────────────────────────────────────

const createdUserIds = new Set<string>();
const createdRoleIds = new Set<string>();
const createdDepartmentIds = new Set<string>();

function unique(): string {
  return crypto.randomUUID().slice(0, 8);
}

async function makeUser(label: string) {
  const user = await db.user.create({
    data: {
      name: `T10 fixture ${label} ${RUN_ID}`,
      email: `t10-users-${label}-${RUN_ID}-${unique()}@operai.test`,
      emailVerified: true,
    },
  });
  createdUserIds.add(user.id);
  return user;
}

async function makeRole(label: string, isSystem = false) {
  const role = await db.role.create({
    data: { name: `t10-users-role-${label}-${RUN_ID}-${unique()}`, isSystem },
  });
  createdRoleIds.add(role.id);
  return role;
}

async function makeDepartment(label: string) {
  const department = await db.department.create({
    data: { name: `t10-users-dept-${label}-${RUN_ID}-${unique()}` },
  });
  createdDepartmentIds.add(department.id);
  return department;
}

/**
 * Idempotently ensures the single shared `Role` row named "admin" exists and
 * returns its id (mirrors `auth.middleware.test.ts` / `audit.routes.test.ts`).
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

async function assignRole(userId: string, roleId: string) {
  await db.userRole.create({ data: { userId, roleId } });
}

async function assignDepartment(userId: string, departmentId: string) {
  await db.userDepartment.create({ data: { userId, departmentId } });
}

afterAll(async () => {
  // Order matters for FK integrity even though cascade would handle most of
  // this; explicit deletes keep the cleanup readable and independent of
  // cascade direction changes.
  await db.userRole.deleteMany({ where: { userId: { in: [...createdUserIds] } } });
  await db.userDepartment.deleteMany({ where: { userId: { in: [...createdUserIds] } } });
  await db.departmentRole.deleteMany({
    where: { departmentId: { in: [...createdDepartmentIds] } },
  });
  await db.auditLog.deleteMany({ where: { targetId: { in: [...createdUserIds] } } });
  await db.user.deleteMany({ where: { id: { in: [...createdUserIds] } } });
  await db.role.deleteMany({ where: { id: { in: [...createdRoleIds] } } });
  await db.department.deleteMany({ where: { id: { in: [...createdDepartmentIds] } } });
  // The shared "admin" Role row is intentionally left in place.
});

describe("Admin Users API (T10)", () => {
  test("401s (RFC 7807) when there is no session", async () => {
    actAsAnonymous();
    const { usersRouter } = await import("./users.routes");

    const res = await usersRouter.request("/admin/users");

    expect(res.status).toBe(401);
    const body = (await res.json()) as { status: number; title: string };
    expect(body.status).toBe(401);
    expect(body.title).toBe("Unauthorized");
  });

  test("403s (RFC 7807) when the authenticated caller is not an admin", async () => {
    const nonAdmin = await makeUser("nonadmin-guard");
    actAs(nonAdmin.id, nonAdmin.email);
    const { usersRouter } = await import("./users.routes");

    const res = await usersRouter.request("/admin/users");

    expect(res.status).toBe(403);
    const body = (await res.json()) as { status: number; title: string; type: string };
    expect(body.status).toBe(403);
    expect(body.title).toBe("Forbidden");
    expect(body.type).toBe("https://httpstatuses.com/403");
  });

  describe("GET /admin/users", () => {
    test("paginates and searches by name/email (?q=)", async () => {
      const adminRoleId = await ensureAdminRole();
      const admin = await makeUser("list-actor");
      await assignRole(admin.id, adminRoleId);

      const marker = `zzsearchmarker${unique()}`;
      const target = await db.user.create({
        data: {
          name: `T10 fixture ${marker} ${RUN_ID}`,
          email: `t10-users-${marker}-${RUN_ID}@operai.test`,
          emailVerified: true,
        },
      });
      createdUserIds.add(target.id);

      actAs(admin.id, admin.email);
      const { usersRouter } = await import("./users.routes");

      const res = await usersRouter.request(`/admin/users?q=${marker}&page=1&pageSize=10`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        items: Array<{ id: string; name: string; email: string; roles: string[]; departments: string[] }>;
        page: number;
        pageSize: number;
        total: number;
      };

      expect(body.page).toBe(1);
      expect(body.pageSize).toBe(10);
      expect(body.total).toBe(1);
      expect(body.items.length).toBe(1);
      expect(body.items[0]?.id).toBe(target.id);
      expect(body.items[0]?.email).toBe(target.email);
    });

    test("400s (RFC 7807) on an out-of-range page", async () => {
      const adminRoleId = await ensureAdminRole();
      const admin = await makeUser("list-badpage");
      await assignRole(admin.id, adminRoleId);
      actAs(admin.id, admin.email);
      const { usersRouter } = await import("./users.routes");

      const res = await usersRouter.request("/admin/users?page=0");
      expect(res.status).toBe(400);
      const body = (await res.json()) as { status: number; type: string };
      expect(body.status).toBe(400);
      expect(body.type).toBe("https://httpstatuses.com/400");
    });
  });

  describe("GET /admin/users/:id", () => {
    test("404s (RFC 7807) for an unknown id", async () => {
      const adminRoleId = await ensureAdminRole();
      const admin = await makeUser("get-actor-404");
      await assignRole(admin.id, adminRoleId);
      actAs(admin.id, admin.email);
      const { usersRouter } = await import("./users.routes");

      const res = await usersRouter.request("/admin/users/does-not-exist");
      expect(res.status).toBe(404);
      const body = (await res.json()) as { status: number; title: string };
      expect(body.status).toBe(404);
      expect(body.title).toBe("Not Found");
    });

    test("returns the user with roles/departments/attributes", async () => {
      const adminRoleId = await ensureAdminRole();
      const admin = await makeUser("get-actor");
      await assignRole(admin.id, adminRoleId);

      const role = await makeRole("detail");
      const department = await makeDepartment("detail");
      const target = await makeUser("detail-target");
      await assignRole(target.id, role.id);
      await assignDepartment(target.id, department.id);
      await db.user.update({
        where: { id: target.id },
        data: { entity: "welld_ch", jobTitle: "Engineer" },
      });

      actAs(admin.id, admin.email);
      const { usersRouter } = await import("./users.routes");

      const res = await usersRouter.request(`/admin/users/${target.id}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        id: string;
        entity: string | null;
        jobTitle: string | null;
        roles: Array<{ id: string; name: string }>;
        departments: Array<{ id: string; name: string }>;
      };

      expect(body.id).toBe(target.id);
      expect(body.entity).toBe("welld_ch");
      expect(body.jobTitle).toBe("Engineer");
      expect(body.roles.map((r) => r.id)).toContain(role.id);
      expect(body.departments.map((d) => d.id)).toContain(department.id);
    });
  });

  describe("PATCH /admin/users/:id", () => {
    test("400s on an invalid entity enum value", async () => {
      const adminRoleId = await ensureAdminRole();
      const admin = await makeUser("patch-actor-bad");
      await assignRole(admin.id, adminRoleId);
      const target = await makeUser("patch-target-bad");

      actAs(admin.id, admin.email);
      const { usersRouter } = await import("./users.routes");

      const res = await usersRouter.request(`/admin/users/${target.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entity: "not-a-real-entity" }),
      });

      expect(res.status).toBe(400);
    });

    test("404s for an unknown id", async () => {
      const adminRoleId = await ensureAdminRole();
      const admin = await makeUser("patch-actor-404");
      await assignRole(admin.id, adminRoleId);
      actAs(admin.id, admin.email);
      const { usersRouter } = await import("./users.routes");

      const res = await usersRouter.request("/admin/users/does-not-exist", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobTitle: "Consultant" }),
      });

      expect(res.status).toBe(404);
    });

    test("sets entity/jobTitle and audits the change", async () => {
      const adminRoleId = await ensureAdminRole();
      const admin = await makeUser("patch-actor");
      await assignRole(admin.id, adminRoleId);
      const target = await makeUser("patch-target");

      actAs(admin.id, admin.email);
      const { usersRouter } = await import("./users.routes");

      const beforeEpoch = (
        await db.user.findUniqueOrThrow({ where: { id: target.id }, select: { permissionEpoch: true } })
      ).permissionEpoch;

      const res = await usersRouter.request(`/admin/users/${target.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entity: "welld_it", jobTitle: "Backend Developer" }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { entity: string | null; jobTitle: string | null; permissionEpoch: number };
      expect(body.entity).toBe("welld_it");
      expect(body.jobTitle).toBe("Backend Developer");
      expect(body.permissionEpoch).toBe(beforeEpoch + 1);

      const auditRow = await db.auditLog.findFirst({
        where: { targetType: "user", targetId: target.id, action: "user.update_attributes" },
        orderBy: { createdAt: "desc" },
      });
      expect(auditRow).not.toBeNull();
      expect(auditRow?.actorUserId).toBe(admin.id);
    });
  });

  describe("PUT /admin/users/:id/roles", () => {
    test("422s on an unknown roleId", async () => {
      const adminRoleId = await ensureAdminRole();
      const admin = await makeUser("roles-actor-unknown");
      await assignRole(admin.id, adminRoleId);
      const target = await makeUser("roles-target-unknown");

      actAs(admin.id, admin.email);
      const { usersRouter } = await import("./users.routes");

      const res = await usersRouter.request(`/admin/users/${target.id}/roles`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roleIds: ["not-a-real-role-id"] }),
      });

      expect(res.status).toBe(422);
      const body = (await res.json()) as { status: number };
      expect(body.status).toBe(422);
    });

    test("assign then revoke is reflected in GET .../permissions (matches the resolver)", async () => {
      const adminRoleId = await ensureAdminRole();
      const admin = await makeUser("roles-actor");
      await assignRole(admin.id, adminRoleId);

      const role = await db.role.create({
        data: {
          name: `t10-users-role-perm-${RUN_ID}-${unique()}`,
        },
      });
      createdRoleIds.add(role.id);
      await db.permissionRule.create({
        data: { roleId: role.id, resource: "widget", action: "view" },
      });

      const target = await makeUser("roles-target");

      actAs(admin.id, admin.email);
      const { usersRouter } = await import("./users.routes");

      const assignRes = await usersRouter.request(`/admin/users/${target.id}/roles`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roleIds: [role.id] }),
      });
      expect(assignRes.status).toBe(200);

      const permsAfterAssign = await usersRouter.request(`/admin/users/${target.id}/permissions`);
      expect(permsAfterAssign.status).toBe(200);
      const assignBody = (await permsAfterAssign.json()) as {
        permissions: Array<{ resource: string; action: string }>;
        roles: string[];
      };
      expect(assignBody.roles).toContain(role.name);
      expect(
        assignBody.permissions.some((p) => p.resource === "widget" && p.action === "view"),
      ).toBe(true);

      const revokeRes = await usersRouter.request(`/admin/users/${target.id}/roles`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roleIds: [] }),
      });
      expect(revokeRes.status).toBe(200);

      const permsAfterRevoke = await usersRouter.request(`/admin/users/${target.id}/permissions`);
      const revokeBody = (await permsAfterRevoke.json()) as {
        permissions: Array<{ resource: string; action: string }>;
        roles: string[];
      };
      expect(revokeBody.roles).not.toContain(role.name);
      expect(
        revokeBody.permissions.some((p) => p.resource === "widget" && p.action === "view"),
      ).toBe(false);
    });

    test("422s (last-admin guard) when removing the sole direct admin's admin role", async () => {
      const adminRoleId = await ensureAdminRole();
      const soleAdmin = await makeUser("lastadmin-direct");
      await assignRole(soleAdmin.id, adminRoleId);

      // This file's EARLIER tests each grant the shared "admin" role to
      // their own fixture actor and never revoke it (their own assertions
      // don't need to), so by this point in the file several unrelated
      // fixtures still hold admin — which would otherwise make `soleAdmin`
      // NOT the last one and silently turn this into a false negative
      // (200 instead of 422). Snapshot every OTHER current direct-admin
      // holder, revoke them for the duration of this test, then restore —
      // isolating this assertion from same-file test order without
      // touching genuinely external/concurrent admins beyond this brief
      // window (mirrors the revoke-then-restore technique already used in
      // `auth.middleware.test.ts`'s "a revoked admin role is denied" test,
      // applied here to every other holder instead of a single fixture).
      const otherHolders = await db.userRole.findMany({
        where: { roleId: adminRoleId, userId: { not: soleAdmin.id } },
        select: { userId: true },
      });
      const otherHolderIds = otherHolders.map((row) => row.userId);
      if (otherHolderIds.length > 0) {
        await db.userRole.deleteMany({
          where: { roleId: adminRoleId, userId: { in: otherHolderIds } },
        });
      }

      try {
        // Use soleAdmin itself as the authenticated actor — requireAdmin
        // only checks role membership, not identity, and self-service
        // demotion is exactly the scenario this guard exists to block.
        actAs(soleAdmin.id, soleAdmin.email);
        const { usersRouter } = await import("./users.routes");

        const res = await usersRouter.request(`/admin/users/${soleAdmin.id}/roles`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ roleIds: [] }),
        });

        expect(res.status).toBe(422);
        const body = (await res.json()) as { status: number; type: string };
        expect(body.status).toBe(422);
        expect(body.type).toBe("https://httpstatuses.com/422");

        // Confirm the role assignment was NOT changed (transaction rolled back).
        const stillAdmin = await db.userRole.findUnique({
          where: { userId_roleId: { userId: soleAdmin.id, roleId: adminRoleId } },
        });
        expect(stillAdmin).not.toBeNull();
      } finally {
        if (otherHolderIds.length > 0) {
          await db.userRole.createMany({
            data: otherHolderIds.map((userId) => ({ userId, roleId: adminRoleId })),
          });
        }
      }
    });

    test("succeeds when another admin remains", async () => {
      const adminRoleId = await ensureAdminRole();
      const admin1 = await makeUser("twoadmins-1");
      const admin2 = await makeUser("twoadmins-2");
      await assignRole(admin1.id, adminRoleId);
      await assignRole(admin2.id, adminRoleId);

      actAs(admin1.id, admin1.email);
      const { usersRouter } = await import("./users.routes");

      const res = await usersRouter.request(`/admin/users/${admin1.id}/roles`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roleIds: [] }),
      });

      expect(res.status).toBe(200);

      const admin1Row = await db.userRole.findUnique({
        where: { userId_roleId: { userId: admin1.id, roleId: adminRoleId } },
      });
      expect(admin1Row).toBeNull();

      // Restore for cleanliness (not strictly required since afterAll deletes users).
      await assignRole(admin1.id, adminRoleId);
    });
  });

  describe("PUT /admin/users/:id/departments", () => {
    test("422s on an unknown departmentId", async () => {
      const adminRoleId = await ensureAdminRole();
      const admin = await makeUser("depts-actor-unknown");
      await assignRole(admin.id, adminRoleId);
      const target = await makeUser("depts-target-unknown");

      actAs(admin.id, admin.email);
      const { usersRouter } = await import("./users.routes");

      const res = await usersRouter.request(`/admin/users/${target.id}/departments`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ departmentIds: ["not-a-real-department-id"] }),
      });

      expect(res.status).toBe(422);
    });

    test("assign then revoke is reflected (member inherits department roles)", async () => {
      const adminRoleId = await ensureAdminRole();
      const admin = await makeUser("depts-actor");
      await assignRole(admin.id, adminRoleId);

      const role = await db.role.create({
        data: { name: `t10-users-deptrole-${RUN_ID}-${unique()}` },
      });
      createdRoleIds.add(role.id);
      await db.permissionRule.create({
        data: { roleId: role.id, resource: "gadget", action: "edit" },
      });
      const department = await makeDepartment("perm");
      await db.departmentRole.create({ data: { departmentId: department.id, roleId: role.id } });

      const target = await makeUser("depts-target");
      actAs(admin.id, admin.email);
      const { usersRouter } = await import("./users.routes");

      const assignRes = await usersRouter.request(`/admin/users/${target.id}/departments`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ departmentIds: [department.id] }),
      });
      expect(assignRes.status).toBe(200);

      const permsAfterAssign = await usersRouter.request(`/admin/users/${target.id}/permissions`);
      const assignBody = (await permsAfterAssign.json()) as {
        permissions: Array<{ resource: string; action: string }>;
        departments: string[];
      };
      expect(assignBody.departments).toContain(department.name);
      expect(
        assignBody.permissions.some((p) => p.resource === "gadget" && p.action === "edit"),
      ).toBe(true);

      const revokeRes = await usersRouter.request(`/admin/users/${target.id}/departments`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ departmentIds: [] }),
      });
      expect(revokeRes.status).toBe(200);

      const permsAfterRevoke = await usersRouter.request(`/admin/users/${target.id}/permissions`);
      const revokeBody = (await permsAfterRevoke.json()) as {
        permissions: Array<{ resource: string; action: string }>;
      };
      expect(
        revokeBody.permissions.some((p) => p.resource === "gadget" && p.action === "edit"),
      ).toBe(false);
    });

    test("a user whose only admin access is via a department is 403'd by requireAdmin before ever reaching this route (documented edge case — see lastAdminGuard.test.ts for the transitive guard logic itself)", async () => {
      const adminRoleId = await ensureAdminRole();
      const department = await makeDepartment("adminconferring-doc");
      await db.departmentRole.create({ data: { departmentId: department.id, roleId: adminRoleId } });

      const deptOnlyAdmin = await makeUser("lastadmin-dept-403");
      await assignDepartment(deptOnlyAdmin.id, department.id);

      // `requireAdmin` (T4) checks DIRECT `user_role` membership only, by
      // design — so a user whose only admin-equivalent access comes from a
      // department can never authenticate ANY /admin/* call, including a
      // self-service attempt to remove their own department membership.
      // This means the last-admin guard's department-transitive branch is
      // NOT reachable here for a self-removal; it still matters for a
      // caller-distinct-from-target removal and is exercised directly (at
      // the DB layer, bypassing this HTTP gate) in `lastAdminGuard.test.ts`.
      actAs(deptOnlyAdmin.id, deptOnlyAdmin.email);
      const { usersRouter } = await import("./users.routes");

      const res = await usersRouter.request(`/admin/users/${deptOnlyAdmin.id}/departments`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ departmentIds: [] }),
      });

      expect(res.status).toBe(403);
    });
  });

  describe("GET /admin/users/:id/permissions", () => {
    test("404s for an unknown id", async () => {
      const adminRoleId = await ensureAdminRole();
      const admin = await makeUser("perms-actor-404");
      await assignRole(admin.id, adminRoleId);
      actAs(admin.id, admin.email);
      const { usersRouter } = await import("./users.routes");

      const res = await usersRouter.request("/admin/users/does-not-exist/permissions");
      expect(res.status).toBe(404);
    });
  });
});
