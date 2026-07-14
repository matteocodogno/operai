/**
 * Admin Users API (T10, specs/004-auth-roles-permissions — refs AC-1.3,
 * AC-1.4, AC-2.3, AC-6.4).
 *
 * All routes are guarded by `sessionMiddleware` + `requireAuth` +
 * `requireAdmin` (T4, AC-1.5) — non-admin callers get RFC 7807 `403`.
 *
 *   GET   /admin/users                       paginated + `?q=` search (name/email)
 *   GET   /admin/users/:id                    a user + their roles/departments/attributes
 *   PATCH /admin/users/:id                    set `entity`/`jobTitle`
 *   PUT   /admin/users/:id/roles              (re)assign the user's DIRECT roles — `{ roleIds }`
 *   PUT   /admin/users/:id/departments        (re)assign the user's departments — `{ departmentIds }`
 *   GET   /admin/users/:id/permissions        the resolver's effective-permissions output for
 *                                             this user (drift fix — `/authz/me` is caller-only)
 *
 * Every mutating route runs its domain write through `withAudit()` (T7) so
 * the audit row and the affected user(s)' `permissionEpoch` bump happen
 * atomically with the write (AC-5.1, AC-4.3).
 *
 * ── Last-admin guard (AC-6.4) ────────────────────────────────────────────
 * `PUT .../roles` and `PUT .../departments` are the two operations that can
 * strip a user of the `admin` role — directly (unassigning the role) or
 * transitively (removing them from every department that confers `admin`).
 * Both compute the user's "effective admin-ness" BEFORE and AFTER the
 * write and refuse (`422`) any change that would leave ZERO users with
 * admin access.
 *
 * Note this check is deliberately WIDER than `requireAdmin`'s own gate:
 * `requireAdmin` (auth.middleware.ts) checks only DIRECT `user_role`
 * membership, by design (admin is meant to be assigned directly, not via a
 * department — see that file's doc comment). The guardrail here still
 * counts department-conferred admin because the SPEC's concern (AC-6.4) is
 * "never leave the system with zero effective admins", and a department
 * that happens to confer the `admin` role is one more way a user could
 * currently be relying on admin-equivalent access — undercounting it would
 * let an operator accidentally lock everyone out.
 *
 * The guard's implementation lives in `./lastAdminGuard.ts` (extracted so it
 * can be unit-tested directly at the DB layer — see that module's doc
 * comment for why the department-transitive branch needs a non-HTTP test
 * seam).
 */

import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";
import { Effect } from "effect";
import type { User } from "better-auth";
import {
  requireAdmin,
  requireAuth,
  sessionMiddleware,
} from "../auth/auth.middleware";
import { db } from "../lib/db";
import { withAudit } from "../authz/audit";
import { resolveEffectivePermissions } from "../authz/resolver";
import type { Prisma } from "../lib/generated/prisma/client";
import {
  assertNotRemovingLastAdmin,
  departmentIdsConferAdmin,
  findAdminRoleId,
  LastAdminGuardError,
  userDepartmentIds,
  userHasDirectAdmin,
} from "./lastAdminGuard";

// ─── Schemas ──────────────────────────────────────────────────────────────────

const ENTITY_VALUES = ["welld_ch", "welld_it"] as const;

const IdParamSchema = z.object({ id: z.string().min(1) });

const UsersQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  q: z.string().trim().min(1).optional(),
});

const RoleSummarySchema = z.object({ id: z.string(), name: z.string() });
const DepartmentSummarySchema = z.object({ id: z.string(), name: z.string() });

const UserListItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  entity: z.string().nullable(),
  jobTitle: z.string().nullable(),
  roles: z.array(z.string()),
  departments: z.array(z.string()),
});

const UserListResponseSchema = z.object({
  items: z.array(UserListItemSchema),
  page: z.number().int(),
  pageSize: z.number().int(),
  total: z.number().int(),
});

const UserDetailSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  entity: z.string().nullable(),
  jobTitle: z.string().nullable(),
  permissionEpoch: z.number().int(),
  roles: z.array(RoleSummarySchema),
  departments: z.array(DepartmentSummarySchema),
});

// ─── Soft-delete schemas (T7, specs/006-user-invitations — refs US-5, US-6) ───

const DeleteUserResponseSchema = z.object({
  id: z.string(),
  email: z.string(),
  deletedAt: z.string(),
});

const BulkDeleteBodySchema = z.object({
  userIds: z.array(z.string().min(1)).min(1),
});

