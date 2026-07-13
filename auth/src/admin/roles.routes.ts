/**
 * Admin roles API (T8, specs/004-auth-roles-permissions — refs AC-1.1,
 * AC-2.1–2.4, AC-3.2).
 *
 * `role` is a named bundle of `permission_rule`s (resource+action+optional
 * conditions). An admin creates/renames/deletes roles here and replaces a
 * role's entire rule set via `PUT /admin/roles/:id/rules`; every user
 * holding the role — directly (`user_role`) or via a department that
 * confers it (`department_role` → `user_department`) — inherits those
 * rules through the effective-permissions resolver (T2,
 * `../authz/resolver.ts`). This file only maintains `role`/`permission_rule`
 * rows; it does not touch the resolver directly.
 *
 * Every route is guarded by `sessionMiddleware` + `requireAuth` +
 * `requireAdmin` (T4, AC-1.5) — non-admins get RFC 7807 `403`.
 *
 *   GET    /admin/roles                list roles (rule count + isSystem)
 *   POST   /admin/roles                create a role — `409` duplicate name
 *   GET    /admin/roles/:id            a role + its rules
 *   PATCH  /admin/roles/:id            rename/redescribe — redescribing is
 *                                      allowed for system roles too;
 *                                      renaming a system role is blocked
 *                                      (`422`) because `requireAdmin` gates
 *                                      `/admin/*` on the literal system role
 *                                      name (AC-1.1)
 *   DELETE /admin/roles/:id            `isSystem` role → `422` (AC-1.1)
 *   PUT    /admin/roles/:id/rules      full-replace the role's rule set —
 *                                      body `{ rules }` (named wrapper, per
 *                                      plan.md's wire-shape conventions);
 *                                      every `(resource, action)` MUST be
 *                                      catalog-known (T5,
 *                                      `../authz/catalog.ts`'s
 *                                      `isKnownPermission`) and every
 *                                      condition kind used MUST be in that
 *                                      pair's `supportedConditions`
 *                                      (`isConditionSupported`) — any
 *                                      violation → `422` (AC-2.1, AC-3.2)
 *
 * Every MUTATING route routes its domain write through `withAudit()` (T7,
 * `../authz/audit.ts`) so that, in a single transaction: (1) the write
 * happens, (2) an immutable `audit_log` row is created, and (3)
 * `permissionEpoch` is bumped for every user whose effective permissions may
 * have changed as a result (AC-5.1, AC-4.3):
 *   - `POST` (create): no one holds the brand-new role yet → no affected users.
 *   - `PATCH` (rename/redescribe): does not change what the role GRANTS →
 *     no affected users (mirrors `departments.routes.ts`'s `PATCH`).
 *   - `DELETE`: cascades every `permission_rule`/`user_role`/`department_role`
 *     row for this role (schema.prisma `onDelete: Cascade`) — every current
 *     direct holder AND every member of a department that confers this role
 *     loses its rules, so both sets are affected.
 *   - `PUT .../rules`: changes what the role grants without changing WHO
 *     holds it — the same direct+department-derived holder set is affected.
 *
 * `roleHolderUserIds()` below computes that holder set; it deliberately
 * mirrors `./lastAdminGuard.ts`'s `getEffectiveAdminUserIds` shape (direct
 * `user_role` ∪ department-conferred) but is role-agnostic (any role, not
 * just `admin`) since T8 has no last-admin concern of its own — `admin`
 * role MEMBERSHIP is unaffected by this file (only T10's user/department
 * routes reassign who holds a role); `admin`-role RULE edits here don't
 * change `requireAdmin`'s gate, which checks role membership by name, not
 * by the role's rule contents.
 *
 * COLLISION NOTE: this is a NEW file (`roles.routes.ts`), deliberately
 * separate from `admin.routes.ts` referenced in tasks.md, to avoid touching
 * the same file as the concurrently-implemented T9/T10 department/user
 * routes. Mounting this router on `src/index.ts` (and adding its OpenAPI
 * tag registration) is left to the orchestrator, per this task's scope.
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
import { toRuleConditions } from "../authz/resolver";
import { isConditionSupported, isKnownPermission } from "../authz/catalog";

// ─── Schemas ──────────────────────────────────────────────────────────────────

const ParamsSchema = z.object({
  id: z.string(),
});

const RoleSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  isSystem: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

const RoleListItemSchema = RoleSchema.extend({
  ruleCount: z.number().int(),
});

// A bare array, NOT an { items } envelope: the pagination envelope is reserved
// for /admin/users and /admin/audit only (plan.md wire-shape conventions); the
// admin-ui client's listRoles() expects Role[]. (Same shape as GET /admin/departments.)
const RoleListSchema = z.array(RoleListItemSchema);

const ConditionAttributeSchema = z.object({
  key: z.string(),
  match: z.string(),
});

const RuleConditionsSchema = z.object({
  ownership: z.enum(["own", "any"]).optional(),
  attributes: z.array(ConditionAttributeSchema).optional(),
});

const RoleRuleSchema = z.object({
  id: z.string(),
  resource: z.string(),
  action: z.string(),
  conditions: RuleConditionsSchema.nullable(),
});

const RoleDetailSchema = RoleSchema.extend({
  rules: z.array(RoleRuleSchema),
});

const CreateRoleBodySchema = z.object({
  name: z.string().min(1),
  // Nullable: description is optional (DB column is `String?`) and the client
  // sends `null` for an empty field. Matches UpdateRoleBodySchema below.
  description: z.string().nullable().optional(),
});

const UpdateRoleBodySchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
});

const RuleInputSchema = z.object({
  resource: z.string().min(1),
  action: z.string().min(1),
  conditions: RuleConditionsSchema.nullable().optional(),
});

const SetRoleRulesBodySchema = z.object({
  rules: z.array(RuleInputSchema),
});

const ProblemJsonSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number(),
  detail: z.string(),
  instance: z.string(),
});

type RuleInput = z.infer<typeof RuleInputSchema>;

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

type RoleRow = {
  id: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  createdAt: Date;
  updatedAt: Date;
};

function serializeRole(role: RoleRow) {
  return {
    id: role.id,
    name: role.name,
    description: role.description,
    isSystem: role.isSystem,
    createdAt: role.createdAt.toISOString(),
    updatedAt: role.updatedAt.toISOString(),
  };
}

/**
 * Converts the resolver's `RuleConditions` (readonly, per `../authz/resolver.ts`)
 * into a plain mutable JSON-serializable shape matching `RuleConditionsSchema` —
 * mirrors `users.routes.ts`'s `buildEffectivePermissionsBody` mapping so the
 * two admin surfaces stay consistent.
 */
