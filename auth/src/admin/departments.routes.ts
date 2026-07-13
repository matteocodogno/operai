/**
 * Admin departments API (spec 004-auth-roles-permissions, T9 — refs AC-1.2).
 *
 * `department` is the "group" primitive: an admin creates a department,
 * confers roles onto it (`PUT /:id/roles`), and adds members to it
 * (`PUT /:id/members`) — every member then inherits the department's
 * conferred roles through the effective-permissions resolver (T2,
 * `../authz/resolver.ts`), which unions DIRECT `user_role` grants with
 * DEPARTMENT-DERIVED grants (`user_department` → `department_role` →
 * `permission_rule`). This file does not touch the resolver directly; it
 * only maintains the `department`/`department_role`/`user_department` rows
 * the resolver reads.
 *
 * Every route is guarded by `sessionMiddleware` + `requireAuth` +
 * `requireAdmin` (T4, AC-1.5) — non-admins get a 403 Problem-JSON.
 *
 * Every MUTATING route (`POST`, `PATCH`, `DELETE`, both `PUT`s) routes its
 * domain write through `withAudit()` (T7, `../authz/audit.ts`) so that, in a
 * single transaction: (1) the write happens, (2) an immutable `audit_log`
 * row is created, and (3) `permissionEpoch` is bumped for every user whose
 * effective permissions may have changed as a result — never a domain
 * mutation without both of those (AC-5.1, AC-4.3).
 *
 * Two wire-shape "drift fixes" from the original design, both already
 * reflected in plan.md's API contracts table:
 *   - `GET /admin/departments/:id` embeds the department's member list (the
 *     admin-ui department detail screen, T19, needs both roles AND members
 *     in one call — AC-1.2 is department-centric).
 *   - `PUT /admin/departments/:id/members` sets a department's members from
 *     the department side (symmetric with the eventual user-side
 *     `PUT /admin/users/:id/departments` in T10) — the plan's "create a
 *     department and add users to it" phrasing of AC-1.2 is naturally
 *     department-centric.
 *
 * Per plan.md's "Wire-shape conventions": collection-set PUTs use a
 * named-field wrapper object, never a bare array — `{ roleIds }` for
 * `PUT /:id/roles`, `{ userIds }` for `PUT /:id/members`.
 *
 * Response shapes MUST match the admin-ui client (T16, `adminApi.ts`), which
 * is authoritative per plan.md ("backend T8-T10 MUST match"): `GET
 * /admin/departments` returns a bare `Department[]` (departments/roles lists
 * are NOT in the `{ items, page, pageSize, total }` pagination convention —
 * only `/admin/users` and `/admin/audit` are), and every route returning a
 * department detail (`GET /:id`, `PUT /:id/roles`, `PUT /:id/members`)
 * reports conferred roles as `roleIds: string[]`, not `roles: {id,name}[]`.
 */

import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";
import type { User } from "better-auth";
import {
  requireAdmin,
  requireAuth,
  sessionMiddleware,
} from "../auth/auth.middleware";
import { db } from "../lib/db";
import { Prisma } from "../lib/generated/prisma/client";
import { withAudit } from "../authz/audit";
import { ADMIN_ROLE_NAME, findAdminRoleId } from "./lastAdminGuard";

// ─── Schemas ──────────────────────────────────────────────────────────────────

const ParamsSchema = z.object({
  id: z.string(),
});

const DepartmentSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

const DepartmentMemberSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
});

const DepartmentDetailSchema = DepartmentSchema.extend({
  roleIds: z.array(z.string()),
  members: z.array(DepartmentMemberSchema),
});

const DepartmentListSchema = z.array(DepartmentSchema);

const CreateDepartmentBodySchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
});

const UpdateDepartmentBodySchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
});

const SetDepartmentRolesBodySchema = z.object({
  roleIds: z.array(z.string()),
});

const SetDepartmentMembersBodySchema = z.object({
  userIds: z.array(z.string()),
});

const ProblemJsonSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number(),
  detail: z.string(),
  instance: z.string(),
});

// ─── Problem-JSON helpers ─────────────────────────────────────────────────────

function notFound(c: { req: { path: string } }, detail: string) {
  return {
    body: {
      type: "https://httpstatuses.com/404",
      title: "Not Found",
      status: 404,
      detail,
      instance: c.req.path,
    } as const,
    status: 404 as const,
  };
}

function conflict(c: { req: { path: string } }, detail: string) {
  return {
    body: {
      type: "https://httpstatuses.com/409",
      title: "Conflict",
      status: 409,
      detail,
      instance: c.req.path,
    } as const,
    status: 409 as const,
  };
}

function unprocessable(c: { req: { path: string } }, detail: string) {
  return {
    body: {
      type: "https://httpstatuses.com/422",
      title: "Unprocessable Entity",
      status: 422,
      detail,
      instance: c.req.path,
    } as const,
    status: 422 as const,
  };
}

/** True when `error` is a Prisma unique-constraint violation (P2002). */
function isUniqueConstraintViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}

// ─── Serialization helpers ────────────────────────────────────────────────────

type DepartmentRow = {
  id: string;
  name: string;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function serializeDepartment(department: DepartmentRow) {
  return {
    id: department.id,
    name: department.name,
    description: department.description,
    createdAt: department.createdAt.toISOString(),
    updatedAt: department.updatedAt.toISOString(),
  };
}

/** Loads a department plus its conferred roles and members, or `null` if absent. */
async function loadDepartmentDetail(id: string) {
  const department = await db.department.findUnique({
    where: { id },
    include: {
      departmentRoles: { select: { role: { select: { id: true } } } },
      members: {
        select: {
          user: { select: { id: true, name: true, email: true } },
        },
      },
    },
  });

  if (!department) return null;

  return {
    ...serializeDepartment(department),
    roleIds: department.departmentRoles.map((dr) => dr.role.id),
    members: department.members.map((m) => ({
      id: m.user.id,
      name: m.user.name,
      email: m.user.email,
    })),
  };
}

/** Current member user ids of a department (empty array if the department doesn't exist). */
async function currentMemberIds(departmentId: string): Promise<string[]> {
  const rows = await db.userDepartment.findMany({
    where: { departmentId },
    select: { userId: true },
  });
  return rows.map((r) => r.userId);
}

// ─── Routes ───────────────────────────────────────────────────────────────────

const listDepartmentsRoute = createRoute({
  method: "get",
  path: "/admin/departments",
  tags: ["Admin"],
  summary: "List departments",
  responses: {
    200: {
      content: { "application/json": { schema: DepartmentListSchema } },
      description: "All departments",
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

const createDepartmentRoute = createRoute({
  method: "post",
  path: "/admin/departments",
  tags: ["Admin"],
  summary: "Create a department",
  request: {
    body: {
      content: { "application/json": { schema: CreateDepartmentBodySchema } },
    },
  },
  responses: {
    201: {
      content: { "application/json": { schema: DepartmentSchema } },
      description: "The created department",
    },
    401: {
      content: { "application/json": { schema: ProblemJsonSchema } },
      description: "No valid session",
    },
    403: {
      content: { "application/json": { schema: ProblemJsonSchema } },
      description: "Caller does not hold the admin role",
    },
    409: {
      content: { "application/json": { schema: ProblemJsonSchema } },
      description: "A department with this name already exists",
    },
  },
});

const getDepartmentRoute = createRoute({
  method: "get",
  path: "/admin/departments/{id}",
  tags: ["Admin"],
  summary: "Get a department, including its conferred roles and member list",
  request: { params: ParamsSchema },
  responses: {
    200: {
      content: { "application/json": { schema: DepartmentDetailSchema } },
      description: "The department, its conferred roles, and its members",
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
      description: "No department with this id",
    },
  },
});

const patchDepartmentRoute = createRoute({
  method: "patch",
  path: "/admin/departments/{id}",
  tags: ["Admin"],
  summary: "Rename or redescribe a department",
  request: {
    params: ParamsSchema,
    body: {
      content: { "application/json": { schema: UpdateDepartmentBodySchema } },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: DepartmentSchema } },
      description: "The updated department",
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
      description: "No department with this id",
    },
    409: {
      content: { "application/json": { schema: ProblemJsonSchema } },
      description: "A department with this name already exists",
    },
  },
});

const deleteDepartmentRoute = createRoute({
  method: "delete",
  path: "/admin/departments/{id}",
  tags: ["Admin"],
  summary: "Delete a department",
  request: { params: ParamsSchema },
  responses: {
    204: { description: "The department was deleted" },
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
      description: "No department with this id",
    },
  },
});

const setDepartmentRolesRoute = createRoute({
  method: "put",
  path: "/admin/departments/{id}/roles",
  tags: ["Admin"],
  summary: "Set the roles a department confers to its members",
  request: {
    params: ParamsSchema,
    body: {
      content: {
        "application/json": { schema: SetDepartmentRolesBodySchema },
      },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: DepartmentDetailSchema } },
      description: "The department, with its now-current conferred roles",
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
      description: "No department with this id",
    },
    422: {
      content: { "application/json": { schema: ProblemJsonSchema } },
      description:
        "One or more roleIds do not exist, or roleIds includes the " +
        "`admin` role (which must stay direct-only, never " +
        "department-conferred)",
    },
  },
});