const SkippedUserSchema = z.object({
  userId: z.string(),
  reason: z.string(),
});

const BulkDeleteResponseSchema = z.object({
  deleted: z.array(z.string()),
  skipped: z.array(SkippedUserSchema),
});

const PatchUserBodySchema = z
  .object({
    entity: z.enum(ENTITY_VALUES).nullable().optional(),
    jobTitle: z.string().trim().max(200).nullable().optional(),
  })
  .refine((body) => body.entity !== undefined || body.jobTitle !== undefined, {
    message: "At least one of entity or jobTitle must be provided",
  });

const SetRoleIdsBodySchema = z.object({
  roleIds: z.array(z.string().min(1)),
});

const SetDepartmentIdsBodySchema = z.object({
  departmentIds: z.array(z.string().min(1)),
});

const ConditionAttributeSchema = z.object({
  key: z.string(),
  match: z.string(),
});

const RuleConditionsSchema = z.object({
  ownership: z.enum(["own", "any"]).optional(),
  attributes: z.array(ConditionAttributeSchema).optional(),
});

const PermissionSchema = z.object({
  resource: z.string(),
  action: z.string(),
  conditions: RuleConditionsSchema.nullable(),
});

const EffectivePermissionsSchema = z.object({
  epoch: z.number().int(),
  apps: z.array(z.string()),
  roles: z.array(z.string()),
  departments: z.array(z.string()),
  permissions: z.array(PermissionSchema),
});

const ProblemJsonSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number(),
  detail: z.string(),
  instance: z.string(),
});

// ─── Problem-JSON helpers ─────────────────────────────────────────────────────

function notFound(instance: string, detail: string) {
  return {
    type: "https://httpstatuses.com/404",
    title: "Not Found",
    status: 404,
    detail,
    instance,
  } as const;
}

function unprocessable(instance: string, detail: string) {
  return {
    type: "https://httpstatuses.com/422",
    title: "Unprocessable Entity",
    status: 422,
    detail,
    instance,
  } as const;
}

async function buildEffectivePermissionsBody(userId: string) {
  const [profile, permissions] = await Promise.all([
    db.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        permissionEpoch: true,
        userRoles: { select: { role: { select: { name: true } } } },
        userDepartments: {
          select: { department: { select: { name: true } } },
        },
      },
    }),
    Effect.runPromise(resolveEffectivePermissions(userId)),
  ]);

  const apps = permissions
    .filter((permission) => permission.action === "access")
    .map((permission) => permission.resource);

  const permissionsBody = permissions.map((permission) => ({
    resource: permission.resource,
    action: permission.action,
    conditions: permission.conditions
      ? {
          ...(permission.conditions.ownership !== undefined
            ? { ownership: permission.conditions.ownership }
            : {}),
          ...(permission.conditions.attributes !== undefined
            ? {
                attributes: permission.conditions.attributes.map((attribute) => ({
                  key: attribute.key,
                  match: attribute.match,
                })),
              }
            : {}),
        }
      : null,
  }));

  return {
    epoch: profile.permissionEpoch,
    apps,
    roles: profile.userRoles.map((userRole) => userRole.role.name),
    departments: profile.userDepartments.map(
      (userDepartment) => userDepartment.department.name,
    ),
    permissions: permissionsBody,
  };
}

// ─── Router ───────────────────────────────────────────────────────────────────

// A dedicated OpenAPIHono instance with an RFC 7807 `defaultHook` so a
// malformed query/body surfaces as Problem JSON (matches audit.routes.ts /
// authz.routes.ts and the rest of the service's `app.onError` convention).
export const usersRouter = new OpenAPIHono<{
  Variables: { user: User | null };
}>({
  defaultHook: (result, c) => {
    if (!result.success) {
      return c.json(
        {
          type: "https://httpstatuses.com/400",
          title: "Bad Request",
          status: 400,
          detail: result.error.issues
            .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
            .join("; "),
          instance: c.req.path,
        },
        400,
      );
    }
    return undefined;
  },
});

usersRouter.use("/admin/users", sessionMiddleware, requireAuth, requireAdmin);
usersRouter.use("/admin/users/*", sessionMiddleware, requireAuth, requireAdmin);

// ─── GET /admin/users ─────────────────────────────────────────────────────────