function serializeConditions(raw: unknown): {
  ownership?: "own" | "any";
  attributes?: { key: string; match: string }[];
} | null {
  const conditions = toRuleConditions(raw);
  if (!conditions) return null;

  return {
    ...(conditions.ownership !== undefined ? { ownership: conditions.ownership } : {}),
    ...(conditions.attributes !== undefined
      ? {
          attributes: conditions.attributes.map((attribute) => ({
            key: attribute.key,
            match: attribute.match,
          })),
        }
      : {}),
  };
}

/** Loads a role plus its rules, or `null` if absent. */
async function loadRoleDetail(id: string) {
  const role = await db.role.findUnique({
    where: { id },
    include: {
      rules: { orderBy: [{ resource: "asc" }, { action: "asc" }] },
    },
  });

  if (!role) return null;

  return {
    ...serializeRole(role),
    rules: role.rules.map((rule) => ({
      id: rule.id,
      resource: rule.resource,
      action: rule.action,
      conditions: serializeConditions(rule.conditions),
    })),
  };
}

/**
 * Every user who currently holds `roleId` — DIRECTLY (`user_role`) OR via a
 * department that confers it (`department_role` → `user_department`). This
 * is the affected-user set for any mutation that changes what the role
 * GRANTS (delete, rules replace) without changing who holds it. Mirrors
 * `./lastAdminGuard.ts`'s `getEffectiveAdminUserIds`, generalized to any
 * role.
 */
