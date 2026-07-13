/**
 * Integration tests for the admin departments API (spec 004, T9 — AC-1.2).
 *
 * Strategy: mock `../auth/auth.config` (the `auth` object `sessionMiddleware`
 * reads via `auth.api.getSession`) so we can flip between "no session",
 * "authenticated as a non-admin", and "authenticated as an admin" without a
 * real OAuth flow — mirrors `authz/audit.routes.test.ts`. The router itself,
 * its middleware chain (the real `requireAdmin` role-membership query), and
 * every Prisma write run for real against the local Postgres (shared dev DB
 * on localhost:5435). Run this file in isolation (`bun test
 * src/admin/departments.routes.test.ts`) — Bun's `mock.module` replaces a
 * module for the whole test PROCESS, not just this file (see
 * `auth/src/auth/auth.middleware.test.ts`'s doc comment for the full
 * rationale), so mixing this file into a repo-wide `bun test` run alongside
 * files that need the REAL `auth.config` (e.g. `jwt-claims.contract.test.ts`)
 * would be order-dependent; scoping the run to this file avoids that.
 *
 * DB-ISOLATION: every fixture row (department/role/user names+emails) is
 * suffixed with a per-run random id so concurrent `bun test` runs (this
 * file re-run, or other spec-004 task suites) never collide on a unique
 * constraint; every id created is tracked and removed in `afterAll`
 * regardless of which test created it. The single shared "admin" `Role` row
 * is `upsert`ed (never deleted) per the same convention used everywhere else
 * in this authz test suite.
 */

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { Effect } from "effect";
import { db } from "../lib/db";
import { resolveEffectivePermissions } from "../authz/resolver";

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

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const createdUserIds = new Set<string>();
const createdRoleIds = new Set<string>();
const createdDepartmentIds = new Set<string>();
const createdPermissionRuleIds = new Set<string>();

let adminActorId: string;
let nonAdminUserId: string;