const listUsersRoute = createRoute({
  method: "get",
  path: "/admin/users",
  tags: ["Admin"],
  summary: "List users (paginated, searchable)",
  description:
    "Paginated list of users with their direct roles/departments/attributes. " +
    "`?q=` searches name and email (case-insensitive, substring match).",
  request: { query: UsersQuerySchema },
  responses: {
    200: {
      content: { "application/json": { schema: UserListResponseSchema } },
      description: "A page of users",
    },
    401: {
      content: { "application/json": { schema: ProblemJsonSchema } },
      description: "No valid session",
    },
    403: {
      content: { "application/json": { schema: ProblemJsonSchema } },
      description: "Caller does not hold the admin role",
    },
  },
});

usersRouter.openapi(listUsersRoute, async (c) => {
  const { page, pageSize, q } = c.req.valid("query");

  // AC-5.3 (specs/006-user-invitations, T7): a soft-deleted user is gone
  // from every user-facing list — filtered out here, not merely hidden by
  // the UI, so no client can discover them via this endpoint either.
  const whereClause: Prisma.UserWhereInput = {
    deletedAt: null,
    ...(q
      ? {
          OR: [
            { name: { contains: q, mode: "insensitive" } },
            { email: { contains: q, mode: "insensitive" } },
          ],
        }
      : {}),
  };

  const [rows, total] = await Promise.all([
    db.user.findMany({
      where: whereClause,
      orderBy: [{ name: "asc" }, { id: "asc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        name: true,
        email: true,
        entity: true,
        jobTitle: true,
        userRoles: { select: { role: { select: { name: true } } } },
        userDepartments: { select: { department: { select: { name: true } } } },
      },
    }),
    db.user.count({ where: whereClause }),
  ]);

  return c.json(
    {
      items: rows.map((row) => ({
        id: row.id,
        name: row.name,
        email: row.email,
        entity: row.entity,
        jobTitle: row.jobTitle,
        roles: row.userRoles.map((userRole) => userRole.role.name),
        departments: row.userDepartments.map(
          (userDepartment) => userDepartment.department.name,
        ),
      })),
      page,
      pageSize,
      total,
    },
    200,
  );
});

// ─── GET /admin/users/:id ─────────────────────────────────────────────────────

const getUserRoute = createRoute({
  method: "get",
  path: "/admin/users/{id}",
  tags: ["Admin"],
  summary: "Get a user with roles/departments/attributes",
  request: { params: IdParamSchema },
  responses: {
    200: {
      content: { "application/json": { schema: UserDetailSchema } },
      description: "The user, its direct roles, departments and attributes",
    },
    401: {
      content: { "application/json": { schema: ProblemJsonSchema } },
      description: "No valid session",
    },
    403: {
      content: { "application/json": { schema: ProblemJsonSchema } },
      description: "Caller does not hold the admin role",
    },
    404: {
      content: { "application/json": { schema: ProblemJsonSchema } },
      description: "No user with this id",
    },
  },
});

usersRouter.openapi(getUserRoute, async (c) => {
  const { id } = c.req.valid("param");

  const user = await db.user.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      email: true,
      entity: true,
      jobTitle: true,
      permissionEpoch: true,
      deletedAt: true,
      userRoles: { select: { role: { select: { id: true, name: true } } } },
      userDepartments: {
        select: { department: { select: { id: true, name: true } } },
      },
    },
  });

  // AC-5.4 (specs/006-user-invitations, T7): a soft-deleted user's record is
  // retained internally (audit/referential integrity) but there is no
  // admin-facing way to browse them — the detail endpoint 404s exactly as
  // if the row didn't exist, same as an unknown id.
  if (!user || user.deletedAt !== null) {
    return c.json(notFound(c.req.path, `No user with id ${id}`), 404);
  }

  return c.json(
    {
      id: user.id,
      name: user.name,
      email: user.email,
      entity: user.entity,
      jobTitle: user.jobTitle,
      permissionEpoch: user.permissionEpoch,
      roles: user.userRoles.map((userRole) => userRole.role),
      departments: user.userDepartments.map((userDepartment) => userDepartment.department),
    },
    200,
  );
});

// ─── DELETE /admin/users/:id ──────────────────────────────────────────────────
//
// Soft-delete (T7, specs/006-user-invitations — refs US-5, AC-5.1, AC-5.3–5.9;
// ADR-0012). Per-delete, inside a single `withAudit` transaction:
//   1. AC-5.6 (absolute, checked first, independent of admin-count): the
//      caller can never delete their own account through this action.
//   2. 404 if the target doesn't exist or is already soft-deleted (AC-5.4 —
//      no admin-facing way to "see" a soft-deleted user at all).
//   3. AC-5.5: the last-admin guard (reused from `./lastAdminGuard.ts`,
//      T10/specs/004) — deletion always removes ALL effective access, so
//      `willBeAdminAfter` is unconditionally `false` here (unlike the
//      roles/departments routes, which pass the caller's proposed new set).
//   4. `deletedAt`/`deletedByUserId` set + a SYNCHRONOUS `session.deleteMany`
//      in the SAME transaction (AC-5.1 — not a background job) + the
//      `withAudit` epoch bump + `user.delete` audit row (AC-5.8). The user's
//      `Account`/`UserRole`/`UserDepartment` rows are retained untouched
//      (AC-5.4, ADR-0012) — only `deletedAt` changes.