const setDepartmentMembersRoute = createRoute({
  method: "put",
  path: "/admin/departments/{id}/members",
  tags: ["Admin"],
  summary: "Set a department's members from the department side",
  request: {
    params: ParamsSchema,
    body: {
      content: {
        "application/json": { schema: SetDepartmentMembersBodySchema },
      },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: DepartmentDetailSchema } },
      description: "The department, with its now-current member list",
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
      description: "No department with this id",
    },
    422: {
      content: { "application/json": { schema: ProblemJsonSchema } },
      description: "One or more userIds do not exist",
    },
  },
});

// A dedicated OpenAPIHono instance with a `defaultHook` so a malformed body
// (or any other zod validation failure) surfaces as RFC 7807 Problem JSON —
// matching `auditRouter` (`../authz/audit.routes.ts`) and the rest of the
// service (`auth/src/index.ts` onError) rather than @hono/zod-openapi's
// default `{ success, error }` shape.
export const departmentsRouter = new OpenAPIHono<{
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

departmentsRouter.use("/admin/departments", sessionMiddleware, requireAuth, requireAdmin);
departmentsRouter.use(
  "/admin/departments/*",
  sessionMiddleware,
  requireAuth,
  requireAdmin,
);

// ─── GET /admin/departments ───────────────────────────────────────────────────

departmentsRouter.openapi(listDepartmentsRoute, async (c) => {
  const departments = await db.department.findMany({
    orderBy: { name: "asc" },
  });

  return c.json(departments.map(serializeDepartment), 200);
});

// ─── POST /admin/departments ──────────────────────────────────────────────────

departmentsRouter.openapi(createDepartmentRoute, async (c) => {
  const body = c.req.valid("json");
  const actorUserId = c.get("user")!.id;

  try {
    const created = await withAudit({
      affectedUserIds: [],
      mutate: (tx) =>
        tx.department.create({
          data: {
            name: body.name,
            ...(body.description !== undefined
              ? { description: body.description }
              : {}),
          },
        }),
      entry: (department) => ({
        actorUserId,
        action: "department.create",
        targetType: "department",
        targetId: department.id,
        summary: `Created department "${department.name}"`,
      }),
    });

    return c.json(serializeDepartment(created), 201);
  } catch (error) {
    if (isUniqueConstraintViolation(error)) {
      const { body: problem, status } = conflict(
        c,
        `A department named "${body.name}" already exists`,
      );
      return c.json(problem, status);
    }
    throw error;
  }
});

// ─── GET /admin/departments/:id ────────────────────────────────────────────────

departmentsRouter.openapi(getDepartmentRoute, async (c) => {
  const { id } = c.req.valid("param");

  const detail = await loadDepartmentDetail(id);
  if (!detail) {
    const { body, status } = notFound(c, `No department with id "${id}"`);
    return c.json(body, status);
  }

  return c.json(detail, 200);
});

// ─── PATCH /admin/departments/:id ───────────────────────────────────────────────

departmentsRouter.openapi(patchDepartmentRoute, async (c) => {
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  const actorUserId = c.get("user")!.id;

  const existing = await db.department.findUnique({ where: { id } });
  if (!existing) {
    const { body: problem, status } = notFound(
      c,
      `No department with id "${id}"`,
    );
    return c.json(problem, status);
  }

  try {
    const updated = await withAudit({
      affectedUserIds: [],
      mutate: (tx) =>
        tx.department.update({
          where: { id },
          data: {
            ...(body.name !== undefined ? { name: body.name } : {}),
            ...(body.description !== undefined
              ? { description: body.description }
              : {}),
          },
        }),
      entry: (department) => ({
        actorUserId,
        action: "department.update",
        targetType: "department",
        targetId: department.id,
        summary: `Updated department "${department.name}"`,
        data: { before: existing, after: department },
      }),
    });

    return c.json(serializeDepartment(updated), 200);
  } catch (error) {
    if (isUniqueConstraintViolation(error)) {
      const { body: problem, status } = conflict(
        c,
        `A department named "${body.name}" already exists`,
      );
      return c.json(problem, status);
    }
    throw error;
  }
});

// ─── DELETE /admin/departments/:id ──────────────────────────────────────────────

departmentsRouter.openapi(deleteDepartmentRoute, async (c) => {
  const { id } = c.req.valid("param");
  const actorUserId = c.get("user")!.id;

  const existing = await db.department.findUnique({ where: { id } });
  if (!existing) {
    const { body, status } = notFound(c, `No department with id "${id}"`);
    return c.json(body, status);
  }

  // Deleting the department cascades its `department_role` and
  // `user_department` rows (schema.prisma onDelete: Cascade) — every
  // current member LOSES the roles it conferred, so each of them is an
  // affected user (AC-4.3).
  const memberIds = await currentMemberIds(id);

  await withAudit({
    affectedUserIds: memberIds,
    mutate: (tx) => tx.department.delete({ where: { id } }),
    entry: {
      actorUserId,
      action: "department.delete",
      targetType: "department",
      targetId: existing.id,
      summary: `Deleted department "${existing.name}"`,
      data: { before: existing },
    },
  });

  return c.body(null, 204);
});

// ─── PUT /admin/departments/:id/roles ──────────────────────────────────────────

departmentsRouter.openapi(setDepartmentRolesRoute, async (c) => {
  const { id } = c.req.valid("param");
  const { roleIds } = c.req.valid("json");
  const actorUserId = c.get("user")!.id;

  const department = await db.department.findUnique({ where: { id } });
  if (!department) {
    const { body, status } = notFound(c, `No department with id "${id}"`);
    return c.json(body, status);
  }

  const uniqueRoleIds = Array.from(new Set(roleIds));
  if (uniqueRoleIds.length > 0) {
    const foundRoles = await db.role.findMany({
      where: { id: { in: uniqueRoleIds } },
      select: { id: true },
    });
    const foundIds = new Set(foundRoles.map((r) => r.id));
    const missing = uniqueRoleIds.filter((roleId) => !foundIds.has(roleId));
    if (missing.length > 0) {
      const { body, status } = unprocessable(
        c,
        `Unknown role id(s): ${missing.join(", ")}`,
      );
      return c.json(body, status);
    }

    // The `admin` role must stay DIRECT-only (`user_role`), never
    // department-conferred. `requireAdmin` (auth.middleware.ts) counts only
    // DIRECT admin membership when gating `/admin/*`, but
    // `lastAdminGuard.getEffectiveAdminUserIds()` counts department-conferred
    // admins as effective when deciding whether a change would remove the
    // "last admin" — so conferring `admin` here would let the guard believe
    // a department's members are covering admin access while those members
    // can never actually pass `requireAdmin` and authenticate `/admin/*`.
    // Rejecting the confer keeps the two admin-counting paths consistent.
    const adminRoleId = await findAdminRoleId(db);
    if (adminRoleId !== null && uniqueRoleIds.includes(adminRoleId)) {
      const { body, status } = unprocessable(
        c,
        `The "${ADMIN_ROLE_NAME}" role cannot be conferred via a department`,
      );
      return c.json(body, status);
    }
  }

  // Setting the roles a department confers changes the effective
  // permissions of every CURRENT member (AC-4.3) — the member set itself is
  // unaffected by this route.
  const memberIds = await currentMemberIds(id);

  await withAudit({
    affectedUserIds: memberIds,
    mutate: async (tx) => {
      await tx.departmentRole.deleteMany({ where: { departmentId: id } });
      if (uniqueRoleIds.length > 0) {
        await tx.departmentRole.createMany({
          data: uniqueRoleIds.map((roleId) => ({ departmentId: id, roleId })),
        });
      }
      return null;
    },
    entry: {
      actorUserId,
      action: "department_role.set",
      targetType: "department",
      targetId: id,
      summary: `Set roles for department "${department.name}"`,
      data: { roleIds: uniqueRoleIds },
    },
  });

  const detail = await loadDepartmentDetail(id);
  return c.json(detail!, 200);
});

// ─── PUT /admin/departments/:id/members ────────────────────────────────────────

departmentsRouter.openapi(setDepartmentMembersRoute, async (c) => {
  const { id } = c.req.valid("param");
  const { userIds } = c.req.valid("json");
  const actorUserId = c.get("user")!.id;

  const department = await db.department.findUnique({ where: { id } });
  if (!department) {
    const { body, status } = notFound(c, `No department with id "${id}"`);
    return c.json(body, status);
  }

  const uniqueUserIds = Array.from(new Set(userIds));
  if (uniqueUserIds.length > 0) {
    const foundUsers = await db.user.findMany({
      where: { id: { in: uniqueUserIds } },
      select: { id: true },
    });
    const foundIds = new Set(foundUsers.map((u) => u.id));
    const missing = uniqueUserIds.filter((userId) => !foundIds.has(userId));
    if (missing.length > 0) {
      const { body, status } = unprocessable(
        c,
        `Unknown user id(s): ${missing.join(", ")}`,
      );
      return c.json(body, status);
    }
  }

  const previousMemberIds = await currentMemberIds(id);
  // Both the members being REMOVED (they lose the department's conferred
  // roles) and the members being ADDED (they gain them) are affected —
  // union of before/after, deduplicated by withAudit itself.
  const affectedUserIds = Array.from(
    new Set([...previousMemberIds, ...uniqueUserIds]),
  );

  await withAudit({
    affectedUserIds,
    mutate: async (tx) => {
      await tx.userDepartment.deleteMany({ where: { departmentId: id } });
      if (uniqueUserIds.length > 0) {
        await tx.userDepartment.createMany({
          data: uniqueUserIds.map((userId) => ({
            userId,
            departmentId: id,
            assignedByUserId: actorUserId,
          })),
        });
      }
      return null;
    },
    entry: {
      actorUserId,
      action: "department_member.set",
      targetType: "department",
      targetId: id,
      summary: `Set members for department "${department.name}"`,
      data: { userIds: uniqueUserIds },
    },
  });

  const detail = await loadDepartmentDetail(id);
  return c.json(detail!, 200);
});