async function roleHolderUserIds(roleId: string): Promise<string[]> {
  const [direct, viaDepartment] = await Promise.all([
    db.userRole.findMany({ where: { roleId }, select: { userId: true } }),
    db.userDepartment.findMany({
      where: { department: { departmentRoles: { some: { roleId } } } },
      select: { userId: true },
    }),
  ]);

  return Array.from(
    new Set([
      ...direct.map((row) => row.userId),
      ...viaDepartment.map((row) => row.userId),
    ]),
  );
}

/**
 * Validates every proposed rule against the catalog (T5): the
 * `(resource, action)` pair must be catalog-known (AC-2.1/3.2), and every
 * condition kind the rule uses (`ownership`, and each `attributes[].key`)
 * must be declared in that pair's `supportedConditions` (AC-2.3). Returns
 * one human-readable message per violation (empty = fully valid).
 */
async function findRuleViolations(rules: readonly RuleInput[]): Promise<string[]> {
  const violations: string[] = [];

  for (const rule of rules) {
    const known = await isKnownPermission(rule.resource, rule.action);
    if (!known) {
      violations.push(
        `Unknown permission: "${rule.resource}.${rule.action}" is not registered in the catalog`,
      );
      continue;
    }

    const conditionKinds: string[] = [];
    if (rule.conditions?.ownership !== undefined) {
      conditionKinds.push("ownership");
    }
    for (const attribute of rule.conditions?.attributes ?? []) {
      conditionKinds.push(attribute.key);
    }

    for (const kind of conditionKinds) {
      const supported = await isConditionSupported(rule.resource, rule.action, kind);
      if (!supported) {
        violations.push(
          `Unsupported condition "${kind}" for "${rule.resource}.${rule.action}"`,
        );
      }
    }
  }

  return violations;
}

// ─── Router ───────────────────────────────────────────────────────────────────