const deleteUserRoute = createRoute({
  method: "delete",
  path: "/admin/users/{id}",
  tags: ["Admin"],
  summary: "Soft-delete a user",
  description:
    "Soft-deletes a user: marks deletedAt, synchronously revokes every " +
    "active session, and bumps their permission epoch. The user's own " +
    "record and their UserRole/UserDepartment/Account rows are retained " +
    "(ADR-0012) — nothing is physically removed.",
  request: { params: IdParamSchema },
  responses: {
    200: {
      content: { "application/json": { schema: DeleteUserResponseSchema } },
      description: "The user was soft-deleted",
    },
    401: {
      content: { "application/json": { schema: ProblemJsonSchema } },
      description: "No valid session",
    },
    403: {
      content: { "application/json": { schema: ProblemJsonSchema } },
      description: "Caller does not hold the admin role",
    },
    404: {
      content: { "application/json": { schema: ProblemJsonSchema } },
      description: "No user with this id, or the user is already soft-deleted",
    },
    422: {
      content: { "application/json": { schema: ProblemJsonSchema } },
      description:
        "The caller attempted to delete their own account (AC-5.6), or this " +
        "would remove the last remaining admin (AC-5.5)",
    },
  },
});

usersRouter.openapi(deleteUserRoute, async (c) => {
  const { id } = c.req.valid("param");
  const actorUserId = c.get("user")!.id;

  // AC-5.6 — absolute, checked before anything else (including whether other
  // admins remain): the acting admin can never delete their own account.
  if (id === actorUserId) {
    return c.json(
      unprocessable(c.req.path, "You cannot delete your own account"),
      422,
    );
  }

  const target = await db.user.findUnique({
    where: { id },
    select: { id: true, email: true, deletedAt: true },
  });
  if (!target || target.deletedAt !== null) {
    return c.json(notFound(c.req.path, `No user with id ${id}`), 404);
  }

  try {
    const deletedAt = await withAudit({
      affectedUserIds: [id],
      mutate: async (tx) => {
        const adminRoleId = await findAdminRoleId(tx);
        if (adminRoleId) {
          const [directAdmin, deptIds] = await Promise.all([
            userHasDirectAdmin(tx, id, adminRoleId),
            userDepartmentIds(tx, id),
          ]);
          const deptConfersAdmin = await departmentIdsConferAdmin(
            tx,
            deptIds,
            adminRoleId,
          );
          const isCurrentlyAdmin = directAdmin || deptConfersAdmin;

          await assertNotRemovingLastAdmin(
            tx,
            adminRoleId,
            id,
            isCurrentlyAdmin,
            false,
          );
        }

        const now = new Date();
        await tx.user.update({
          where: { id },
          data: { deletedAt: now, deletedByUserId: actorUserId },
        });
        // Synchronous session revocation (AC-5.1) — same transaction, not a
        // background job: a subsequent getSession for this user is empty.
        await tx.session.deleteMany({ where: { userId: id } });
        return now;
      },
      entry: {
        actorUserId,
        action: "user.delete",
        targetType: "user",
        targetId: id,
        summary: `Deleted user ${target.email}`,
        data: { deletedByUserId: actorUserId },
      },
    });

    return c.json(
      { id, email: target.email, deletedAt: deletedAt.toISOString() },
      200,
    );
  } catch (error) {
    if (error instanceof LastAdminGuardError) {
      return c.json(unprocessable(c.req.path, error.message), 422);
    }
    throw error;
  }
});

// ─── POST /admin/users/delete (bulk) ──────────────────────────────────────────
//
// Bulk soft-delete (T7, specs/006-user-invitations — refs US-6, AC-6.1–6.5).
// Partial-success, never all-or-nothing (AC-6.2/6.3): each requested id is
// processed in its own `withAudit` transaction, SEQUENTIALLY (not
// `Promise.all`) — deliberate, so that deleting several admins in one batch
// re-evaluates "is there still another effective admin" against the
// already-committed result of every earlier id in the same request (a
// soft-deleted admin is excluded from that count the moment their own
// transaction commits, per `lastAdminGuard.ts`'s `deletedAt: null` filter).
// The acting admin's own id is ALWAYS skipped (AC-6.2, no exception), before
// any DB lookup, exactly mirroring the single-delete route's absolute
// self-delete guard (AC-5.6).

