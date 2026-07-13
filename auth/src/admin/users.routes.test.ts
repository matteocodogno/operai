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

  // ── DELETE /admin/users/:id (soft-delete, T7, specs/006-user-invitations) ──

  describe("DELETE /admin/users/:id", () => {
    test("403s (RFC 7807) when the authenticated caller is not an admin (AC-5.9)", async () => {
      const nonAdmin = await makeUser("delete-nonadmin");
      const target = await makeUser("delete-nonadmin-target");
      actAs(nonAdmin.id, nonAdmin.email);
      const { usersRouter } = await import("./users.routes");

      const res = await usersRouter.request(`/admin/users/${target.id}`, { method: "DELETE" });
      expect(res.status).toBe(403);
    });

    test("422s (RFC 7807) when an admin attempts to delete their own account (AC-5.6), absolute regardless of other admins", async () => {
      const adminRoleId = await ensureAdminRole();
      const admin = await makeUser("delete-self");
      await assignRole(admin.id, adminRoleId);
      const sibling = await makeUser("delete-self-sibling");
      await assignRole(sibling.id, adminRoleId);

      actAs(admin.id, admin.email);
      const { usersRouter } = await import("./users.routes");

      const res = await usersRouter.request(`/admin/users/${admin.id}`, { method: "DELETE" });
      expect(res.status).toBe(422);
      const body = (await res.json()) as { status: number };
      expect(body.status).toBe(422);

      const stillActive = await db.user.findUniqueOrThrow({ where: { id: admin.id } });
      expect(stillActive.deletedAt).toBeNull();
    });

    test("404s for an unknown id", async () => {
      const adminRoleId = await ensureAdminRole();
      const admin = await makeUser("delete-actor-404");
      await assignRole(admin.id, adminRoleId);
      actAs(admin.id, admin.email);
      const { usersRouter } = await import("./users.routes");

      const res = await usersRouter.request("/admin/users/does-not-exist", { method: "DELETE" });
      expect(res.status).toBe(404);
    });

    test("404s for an already soft-deleted user (no admin-facing re-delete, AC-5.4)", async () => {
      const adminRoleId = await ensureAdminRole();
      const admin = await makeUser("delete-actor-already");
      await assignRole(admin.id, adminRoleId);
      const target = await makeUser("delete-target-already");
      await db.user.update({
        where: { id: target.id },
        data: { deletedAt: new Date(), deletedByUserId: admin.id },
      });

      actAs(admin.id, admin.email);
      const { usersRouter } = await import("./users.routes");

      const res = await usersRouter.request(`/admin/users/${target.id}`, { method: "DELETE" });
      expect(res.status).toBe(404);
    });

    // NOTE on AC-5.5 at this endpoint: the true "target is the ONLY
    // remaining effective admin" scenario is structurally unreachable via
    // single-user HTTP delete. `requireAdmin` means the caller is
    // necessarily an effective admin distinct from the target (self-delete
    // is blocked separately by AC-5.6), so the caller ALWAYS counts as
    // "another admin" once the target is removed — the guard can only ever
    // find zero OTHER admins when the caller themself is the target, which
    // this route already refuses first. This mirrors the exact
    // department-transitive precedent already documented above
    // ("a user whose only admin access is via a department is 403'd..."):
    // `assertNotRemovingLastAdmin` throwing when the target truly is the
    // sole effective admin is exercised directly at the DB layer in
    // `lastAdminGuard.test.ts` ("...throws when the target is the ONLY
    // effective admin (direct)"), which this route's `mutate` calls
    // verbatim with `willBeAdminAfter=false` — so route-level correctness
    // here is about proving the WIRING (an admin target's deletion still
    // succeeds when another effective admin remains), not re-deriving the
    // guard's own unit coverage.
    test("deleting an admin target succeeds when another effective admin (the caller) remains (AC-5.5 wiring)", async () => {
      const adminRoleId = await ensureAdminRole();
      const admin = await makeUser("delete-actor-lastadmin");
      await assignRole(admin.id, adminRoleId);
      const otherAdmin = await makeUser("delete-other-admin");
      await assignRole(otherAdmin.id, adminRoleId);

      actAs(admin.id, admin.email);
      const { usersRouter } = await import("./users.routes");

      const res = await usersRouter.request(`/admin/users/${otherAdmin.id}`, { method: "DELETE" });
      expect(res.status).toBe(200);

      const deleted = await db.user.findUniqueOrThrow({ where: { id: otherAdmin.id } });
      expect(deleted.deletedAt).not.toBeNull();
      // The caller (a distinct admin) is untouched and remains active.
      const caller = await db.user.findUniqueOrThrow({ where: { id: admin.id } });
      expect(caller.deletedAt).toBeNull();
    });

    test("soft-deletes: sets deletedAt/deletedByUserId, synchronously revokes sessions, bumps epoch, audits, and retains role/department rows (AC-5.1, AC-5.4, AC-5.8)", async () => {
      const adminRoleId = await ensureAdminRole();
      const admin = await makeUser("delete-actor-happy");
      await assignRole(admin.id, adminRoleId);

      const role = await makeRole("delete-retained");
      const department = await makeDepartment("delete-retained");
      const target = await makeUser("delete-target-happy");
      await assignRole(target.id, role.id);
      await assignDepartment(target.id, department.id);

      // A live session for the target (AC-5.1 — must be revoked synchronously).
      const session = await db.session.create({
        data: {
          userId: target.id,
          token: `t7-session-${unique()}`,
          expiresAt: new Date(Date.now() + 1000 * 60 * 60),
        },
      });

      const beforeEpoch = (
        await db.user.findUniqueOrThrow({ where: { id: target.id }, select: { permissionEpoch: true } })
      ).permissionEpoch;

      actAs(admin.id, admin.email);
      const { usersRouter } = await import("./users.routes");

      const res = await usersRouter.request(`/admin/users/${target.id}`, { method: "DELETE" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { id: string; email: string; deletedAt: string };
      expect(body.id).toBe(target.id);
      expect(body.email).toBe(target.email);
      expect(new Date(body.deletedAt).getTime()).not.toBeNaN();

      const updated = await db.user.findUniqueOrThrow({ where: { id: target.id } });
      expect(updated.deletedAt).not.toBeNull();
      expect(updated.deletedByUserId).toBe(admin.id);
      expect(updated.permissionEpoch).toBe(beforeEpoch + 1);

      // AC-5.1 — synchronous session revocation.
      const remainingSession = await db.session.findUnique({ where: { id: session.id } });
      expect(remainingSession).toBeNull();

      // AC-5.4 — role/department rows retained (not physically removed).
      const retainedRole = await db.userRole.findUnique({
        where: { userId_roleId: { userId: target.id, roleId: role.id } },
      });
      expect(retainedRole).not.toBeNull();
      const retainedDept = await db.userDepartment.findUnique({
        where: { userId_departmentId: { userId: target.id, departmentId: department.id } },
      });
      expect(retainedDept).not.toBeNull();

      // AC-5.8 — audited.
      const auditRow = await db.auditLog.findFirst({
        where: { targetType: "user", targetId: target.id, action: "user.delete" },
        orderBy: { createdAt: "desc" },
      });
      expect(auditRow).not.toBeNull();
      expect(auditRow?.actorUserId).toBe(admin.id);

      // AC-5.3 — gone from the list.
      const listRes = await usersRouter.request(`/admin/users?q=${target.email}`);
      const listBody = (await listRes.json()) as { items: Array<{ id: string }> };
      expect(listBody.items.some((item) => item.id === target.id)).toBe(false);

      // AC-5.4 — detail 404s.
      const detailRes = await usersRouter.request(`/admin/users/${target.id}`);
      expect(detailRes.status).toBe(404);
    });
  });

  // ── POST /admin/users/delete (bulk soft-delete, T7, specs/006-user-invitations) ──

  describe("POST /admin/users/delete", () => {
    test("403s (RFC 7807) when the authenticated caller is not an admin (AC-6.5)", async () => {
      const nonAdmin = await makeUser("bulk-nonadmin");
      const target = await makeUser("bulk-nonadmin-target");
      actAs(nonAdmin.id, nonAdmin.email);
      const { usersRouter } = await import("./users.routes");

      const res = await usersRouter.request("/admin/users/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userIds: [target.id] }),
      });
      expect(res.status).toBe(403);
    });

    test("deletes eligible users (including another admin), skips self with a reason, and audits only the deleted (AC-6.1, 6.2, 6.3, 6.4)", async () => {
      const adminRoleId = await ensureAdminRole();
      const admin = await makeUser("bulk-actor");
      await assignRole(admin.id, adminRoleId);
      // A second admin is a perfectly eligible bulk-delete target: the acting
      // admin themselves remains an effective admin throughout (self is only
      // ever SKIPPED, never removed — AC-5.6), so deleting a DIFFERENT admin
      // never leaves the system with zero admins. See the DELETE
      // /admin/users/:id "(AC-5.5 wiring)" test above for why the true "sole
      // remaining admin" skip is unreachable via this HTTP surface and is
      // instead verified directly against `assertNotRemovingLastAdmin` in
      // `lastAdminGuard.test.ts`.
      const otherAdmin = await makeUser("bulk-other-admin");
      await assignRole(otherAdmin.id, adminRoleId);
      const eligible1 = await makeUser("bulk-eligible-1");
      const eligible2 = await makeUser("bulk-eligible-2");

      actAs(admin.id, admin.email);
      const { usersRouter } = await import("./users.routes");

      const res = await usersRouter.request("/admin/users/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userIds: [admin.id, otherAdmin.id, eligible1.id, eligible2.id],
        }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        deleted: string[];
        skipped: Array<{ userId: string; reason: string }>;
      };

      // AC-6.2 — the acting admin's own account is ALWAYS excluded (skipped,
      // never an error); every other selected user is still soft-deleted —
      // a batch is not entirely blocked by one un-deletable member.
      expect(body.deleted.sort()).toEqual(
        [eligible1.id, eligible2.id, otherAdmin.id].sort(),
      );
      expect(body.skipped).toEqual([
        { userId: admin.id, reason: "skipped: cannot delete your own account" },
      ]);

      const [callerRow, otherAdminRow, e1Row, e2Row] = await Promise.all([
        db.user.findUniqueOrThrow({ where: { id: admin.id } }),
        db.user.findUniqueOrThrow({ where: { id: otherAdmin.id } }),
        db.user.findUniqueOrThrow({ where: { id: eligible1.id } }),
        db.user.findUniqueOrThrow({ where: { id: eligible2.id } }),
      ]);
      expect(callerRow.deletedAt).toBeNull();
      expect(otherAdminRow.deletedAt).not.toBeNull();
      expect(e1Row.deletedAt).not.toBeNull();
      expect(e2Row.deletedAt).not.toBeNull();

      // AC-6.4 — one audit_log row per DELETED user, none for the skipped self.
      const auditRows = await db.auditLog.findMany({
        where: {
          targetType: "user",
          action: "user.delete",
          targetId: { in: [admin.id, otherAdmin.id, eligible1.id, eligible2.id] },
        },
      });
      expect(auditRows.map((r) => r.targetId).sort()).toEqual(
        [eligible1.id, eligible2.id, otherAdmin.id].sort(),
      );
    });

    test("skips an unknown/already-deleted id with a reason instead of failing the batch", async () => {
      const adminRoleId = await ensureAdminRole();
      const admin = await makeUser("bulk-actor-unknown");
      await assignRole(admin.id, adminRoleId);
      const eligible = await makeUser("bulk-unknown-eligible");

      actAs(admin.id, admin.email);
      const { usersRouter } = await import("./users.routes");

      const res = await usersRouter.request("/admin/users/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userIds: ["does-not-exist", eligible.id] }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        deleted: string[];
        skipped: Array<{ userId: string; reason: string }>;
      };
      expect(body.deleted).toEqual([eligible.id]);
      expect(body.skipped).toEqual([{ userId: "does-not-exist", reason: "skipped: user not found" }]);
    });
  });
});