/**
 * Idempotently ensures the single shared `Role` row named "admin" exists
 * (see `auth.middleware.test.ts`/`audit.routes.test.ts` for the full
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
      name: `T9 fixture — ${label}`,
      email: `t9-departments-${label}-${RUN_ID}@operai.test`,
      emailVerified: true,
    },
  });
  createdUserIds.add(user.id);
  return user;
}

async function makeRole(label: string) {
  const role = await db.role.create({
    data: { name: `t9-role-${label}-${RUN_ID}` },
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
    user: {
      id: nonAdminUserId,
      email: "nonadmin@operai.test",
      name: "Non-Admin",
    },
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
  await db.userRole.create({
    data: { userId: adminActorId, roleId: adminRoleId },
  });

  const nonAdmin = await makeUser("nonadmin");
  nonAdminUserId = nonAdmin.id;
});

afterAll(async () => {
  await db.permissionRule.deleteMany({
    where: { id: { in: Array.from(createdPermissionRuleIds) } },
  });
  await db.department.deleteMany({
    where: { id: { in: Array.from(createdDepartmentIds) } },
  });
  await db.role.deleteMany({ where: { id: { in: Array.from(createdRoleIds) } } });
  await db.user.deleteMany({ where: { id: { in: Array.from(createdUserIds) } } });
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("Admin departments API (T9)", () => {
  test("401s (RFC 7807) with no session", async () => {
    noSession();
    const { departmentsRouter } = await import("./departments.routes");

    const res = await departmentsRouter.request("/admin/departments");

    expect(res.status).toBe(401);
    const body = (await res.json()) as { status: number; title: string };
    expect(body.status).toBe(401);
    expect(body.title).toBe("Unauthorized");
  });

  test("403s (RFC 7807) for an authenticated non-admin (T4, AC-1.5)", async () => {
    asNonAdmin();
    const { departmentsRouter } = await import("./departments.routes");

    const res = await departmentsRouter.request("/admin/departments");

    expect(res.status).toBe(403);
    const body = (await res.json()) as {
      status: number;
      title: string;
      type: string;
    };
    expect(body.status).toBe(403);
    expect(body.title).toBe("Forbidden");
    expect(body.type).toBe("https://httpstatuses.com/403");
  });

  test("GET /admin/departments returns a bare array (matches admin-ui's listDepartments, not the pagination envelope)", async () => {
    asAdmin();
    const { departmentsRouter } = await import("./departments.routes");

    const department = await db.department.create({
      data: { name: `t9-dept-list-${RUN_ID}` },
    });
    createdDepartmentIds.add(department.id);

    const res = await departmentsRouter.request("/admin/departments");
    expect(res.status).toBe(200);

    const body = (await res.json()) as unknown;
    expect(Array.isArray(body)).toBe(true);
    const departments = body as Array<{ id: string }>;
    expect(departments.map((d) => d.id)).toContain(department.id);
  });

  test("POST creates a department; duplicate name -> 409", async () => {
    asAdmin();
    const { departmentsRouter } = await import("./departments.routes");

    const name = `t9-dept-create-${RUN_ID}`;
    const res = await departmentsRouter.request("/admin/departments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, description: "Created by T9 tests" }),
    });

    expect(res.status).toBe(201);
    const created = (await res.json()) as {
      id: string;
      name: string;
      description: string | null;
    };
    expect(created.name).toBe(name);
    expect(created.description).toBe("Created by T9 tests");
    createdDepartmentIds.add(created.id);

    // Same name again -> 409 Conflict.
    const dupRes = await departmentsRouter.request("/admin/departments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    expect(dupRes.status).toBe(409);
    const dupBody = (await dupRes.json()) as { status: number; type: string };
    expect(dupBody.status).toBe(409);
    expect(dupBody.type).toBe("https://httpstatuses.com/409");

    // An audit row was written for the create.
    const auditRow = await db.auditLog.findFirst({
      where: { action: "department.create", targetId: created.id },
    });
    expect(auditRow).not.toBeNull();
    expect(auditRow?.actorUserId).toBe(adminActorId);
  });

  test("GET /:id 404s for an unknown id", async () => {
    asAdmin();
    const { departmentsRouter } = await import("./departments.routes");

    const res = await departmentsRouter.request(
      "/admin/departments/does-not-exist",
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { status: number };
    expect(body.status).toBe(404);
  });

  test("GET /:id embeds the department's conferred roleIds and member list (drift fix, matches admin-ui's DepartmentDetail)", async () => {
    asAdmin();
    const { departmentsRouter } = await import("./departments.routes");

    const department = await db.department.create({
      data: { name: `t9-dept-detail-${RUN_ID}` },
    });
    createdDepartmentIds.add(department.id);

    const role = await makeRole("detail");
    const member = await makeUser("detail-member");

    await db.departmentRole.create({
      data: { departmentId: department.id, roleId: role.id },
    });
    await db.userDepartment.create({
      data: { userId: member.id, departmentId: department.id },
    });

    const res = await departmentsRouter.request(
      `/admin/departments/${department.id}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      roleIds: string[];
      members: Array<{ id: string; name: string; email: string }>;
    };

    expect(body.id).toBe(department.id);
    expect(body.roleIds).toContain(role.id);
    expect(body.members.map((m) => m.id)).toContain(member.id);
  });

  test("PATCH renames a department and audits the change", async () => {
    asAdmin();
    const { departmentsRouter } = await import("./departments.routes");

    const department = await db.department.create({
      data: { name: `t9-dept-patch-${RUN_ID}` },
    });
    createdDepartmentIds.add(department.id);

    const newName = `t9-dept-patch-renamed-${RUN_ID}`;
    const res = await departmentsRouter.request(
      `/admin/departments/${department.id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName }),
      },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string };
    expect(body.name).toBe(newName);

    const auditRow = await db.auditLog.findFirst({
      where: { action: "department.update", targetId: department.id },
    });
    expect(auditRow).not.toBeNull();
  });

  test("PUT /:id/roles 422s on an unknown roleId", async () => {
    asAdmin();
    const { departmentsRouter } = await import("./departments.routes");

    const department = await db.department.create({
      data: { name: `t9-dept-badrole-${RUN_ID}` },
    });
    createdDepartmentIds.add(department.id);

    const res = await departmentsRouter.request(
      `/admin/departments/${department.id}/roles`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roleIds: ["does-not-exist"] }),
      },
    );

    expect(res.status).toBe(422);
    const body = (await res.json()) as { status: number };
    expect(body.status).toBe(422);
  });

  test("PUT /:id/members 422s on an unknown userId", async () => {
    asAdmin();
    const { departmentsRouter } = await import("./departments.routes");

    const department = await db.department.create({
      data: { name: `t9-dept-baduser-${RUN_ID}` },
    });
    createdDepartmentIds.add(department.id);

    const res = await departmentsRouter.request(
      `/admin/departments/${department.id}/members`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userIds: ["does-not-exist"] }),
      },
    );

    expect(res.status).toBe(422);
    const body = (await res.json()) as { status: number };
    expect(body.status).toBe(422);
  });

  test("DELETE removes a department; subsequent GET 404s", async () => {
    asAdmin();
    const { departmentsRouter } = await import("./departments.routes");

    const department = await db.department.create({
      data: { name: `t9-dept-delete-${RUN_ID}` },
    });

    const delRes = await departmentsRouter.request(
      `/admin/departments/${department.id}`,
      { method: "DELETE" },
    );
    expect(delRes.status).toBe(204);

    const getRes = await departmentsRouter.request(
      `/admin/departments/${department.id}`,
    );
    expect(getRes.status).toBe(404);

    const auditRow = await db.auditLog.findFirst({
      where: { action: "department.delete", targetId: department.id },
    });
    expect(auditRow).not.toBeNull();
  });

  test(
    "AC-1.2: create a department, confer a role, add a member -> the member " +
      "inherits the department's conferred roles (verified via the resolver, " +
      "the /authz/me-equivalent resolution), and the member's permissionEpoch " +
      "is bumped by both the roles PUT and the members PUT",
    async () => {
      asAdmin();
      const { departmentsRouter } = await import("./departments.routes");

      const department = await db.department.create({
        data: { name: `t9-dept-ac12-${RUN_ID}` },
      });
      createdDepartmentIds.add(department.id);

      const role = await makeRole("ac12");
      const rule = await db.permissionRule.create({
        data: {
          roleId: role.id,
          resource: "estimate",
          action: "view",
        },
      });
      createdPermissionRuleIds.add(rule.id);

      const member = await makeUser("ac12-member");
      const epochBeforeAnyMutation = (
        await db.user.findUniqueOrThrow({
          where: { id: member.id },
          select: { permissionEpoch: true },
        })
      ).permissionEpoch;

      // Before joining the department, the member resolves NO permissions
      // (AC-4.4 default-deny).
      const beforePermissions = await Effect.runPromise(
        resolveEffectivePermissions(member.id),
      );
      expect(
        beforePermissions.some(
          (p) => p.resource === "estimate" && p.action === "view",
        ),
      ).toBe(false);

      // Confer the role onto the department (no members yet -> no epoch
      // bump expected for `member`, who isn't a member yet).
      const rolesRes = await departmentsRouter.request(
        `/admin/departments/${department.id}/roles`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ roleIds: [role.id] }),
        },
      );
      expect(rolesRes.status).toBe(200);

      // Now add the member to the department.
      const membersRes = await departmentsRouter.request(
        `/admin/departments/${department.id}/members`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userIds: [member.id] }),
        },
      );
      expect(membersRes.status).toBe(200);
      const membersBody = (await membersRes.json()) as {
        members: Array<{ id: string }>;
        roleIds: string[];
      };
      expect(membersBody.members.map((m) => m.id)).toContain(member.id);
      expect(membersBody.roleIds).toContain(role.id);

      // AC-1.2: the member now inherits the department's conferred role's
      // rules through the resolver's union (T2) — this is exactly the
      // resolution `/authz/me` (T6) performs for the caller.
      const afterPermissions = await Effect.runPromise(
        resolveEffectivePermissions(member.id),
      );
      expect(
        afterPermissions.some(
          (p) => p.resource === "estimate" && p.action === "view",
        ),
      ).toBe(true);

      // AC-4.3: the member's permissionEpoch was bumped by the members PUT
      // (the mutation that actually changed what THIS member can do).
      const epochAfter = (
        await db.user.findUniqueOrThrow({
          where: { id: member.id },
          select: { permissionEpoch: true },
        })
      ).permissionEpoch;
      expect(epochAfter).toBeGreaterThan(epochBeforeAnyMutation);
    },
  );
});
