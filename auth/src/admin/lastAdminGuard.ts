/**
 * Last-admin guard (T10, specs/004-auth-roles-permissions — AC-6.4).
 *
 * Extracted into its own module (rather than living inline in
 * `users.routes.ts`) for two reasons:
 *   1. It is the security-critical piece of T10 and deserves direct,
 *      DB-level unit tests independent of the HTTP/middleware layer.
 *   2. `requireAdmin` (auth.middleware.ts, T4) is DIRECT-role-only by
 *      design — a user whose only admin access is via a department can
 *      never authenticate an `/admin/*` request at all (403 before this
 *      guard is ever reached). That means the "transitive via department"
 *      branch of this guard is NOT reachable through today's HTTP surface
 *      for a *self-service* removal, and only reachable for a
 *      caller-distinct-from-target removal when the target's admin-ness
 *      is entirely department-derived — a real but narrow case. Testing
 *      the department-transitive logic thoroughly therefore requires
 *      calling `assertNotRemovingLastAdmin` directly (see
 *      `lastAdminGuard.test.ts`), not only through `users.routes.test.ts`'s
 *      HTTP-level tests.
 *
 * "Effective admin" here deliberately counts BOTH direct `user_role` grants
 * of the `admin` role AND department-conferred ones — wider than
 * `requireAdmin`'s own (direct-only) gate. The spec's concern (AC-6.4) is
 * "never leave the system with zero users who have admin access, by any
 * path" — undercounting a department-conferred admin would let an operator
 * accidentally lock everyone out.
 */

import type { Prisma, PrismaClient } from "../lib/generated/prisma/client";

export const ADMIN_ROLE_NAME = "admin";

export type PrismaClientLike = PrismaClient | Prisma.TransactionClient;

/**
 * Thrown to abort a `withAudit` `mutate` callback (rolling back the whole
 * transaction) when a role/department change would leave the system with
 * zero effective admins. Callers at the HTTP boundary catch this and
 * translate it to an RFC 7807 `422`.
 */
export class LastAdminGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LastAdminGuardError";
  }
}

export async function findAdminRoleId(client: PrismaClientLike): Promise<string | null> {
  const role = await client.role.findUnique({
    where: { name: ADMIN_ROLE_NAME },
    select: { id: true },
  });
  return role?.id ?? null;
}

/**
 * All user ids that are currently effective admins: DIRECT `user_role` OR
 * via a department that confers the `admin` role.
 */
export async function getEffectiveAdminUserIds(
  client: PrismaClientLike,
  adminRoleId: string,
): Promise<Set<string>> {
  const [direct, viaDepartment] = await Promise.all([
    client.userRole.findMany({
      where: { roleId: adminRoleId },
      select: { userId: true },
    }),
    client.userDepartment.findMany({
      where: { department: { departmentRoles: { some: { roleId: adminRoleId } } } },
      select: { userId: true },
    }),
  ]);

  return new Set([
    ...direct.map((row) => row.userId),
    ...viaDepartment.map((row) => row.userId),
  ]);
}

export async function userHasDirectAdmin(
  client: PrismaClientLike,
  userId: string,
  adminRoleId: string,
): Promise<boolean> {
  const row = await client.userRole.findUnique({
    where: { userId_roleId: { userId, roleId: adminRoleId } },
    select: { userId: true },
  });
  return row !== null;
}

export async function userDepartmentIds(
  client: PrismaClientLike,
  userId: string,
): Promise<string[]> {
  const rows = await client.userDepartment.findMany({
    where: { userId },
    select: { departmentId: true },
  });
  return rows.map((row) => row.departmentId);
}

export async function departmentIdsConferAdmin(
  client: PrismaClientLike,
  departmentIds: readonly string[],
  adminRoleId: string,
): Promise<boolean> {
  if (departmentIds.length === 0) return false;
  const count = await client.departmentRole.count({
    where: { departmentId: { in: [...departmentIds] }, roleId: adminRoleId },
  });
  return count > 0;
}

/**
 * Refuses (throws `LastAdminGuardError`) an operation that would leave the
 * system with zero effective admins. `isCurrentlyAdmin`/`willBeAdminAfter`
 * describe ONLY the target user's own admin-ness across the pending
 * change; this function then checks whether any OTHER user still holds
 * admin (directly or via department) once the change applies.
 */
export async function assertNotRemovingLastAdmin(
  client: PrismaClientLike,
  adminRoleId: string,
  targetUserId: string,
  isCurrentlyAdmin: boolean,
  willBeAdminAfter: boolean,
): Promise<void> {
  if (!isCurrentlyAdmin || willBeAdminAfter) return;

  const adminSet = await getEffectiveAdminUserIds(client, adminRoleId);
  adminSet.delete(targetUserId);

  if (adminSet.size === 0) {
    throw new LastAdminGuardError(
      "This change would remove the last remaining admin — at least one user must retain admin access",
    );
  }
}
