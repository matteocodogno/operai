/**
 * Direct (non-HTTP) unit/integration tests for the last-admin guard (T10,
 * specs/004-auth-roles-permissions — AC-6.4).
 *
 * Why not only test this through `users.routes.test.ts`'s HTTP layer: the
 * guard deliberately counts department-conferred admin as "effective admin"
 * (wider than `requireAdmin`'s direct-only gate — see `lastAdminGuard.ts`'s
 * doc comment). A user whose ONLY admin access is via a department can
 * never authenticate an `/admin/*` request in the first place (403 before
 * this guard runs), so the department-transitive branch of
 * `assertNotRemovingLastAdmin` can't be exercised end-to-end for a
 * self-service removal. Calling it directly here — against the real DB,
 * with no HTTP/middleware involved — exercises that branch precisely.
 *
 * DB-ISOLATION: every fixture uses a random per-run suffix; the shared
 * "admin" Role row is `upsert`ed and never deleted (see
 * `auth.middleware.test.ts`). `getEffectiveAdminUserIds` queries are
 * asserted against SETS constructed from this file's own known fixture ids
 * (via `.has()`/intersection), never raw global counts, so unrelated
 * concurrent admin rows (other spec-004 test files, or genuinely other
 * admins in this shared dev DB) cannot make these assertions flaky.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { db } from "../lib/db";
import {
  assertNotRemovingLastAdmin,
  departmentIdsConferAdmin,
  getEffectiveAdminUserIds,
  LastAdminGuardError,
  userDepartmentIds,
  userHasDirectAdmin,
} from "./lastAdminGuard";

const RUN_ID = crypto.randomUUID().slice(0, 8);

const createdUserIds = new Set<string>();
const createdDepartmentIds = new Set<string>();

function unique(): string {
  return crypto.randomUUID().slice(0, 8);
}

async function makeUser(label: string) {
  const user = await db.user.create({
    data: {
      name: `T10 lastAdminGuard fixture ${label} ${RUN_ID}`,
      email: `t10-lastadmin-${label}-${RUN_ID}-${unique()}@operai.test`,
      emailVerified: true,
    },
  });
  createdUserIds.add(user.id);
  return user;
}

async function makeDepartment(label: string) {
  const department = await db.department.create({
    data: { name: `t10-lastadmin-dept-${label}-${RUN_ID}-${unique()}` },
  });
  createdDepartmentIds.add(department.id);
  return department;
}

/**
 * Snapshots every effective admin OTHER than `keepUserId`, revokes them
 * (both direct `user_role` rows and department memberships that confer
 * admin) for the duration of `fn`, then restores exactly what it removed.
 * Necessary because this file's own earlier tests (and other spec-004 test
 * files sharing this DB) leave admin-holding fixtures lying around until
 * their own `afterAll`, which would otherwise make "the target is the ONLY
 * effective admin" premise false (a silent false negative) — mirrors the
 * same revoke-then-restore technique `users.routes.test.ts` uses at the
 * HTTP layer.
 */
async function isolateAsSoleAdmin<T>(
  adminRoleId: string,
  keepUserId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const others = await getEffectiveAdminUserIds(db, adminRoleId);
  others.delete(keepUserId);
  const otherIds = [...others];

  const otherDirectHolders = await db.userRole.findMany({
    where: { roleId: adminRoleId, userId: { in: otherIds } },
    select: { userId: true },
  });
  const otherDeptMemberships = await db.userDepartment.findMany({
    where: {
      userId: { in: otherIds },
      department: { departmentRoles: { some: { roleId: adminRoleId } } },
    },
    select: { userId: true, departmentId: true },
  });

  if (otherDirectHolders.length > 0) {
    await db.userRole.deleteMany({
      where: { roleId: adminRoleId, userId: { in: otherDirectHolders.map((r) => r.userId) } },
    });
  }
  if (otherDeptMemberships.length > 0) {
    await db.userDepartment.deleteMany({
      where: {
        OR: otherDeptMemberships.map((m) => ({ userId: m.userId, departmentId: m.departmentId })),
      },
    });
  }

  try {
    return await fn();
  } finally {
    if (otherDirectHolders.length > 0) {
      await db.userRole.createMany({
        data: otherDirectHolders.map((r) => ({ userId: r.userId, roleId: adminRoleId })),
      });
    }
    if (otherDeptMemberships.length > 0) {
      await db.userDepartment.createMany({
        data: otherDeptMemberships.map((m) => ({ userId: m.userId, departmentId: m.departmentId })),
      });
    }
  }
}

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

afterAll(async () => {
  await db.userRole.deleteMany({ where: { userId: { in: [...createdUserIds] } } });
  await db.userDepartment.deleteMany({ where: { userId: { in: [...createdUserIds] } } });
  await db.departmentRole.deleteMany({
    where: { departmentId: { in: [...createdDepartmentIds] } },
  });
  await db.user.deleteMany({ where: { id: { in: [...createdUserIds] } } });
  await db.department.deleteMany({ where: { id: { in: [...createdDepartmentIds] } } });
});