const bulkDeleteUsersRoute = createRoute({
  method: "post",
  path: "/admin/users/delete",
  tags: ["Admin"],
  summary: "Bulk soft-delete users",
  description:
    "Soft-deletes every requested user for whom deletion is permitted; the " +
    "acting admin's own id and the sole remaining admin (if requested) are " +
    "skipped with a reason rather than failing the whole batch (AC-6.2/6.3).",
  request: {
    body: {
      content: { "application/json": { schema: BulkDeleteBodySchema } },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: BulkDeleteResponseSchema } },
      description: "Per-user outcome: which ids were deleted, which were skipped and why",
    },
    401: {
      content: { "application/json": { schema: ProblemJsonSchema } },
      description: "No valid session",
    },
    403: {
      content: { "application/json": { schema: ProblemJsonSchema } },
      description: "Caller does not hold the admin role",
    },
  },
});

usersRouter.openapi(bulkDeleteUsersRoute, async (c) => {
  const { userIds } = c.req.valid("json");
  const actorUserId = c.get("user")!.id;

  const uniqueIds = Array.from(new Set(userIds));
  const deleted: string[] = [];
  const skipped: { userId: string; reason: string }[] = [];

  for (const id of uniqueIds) {
    // AC-5.6/AC-6.2 — the acting admin's own account is ALWAYS excluded,
    // with no exception, before any lookup.
    if (id === actorUserId) {
      skipped.push({ userId: id, reason: "skipped: cannot delete your own account" });
      continue;
    }

    const target = await db.user.findUnique({
      where: { id },
      select: { id: true, email: true, deletedAt: true },
    });
    if (!target || target.deletedAt !== null) {
      skipped.push({ userId: id, reason: "skipped: user not found" });
      continue;
    }

    try {
      await withAudit({
        affectedUserIds: [id],
        mutate: async (tx) => {
          const adminRoleId = await findAdminRoleId(tx);
          if (adminRoleId) {
            const [directAdmin, deptIds] = await Promise.all([
              userHasDirectAdmin(tx, id, adminRoleId),
              userDepartmentIds(tx, id),
            ]);
            const deptConfersAdmin = await departmentIdsConferAdmin(
              tx,
              deptIds,
              adminRoleId,
            );
            const isCurrentlyAdmin = directAdmin || deptConfersAdmin;

            await assertNotRemovingLastAdmin(
              tx,
              adminRoleId,
              id,
              isCurrentlyAdmin,
              false,
            );
          }

          await tx.user.update({
            where: { id },
            data: { deletedAt: new Date(), deletedByUserId: actorUserId },
          });
          await tx.session.deleteMany({ where: { userId: id } });
        },
        entry: {
          actorUserId,
          action: "user.delete",
          targetType: "user",
          targetId: id,
          summary: `Deleted user ${target.email} (bulk)`,
          data: { deletedByUserId: actorUserId, bulk: true },
        },
      });
      deleted.push(id);
    } catch (error) {
      if (error instanceof LastAdminGuardError) {
        skipped.push({ userId: id, reason: "skipped: last remaining admin" });
        continue;
      }
      throw error;
    }
  }

  return c.json({ deleted, skipped }, 200);
});

// ─── PATCH /admin/users/:id ───────────────────────────────────────────────────

const patchUserRoute = createRoute({
  method: "patch",
  path: "/admin/users/{id}",
  tags: ["Admin"],
  summary: "Set a user's entity/jobTitle",
  request: {
    params: IdParamSchema,
    body: {
      content: { "application/json": { schema: PatchUserBodySchema } },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: UserDetailSchema } },
      description: "The updated user",
    },
    401: {
      content: { "application/json": { schema: ProblemJsonSchema } },
      description: "No valid session",
    },
    403: {
      content: { "application/json": { schema: ProblemJsonSchema } },
      description: "Caller does not hold the admin role",
    },
    404: {
      content: { "application/json": { schema: ProblemJsonSchema } },
      description: "No user with this id",
    },
  },
});