// A dedicated OpenAPIHono instance with a `defaultHook` so a malformed body
// (or any other zod validation failure) surfaces as RFC 7807 Problem JSON —
// matching `departments.routes.ts`/`users.routes.ts` and the rest of the
// service (`auth/src/index.ts` onError) rather than @hono/zod-openapi's
// default `{ success, error }` shape.
export const rolesRouter = new OpenAPIHono<{
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

rolesRouter.use("/admin/roles", sessionMiddleware, requireAuth, requireAdmin);
rolesRouter.use("/admin/roles/*", sessionMiddleware, requireAuth, requireAdmin);

// ─── GET /admin/roles ─────────────────────────────────────────────────────────

const listRolesRoute = createRoute({
  method: "get",
  path: "/admin/roles",
  tags: ["Admin"],
  summary: "List roles, with rule counts",
  responses: {
    200: {
      content: { "application/json": { schema: RoleListSchema } },
      description: "All roles",
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

rolesRouter.openapi(listRolesRoute, async (c) => {
  const roles = await db.role.findMany({
    orderBy: { name: "asc" },
    include: { _count: { select: { rules: true } } },
  });

  return c.json(
    roles.map((role) => ({
      ...serializeRole(role),
      ruleCount: role._count.rules,
    })),
    200,
  );
});

// ─── POST /admin/roles ────────────────────────────────────────────────────────

const createRoleRoute = createRoute({
  method: "post",
  path: "/admin/roles",
  tags: ["Admin"],
  summary: "Create a role",
  request: {
    body: {
      content: { "application/json": { schema: CreateRoleBodySchema } },
    },
  },
  responses: {
    201: {
      content: { "application/json": { schema: RoleSchema } },
      description: "The created role",
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
      description: "A role with this name already exists",
    },
  },
});

rolesRouter.openapi(createRoleRoute, async (c) => {
  const body = c.req.valid("json");
  const actorUserId = c.get("user")!.id;

  try {
    const created = await withAudit({
      affectedUserIds: [],
      mutate: (tx) =>
        tx.role.create({
          data: {
            name: body.name,
            ...(body.description !== undefined ? { description: body.description } : {}),
          },
        }),
      entry: (role) => ({
        actorUserId,
        action: "role.create",
        targetType: "role",
        targetId: role.id,
        summary: `Created role "${role.name}"`,
      }),
    });

    return c.json(serializeRole(created), 201);
  } catch (error) {
    if (isUniqueConstraintViolation(error)) {
      const { body: problem, status } = conflict(
        c,
        `A role named "${body.name}" already exists`,
      );
      return c.json(problem, status);
    }
    throw error;
  }
});

// ─── GET /admin/roles/:id ─────────────────────────────────────────────────────

const getRoleRoute = createRoute({
  method: "get",
  path: "/admin/roles/{id}",
  tags: ["Admin"],
  summary: "Get a role, including its rules",
  request: { params: ParamsSchema },
  responses: {
    200: {
      content: { "application/json": { schema: RoleDetailSchema } },
      description: "The role and its rules",
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
      description: "No role with this id",
    },
  },
});

rolesRouter.openapi(getRoleRoute, async (c) => {
  const { id } = c.req.valid("param");

  const detail = await loadRoleDetail(id);
  if (!detail) {
    const { body, status } = notFound(c, `No role with id "${id}"`);
    return c.json(body, status);
  }

  return c.json(detail, 200);
});

// ─── PATCH /admin/roles/:id ───────────────────────────────────────────────────

const patchRoleRoute = createRoute({
  method: "patch",
  path: "/admin/roles/{id}",
  tags: ["Admin"],
  summary: "Rename or redescribe a role (renaming a system role is blocked)",
  request: {
    params: ParamsSchema,
    body: {
      content: { "application/json": { schema: UpdateRoleBodySchema } },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: RoleSchema } },
      description: "The updated role",
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
      description: "No role with this id",
    },
    409: {
      content: { "application/json": { schema: ProblemJsonSchema } },
      description: "A role with this name already exists",
    },
    422: {
      content: { "application/json": { schema: ProblemJsonSchema } },
      description: "This role is a system role and its name cannot be changed",
    },
  },
});

rolesRouter.openapi(patchRoleRoute, async (c) => {
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  const actorUserId = c.get("user")!.id;

  const existing = await db.role.findUnique({ where: { id } });
  if (!existing) {
    const { body: problem, status } = notFound(c, `No role with id "${id}"`);
    return c.json(problem, status);
  }

  // A system role's NAME is load-bearing: `requireAdmin` (and this route's
  // own `ADMIN_ROLE_NAME`-keyed lookups elsewhere) gate `/admin/*` on a
  // literal role-name match. Renaming a system role (most acutely `admin`)
  // would silently lock every admin out of `/admin/*` with no recovery path
  // short of a manual DB fix — so name changes are rejected for system
  // roles; description edits remain allowed (see module doc comment +
  // deleteRoleRoute for the parallel DELETE-blocked-for-system-roles rule).
  if (existing.isSystem && body.name !== undefined && body.name !== existing.name) {
    const { body: problem, status } = unprocessable(
      c,
      `System role "${existing.name}" cannot be renamed`,
    );
    return c.json(problem, status);
  }

  try {
    // Note: redescribing is allowed for system roles too — only DELETE and
    // (as of the guard above) renaming are blocked for them.
    const updated = await withAudit({
      affectedUserIds: [],
      mutate: (tx) =>
        tx.role.update({
          where: { id },
          data: {
            ...(body.name !== undefined ? { name: body.name } : {}),
            ...(body.description !== undefined ? { description: body.description } : {}),
          },
        }),
      entry: (role) => ({
        actorUserId,
        action: "role.update",
        targetType: "role",
        targetId: role.id,
        summary: `Updated role "${role.name}"`,
        data: { before: existing, after: role },
      }),
    });

    return c.json(serializeRole(updated), 200);
  } catch (error) {
    if (isUniqueConstraintViolation(error)) {
      const { body: problem, status } = conflict(
        c,
        `A role named "${body.name}" already exists`,
      );
      return c.json(problem, status);
    }
    throw error;
  }
});

// ─── DELETE /admin/roles/:id ──────────────────────────────────────────────────

const deleteRoleRoute = createRoute({
  method: "delete",
  path: "/admin/roles/{id}",
  tags: ["Admin"],
  summary: "Delete a role (blocked for system roles)",
  request: { params: ParamsSchema },
  responses: {
    204: { description: "The role was deleted" },
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
      description: "No role with this id",
    },
    422: {
      content: { "application/json": { schema: ProblemJsonSchema } },
      description: "This role is a system role and cannot be deleted",
    },
  },
});

rolesRouter.openapi(deleteRoleRoute, async (c) => {
  const { id } = c.req.valid("param");
  const actorUserId = c.get("user")!.id;

  const existing = await db.role.findUnique({ where: { id } });
  if (!existing) {
    const { body, status } = notFound(c, `No role with id "${id}"`);
    return c.json(body, status);
  }

  if (existing.isSystem) {
    const { body, status } = unprocessable(
      c,
      `Role "${existing.name}" is a system role and cannot be deleted`,
    );
    return c.json(body, status);
  }

  // Deleting the role cascades its `permission_rule`/`user_role`/
  // `department_role` rows (schema.prisma onDelete: Cascade) — every
  // current DIRECT holder and every member of a department that confers
  // this role LOSES the rules it granted, so both sets are affected users
  // (AC-4.3).
  const affectedUserIds = await roleHolderUserIds(id);

  await withAudit({
    affectedUserIds,
    mutate: (tx) => tx.role.delete({ where: { id } }),
    entry: {
      actorUserId,
      action: "role.delete",
      targetType: "role",
      targetId: existing.id,
      summary: `Deleted role "${existing.name}"`,
      data: { before: existing },
    },
  });

  return c.body(null, 204);
});

// ─── PUT /admin/roles/:id/rules ───────────────────────────────────────────────

const setRoleRulesRoute = createRoute({
  method: "put",
  path: "/admin/roles/{id}/rules",
  tags: ["Admin"],
  summary: "Full-replace a role's rule set (catalog-validated)",
  request: {
    params: ParamsSchema,
    body: {
      content: { "application/json": { schema: SetRoleRulesBodySchema } },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: RoleDetailSchema } },
      description: "The role, with its now-current rule set",
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
      description: "No role with this id",
    },
    422: {
      content: { "application/json": { schema: ProblemJsonSchema } },
      description:
        "A rule references a (resource, action) not in the catalog, or a " +
        "condition not declared as supported for that pair (AC-2.1/AC-3.2)",
    },
  },
});