describe("lastAdminGuard (T10, AC-6.4)", () => {
  test("getEffectiveAdminUserIds includes both direct and department-conferred admins", async () => {
    const adminRoleId = await ensureAdminRole();

    const directAdmin = await makeUser("direct");
    await db.userRole.create({ data: { userId: directAdmin.id, roleId: adminRoleId } });

    const department = await makeDepartment("confers");
    await db.departmentRole.create({ data: { departmentId: department.id, roleId: adminRoleId } });
    const deptAdmin = await makeUser("via-dept");
    await db.userDepartment.create({ data: { userId: deptAdmin.id, departmentId: department.id } });

    const nonAdmin = await makeUser("plain");

    const adminSet = await getEffectiveAdminUserIds(db, adminRoleId);

    expect(adminSet.has(directAdmin.id)).toBe(true);
    expect(adminSet.has(deptAdmin.id)).toBe(true);
    expect(adminSet.has(nonAdmin.id)).toBe(false);
  });

  test("userHasDirectAdmin / userDepartmentIds / departmentIdsConferAdmin report correctly", async () => {
    const adminRoleId = await ensureAdminRole();

    const department = await makeDepartment("confers-2");
    await db.departmentRole.create({ data: { departmentId: department.id, roleId: adminRoleId } });
    const plainDepartment = await makeDepartment("plain");

    const user = await makeUser("mixed");
    await db.userDepartment.create({ data: { userId: user.id, departmentId: department.id } });

    expect(await userHasDirectAdmin(db, user.id, adminRoleId)).toBe(false);

    const deptIds = await userDepartmentIds(db, user.id);
    expect(deptIds).toEqual([department.id]);

    expect(await departmentIdsConferAdmin(db, deptIds, adminRoleId)).toBe(true);
    expect(await departmentIdsConferAdmin(db, [plainDepartment.id], adminRoleId)).toBe(false);
    expect(await departmentIdsConferAdmin(db, [], adminRoleId)).toBe(false);
  });

  test("assertNotRemovingLastAdmin is a no-op when the target isn't currently admin", async () => {
    const adminRoleId = await ensureAdminRole();
    const user = await makeUser("not-admin");

    // Should not throw — isCurrentlyAdmin is false.
    await assertNotRemovingLastAdmin(db, adminRoleId, user.id, false, false);
  });

  test("assertNotRemovingLastAdmin is a no-op when the target remains admin after the change", async () => {
    const adminRoleId = await ensureAdminRole();
    const user = await makeUser("stays-admin");

    // Should not throw — willBeAdminAfter is true regardless of global count.
    await assertNotRemovingLastAdmin(db, adminRoleId, user.id, true, true);
  });

  test("assertNotRemovingLastAdmin throws when the target is the ONLY effective admin (direct)", async () => {
    const adminRoleId = await ensureAdminRole();
    const soleAdmin = await makeUser("sole-direct");
    await db.userRole.create({ data: { userId: soleAdmin.id, roleId: adminRoleId } });

    await isolateAsSoleAdmin(adminRoleId, soleAdmin.id, async () => {
      await expect(
        assertNotRemovingLastAdmin(db, adminRoleId, soleAdmin.id, true, false),
      ).rejects.toBeInstanceOf(LastAdminGuardError);
    });
  });

  test("assertNotRemovingLastAdmin throws when the target is the ONLY effective admin (via department — the transitive branch)", async () => {
    const adminRoleId = await ensureAdminRole();
    const department = await makeDepartment("sole-transitive");
    await db.departmentRole.create({ data: { departmentId: department.id, roleId: adminRoleId } });
    const soleAdmin = await makeUser("sole-transitive");
    await db.userDepartment.create({ data: { userId: soleAdmin.id, departmentId: department.id } });

    await isolateAsSoleAdmin(adminRoleId, soleAdmin.id, async () => {
      // The target's OWN admin-ness is entirely department-derived
      // (isCurrentlyAdmin=true via the transitive path), and this call is
      // attempting to remove that very department membership
      // (willBeAdminAfter=false) — with zero other admins left, this must
      // throw. This is exactly the branch that's unreachable via HTTP for a
      // self-removal (see users.routes.test.ts's documented 403 case).
      await expect(
        assertNotRemovingLastAdmin(db, adminRoleId, soleAdmin.id, true, false),
      ).rejects.toBeInstanceOf(LastAdminGuardError);
    });
  });

  test("assertNotRemovingLastAdmin allows removal when another effective admin remains", async () => {
    const adminRoleId = await ensureAdminRole();
    const target = await makeUser("with-sibling");
    await db.userRole.create({ data: { userId: target.id, roleId: adminRoleId } });
    const sibling = await makeUser("sibling");
    await db.userRole.create({ data: { userId: sibling.id, roleId: adminRoleId } });

    // Should not throw — `sibling` remains an effective admin regardless of
    // any other same-file/concurrent admin rows.
    await assertNotRemovingLastAdmin(db, adminRoleId, target.id, true, false);
  });
});