usersRouter.openapi(patchUserRoute, async (c) => {
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  const actorUserId = c.get("user")!.id;

  const existing = await db.user.findUnique({
    where: { id },
    select: { id: true, email: true, entity: true, jobTitle: true, deletedAt: true },
  });
  // Security-review fix #2 (specs/006-user-invitations): a soft-deleted user
  // has no admin-facing existence (AC-5.4, mirroring GET/DELETE .../:id) — a
  // caller must not be able to mutate a soft-deleted user's attributes.
  if (!existing || existing.deletedAt !== null) {
    return c.json(notFound(c.req.path, `No user with id ${id}`), 404);
  }

  const data: Prisma.UserUpdateInput = {
    ...(body.entity !== undefined ? { entity: body.entity } : {}),
    ...(body.jobTitle !== undefined ? { jobTitle: body.jobTitle } : {}),
  };

  await withAudit({
    affectedUserIds: [id],
    mutate: (tx) => tx.user.update({ where: { id }, data }),
    entry: {
      actorUserId,
      action: "user.update_attributes",
      targetType: "user",
      targetId: id,
      summary: `Updated attributes for ${existing.email}`,
      data: {
        before: { entity: existing.entity, jobTitle: existing.jobTitle },
        after: {
          entity: body.entity !== undefined ? body.entity : existing.entity,
          jobTitle: body.jobTitle !== undefined ? body.jobTitle : existing.jobTitle,
        },
      },
    },
  });

  const updated = await db.user.findUniqueOrThrow({
    where: { id },
    select: {
      id: true,
      name: true,
      email: true,
      entity: true,
      jobTitle: true,
      permissionEpoch: true,
      userRoles: { select: { role: { select: { id: true, name: true } } } },
      userDepartments: {
        select: { department: { select: { id: true, name: true } } },
      },
    },
  });

  return c.json(
    {
      id: updated.id,
      name: updated.name,
      email: updated.email,
      entity: updated.entity,
      jobTitle: updated.jobTitle,
      permissionEpoch: updated.permissionEpoch,
      roles: updated.userRoles.map((userRole) => userRole.role),
      departments: updated.userDepartments.map(
        (userDepartment) => userDepartment.department,
      ),
    },
    200,
  );
});

// ─── PUT /admin/users/:id/roles ───────────────────────────────────────────────

const putUserRolesRoute = createRoute({
  method: "put",
  path: "/admin/users/{id}/roles",
  tags: ["Admin"],
  summary: "(Re)assign a user's direct roles",
  request: {
    params: IdParamSchema,
    body: {
      content: { "application/json": { schema: SetRoleIdsBodySchema } },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: UserDetailSchema } },
      description: "The user with its updated role set",
    },
    401: {
      content: { "application/json": { schema: ProblemJsonSchema } },
      description: "No valid session",
    },
    403: {
      content: { "application/json": { schema: ProblemJsonSchema } },
      description: "Caller does not hold the admin role",
    },
    404: {
      content: { "application/json": { schema: ProblemJsonSchema } },
      description: "No user with this id",
    },
    422: {
      content: { "application/json": { schema: ProblemJsonSchema } },
      description: "An unknown roleId, or this change would remove the last admin (AC-6.4)",
    },
  },
});