rolesRouter.openapi(setRoleRulesRoute, async (c) => {
  const { id } = c.req.valid("param");
  const { rules } = c.req.valid("json");
  const actorUserId = c.get("user")!.id;

  const role = await db.role.findUnique({ where: { id } });
  if (!role) {
    const { body, status } = notFound(c, `No role with id "${id}"`);
    return c.json(body, status);
  }

  const violations = await findRuleViolations(rules);
  if (violations.length > 0) {
    const { body, status } = unprocessable(c, violations.join("; "));
    return c.json(body, status);
  }

  // Changes what the role GRANTS, not who holds it — every current direct
  // and department-derived holder is affected (AC-4.3).
  const affectedUserIds = await roleHolderUserIds(id);

  await withAudit({
    affectedUserIds,
    mutate: async (tx) => {
      await tx.permissionRule.deleteMany({ where: { roleId: id } });
      if (rules.length > 0) {
        await tx.permissionRule.createMany({
          data: rules.map((rule) => ({
            roleId: id,
            resource: rule.resource,
            action: rule.action,
            // Omit the key entirely (rather than an explicit `null`/
            // `undefined`) when there is no conditions object — matches
            // `../authz/audit.ts`'s convention for optional Json columns —
            // letting the nullable column default to NULL (fully
            // unconditional grant).
            ...(rule.conditions !== undefined && rule.conditions !== null
              ? { conditions: rule.conditions as Prisma.InputJsonValue }
              : {}),
          })),
        });
      }
      return null;
    },
    entry: {
      actorUserId,
      action: "permission_rule.set",
      targetType: "role",
      targetId: id,
      summary: `Set rules for role "${role.name}"`,
      data: { rules },
    },
  });

  const detail = await loadRoleDetail(id);
  return c.json(detail!, 200);
});