usersRouter.openapi(putUserRolesRoute, async (c) => {
  const { id } = c.req.valid("param");
  const { roleIds } = c.req.valid("json");
  const actorUserId = c.get("user")!.id;

  const target = await db.user.findUnique({
    where: { id },
    select: { id: true, email: true, deletedAt: true },
  });
  // Security-review fix #2 (specs/006-user-invitations): a soft-deleted
  // user's roles can never be mutated (AC-5.4) — treat them as gone, same as
  // GET/DELETE .../:id.
  if (!target || target.deletedAt !== null) {
    return c.json(notFound(c.req.path, `No user with id ${id}`), 404);
  }

  const uniqueRoleIds = Array.from(new Set(roleIds));
  const foundRoles = await db.role.findMany({
    where: { id: { in: uniqueRoleIds } },
    select: { id: true, name: true },
  });
  if (foundRoles.length !== uniqueRoleIds.length) {
    const foundIds = new Set(foundRoles.map((role) => role.id));
    const unknown = uniqueRoleIds.filter((roleId) => !foundIds.has(roleId));
    return c.json(
      unprocessable(c.req.path, `Unknown roleId(s): ${unknown.join(", ")}`),
      422,
    );
  }

  const before = await db.userRole.findMany({
    where: { userId: id },
    select: { roleId: true },
  });
  const beforeRoleIds = before.map((row) => row.roleId);

  try {
    await withAudit({
      affectedUserIds: [id],
      mutate: async (tx) => {
        const adminRoleId = await findAdminRoleId(tx);
        if (adminRoleId) {
          const [directBefore, currentDeptIds] = await Promise.all([
            userHasDirectAdmin(tx, id, adminRoleId),
            userDepartmentIds(tx, id),
          ]);
          const deptConfersAdmin = await departmentIdsConferAdmin(
            tx,
            currentDeptIds,
            adminRoleId,
          );
          const isCurrentlyAdmin = directBefore || deptConfersAdmin;
          const willBeAdminAfter = uniqueRoleIds.includes(adminRoleId) || deptConfersAdmin;

          await assertNotRemovingLastAdmin(
            tx,
            adminRoleId,
            id,
            isCurrentlyAdmin,
            willBeAdminAfter,
          );
        }

        await tx.userRole.deleteMany({ where: { userId: id } });
        if (uniqueRoleIds.length > 0) {
          await tx.userRole.createMany({
            data: uniqueRoleIds.map((roleId) => ({
              userId: id,
              roleId,
              assignedByUserId: actorUserId,
            })),
          });
        }
      },
      entry: {
        actorUserId,
        action: "user_role.set",
        targetType: "user",
        targetId: id,
        summary: `Set roles for ${target.email}`,
        data: { before: beforeRoleIds, after: uniqueRoleIds },
      },
    });
  } catch (error) {
    if (error instanceof LastAdminGuardError) {
      return c.json(unprocessable(c.req.path, error.message), 422);
    }
    throw error;
  }

  const updated = await db.user.findUniqueOrThrow({
    where: { id },
    select: {
      id: true,
      name: true,
      email: true,
      entity: true,
      jobTitle: true,
      permissionEpoch: true,
      userRoles: { select: { role: { select: { id: true, name: true } } } },
      userDepartments: {
        select: { department: { select: { id: true, name: true } } },
      },
    },
  });

  return c.json(
    {
      id: updated.id,
      name: updated.name,
      email: updated.email,
      entity: updated.entity,
      jobTitle: updated.jobTitle,
      permissionEpoch: updated.permissionEpoch,
      roles: updated.userRoles.map((userRole) => userRole.role),
      departments: updated.userDepartments.map(
        (userDepartment) => userDepartment.department,
      ),
    },
    200,
  );
});

// ─── PUT /admin/users/:id/departments ─────────────────────────────────────────

const putUserDepartmentsRoute = createRoute({
  method: "put",
  path: "/admin/users/{id}/departments",
  tags: ["Admin"],
  summary: "(Re)assign a user's departments",
  request: {
    params: IdParamSchema,
    body: {
      content: { "application/json": { schema: SetDepartmentIdsBodySchema } },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: UserDetailSchema } },
      description: "The user with its updated department set",
    },
    401: {
      content: { "application/json": { schema: ProblemJsonSchema } },
      description: "No valid session",
    },
    403: {
      content: { "application/json": { schema: ProblemJsonSchema } },
      description: "Caller does not hold the admin role",
    },
    404: {
      content: { "application/json": { schema: ProblemJsonSchema } },
      description: "No user with this id",
    },
    422: {
      content: { "application/json": { schema: ProblemJsonSchema } },
      description:
        "An unknown departmentId, or this change would remove the last admin (AC-6.4)",
    },
  },
});

usersRouter.openapi(putUserDepartmentsRoute, async (c) => {
  const { id } = c.req.valid("param");
  const { departmentIds } = c.req.valid("json");
  const actorUserId = c.get("user")!.id;

  const target = await db.user.findUnique({
    where: { id },
    select: { id: true, email: true, deletedAt: true },
  });
  // Security-review fix #2 (specs/006-user-invitations): a soft-deleted
  // user's departments can never be mutated (AC-5.4) — treat them as gone,
  // same as GET/DELETE .../:id.
  if (!target || target.deletedAt !== null) {
    return c.json(notFound(c.req.path, `No user with id ${id}`), 404);
  }

  const uniqueDepartmentIds = Array.from(new Set(departmentIds));
  const foundDepartments = await db.department.findMany({
    where: { id: { in: uniqueDepartmentIds } },
    select: { id: true },
  });
  if (foundDepartments.length !== uniqueDepartmentIds.length) {
    const foundIds = new Set(foundDepartments.map((department) => department.id));
    const unknown = uniqueDepartmentIds.filter((departmentId) => !foundIds.has(departmentId));
    return c.json(
      unprocessable(c.req.path, `Unknown departmentId(s): ${unknown.join(", ")}`),
      422,
    );
  }

  const before = await db.userDepartment.findMany({
    where: { userId: id },
    select: { departmentId: true },
  });
  const beforeDepartmentIds = before.map((row) => row.departmentId);

  try {
    await withAudit({
      affectedUserIds: [id],
      mutate: async (tx) => {
        const adminRoleId = await findAdminRoleId(tx);
        if (adminRoleId) {
          const directAdmin = await userHasDirectAdmin(tx, id, adminRoleId);
          const [currentDeptConfersAdmin, newDeptConfersAdmin] = await Promise.all([
            departmentIdsConferAdmin(tx, beforeDepartmentIds, adminRoleId),
            departmentIdsConferAdmin(tx, uniqueDepartmentIds, adminRoleId),
          ]);
          const isCurrentlyAdmin = directAdmin || currentDeptConfersAdmin;
          const willBeAdminAfter = directAdmin || newDeptConfersAdmin;

          await assertNotRemovingLastAdmin(
            tx,
            adminRoleId,
            id,
            isCurrentlyAdmin,
            willBeAdminAfter,
          );
        }

        await tx.userDepartment.deleteMany({ where: { userId: id } });
        if (uniqueDepartmentIds.length > 0) {
          await tx.userDepartment.createMany({
            data: uniqueDepartmentIds.map((departmentId) => ({
              userId: id,
              departmentId,
              assignedByUserId: actorUserId,
            })),
          });
        }
      },
      entry: {
        actorUserId,
        action: "user_department.set",
        targetType: "user",
        targetId: id,
        summary: `Set departments for ${target.email}`,
        data: { before: beforeDepartmentIds, after: uniqueDepartmentIds },
      },
    });
  } catch (error) {
    if (error instanceof LastAdminGuardError) {
      return c.json(unprocessable(c.req.path, error.message), 422);
    }
    throw error;
  }

  const updated = await db.user.findUniqueOrThrow({
    where: { id },
    select: {
      id: true,
      name: true,
      email: true,
      entity: true,
      jobTitle: true,
      permissionEpoch: true,
      userRoles: { select: { role: { select: { id: true, name: true } } } },
      userDepartments: {
        select: { department: { select: { id: true, name: true } } },
      },
    },
  });

  return c.json(
    {
      id: updated.id,
      name: updated.name,
      email: updated.email,
      entity: updated.entity,
      jobTitle: updated.jobTitle,
      permissionEpoch: updated.permissionEpoch,
      roles: updated.userRoles.map((userRole) => userRole.role),
      departments: updated.userDepartments.map(
        (userDepartment) => userDepartment.department,
      ),
    },
    200,
  );
});

// ─── GET /admin/users/:id/permissions ─────────────────────────────────────────

const getUserPermissionsRoute = createRoute({
  method: "get",
  path: "/admin/users/{id}/permissions",
  tags: ["Admin"],
  summary: "A user's resolved effective permissions",
  description:
    "Reuses the same resolver as GET /authz/me (T2/T6), scoped to an " +
    "arbitrary user id instead of the caller — lets an admin verify what a " +
    "role/department assignment actually produces (drift fix: /authz/me is " +
    "caller-scoped only). Same response shape as /authz/me.",
  request: { params: IdParamSchema },
  responses: {
    200: {
      content: { "application/json": { schema: EffectivePermissionsSchema } },
      description: "The target user's current epoch, app access, roles, departments and effective permissions",
    },
    401: {
      content: { "application/json": { schema: ProblemJsonSchema } },
      description: "No valid session",
    },
    403: {
      content: { "application/json": { schema: ProblemJsonSchema } },
      description: "Caller does not hold the admin role",
    },
    404: {
      content: { "application/json": { schema: ProblemJsonSchema } },
      description: "No user with this id",
    },
  },
});

usersRouter.openapi(getUserPermissionsRoute, async (c) => {
  const { id } = c.req.valid("param");

  const exists = await db.user.findUnique({
    where: { id },
    select: { id: true, deletedAt: true },
  });
  // Security-review fix #2 (specs/006-user-invitations): a soft-deleted
  // user's effective permissions must never be readable (AC-5.4) — treat
  // them as gone, same as GET/DELETE .../:id.
  if (!exists || exists.deletedAt !== null) {
    return c.json(notFound(c.req.path, `No user with id ${id}`), 404);
  }

  const body = await buildEffectivePermissionsBody(id);
  return c.json(body, 200);
});
