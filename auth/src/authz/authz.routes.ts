/**
 * GET /authz/me — the caller's live effective permissions (T6,
 * specs/004-auth-roles-permissions — refs AC-4.1, AC-3.3, AC-4.4).
 *
 * Per ADR-0007 / plan.md "API contracts", permissions are never embedded in
 * the JWT (only identity + `perm_epoch` are) — every consumer resolves the
 * live truth from this endpoint instead, so a revoked/changed grant takes
 * effect on the caller's very next call (AC-4.3), not on token expiry.
 *
 * Response shape: `{ epoch, apps, roles, departments, permissions }`:
 *   - `epoch`       — the caller's current `user.permissionEpoch`, the
 *                      staleness marker bumped by any authz mutation that
 *                      affects them (`bumpPermissionEpoch`/`withAudit`).
 *   - `permissions` — `resolveEffectivePermissions(userId)` (T2): the
 *                      de-duplicated, widest-wins union of the caller's
 *                      direct-role rules and their department-derived rules.
 *                      A (resource, action) pair absent from every role the
 *                      caller holds is simply absent from this array — that
 *                      absence IS "no access" (AC-4.4 default-deny; there is
 *                      never an explicit "denied" entry).
 *   - `apps`        — the subset of `permissions` whose `action` is
 *                      `"access"`, mapped to their `resource` key (AC-3.3 —
 *                      "the suite's apps are themselves resources with an
 *                      `access` action"; this is the shell's US-7
 *                      nav/route-guard convenience so it never has to know
 *                      about the generic permission shape).
 *   - `roles`       — the caller's DIRECTLY assigned role names
 *                      (`user_role` → `role.name`). Department-conferred
 *                      roles are NOT repeated here — their rules are already
 *                      folded into `permissions` via the resolver's union
 *                      (AC-4.2); this field answers "which roles do I hold
 *                      directly", not "which roles' rules apply to me".
 *   - `departments` — the departments the caller directly belongs to
 *                      (`user_department` → `department.name`).
 *
 * Guarded by `sessionMiddleware` + `requireAuth` only (no `requireAdmin`):
 * this is the caller-facing endpoint, there is no `:id` — a caller can only
 * ever resolve their OWN permissions here (the admin equivalent for an
 * arbitrary user, `GET /admin/users/:id/permissions`, is T10's concern).
 */

import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";
import { Effect } from "effect";
import type { User } from "better-auth";
import { requireAuth, sessionMiddleware } from "../auth/auth.middleware";
import { db } from "../lib/db";
import { resolveEffectivePermissions } from "./resolver";

const ACCESS_ACTION = "access";

// ─── Schemas ──────────────────────────────────────────────────────────────────

const ConditionAttributeSchema = z.object({
  key: z.string(),
  match: z.string(),
});

// Mirrors resolver.ts's `RuleConditions` — both members optional, `null`
// (not this schema at all) is the "fully unconditional grant" sentinel.
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

// ─── Route ────────────────────────────────────────────────────────────────────

const getMeRoute = createRoute({
  method: "get",
  path: "/authz/me",
  tags: ["Authorization"],
  summary: "Get the caller's live effective permissions",
  description:
    "Resolves the signed-in caller's effective permissions live — never " +
    "from the JWT (ADR-0007). `apps` is the subset of resources the caller " +
    "holds the `access` action on (AC-3.3). Absence of a (resource,action) " +
    "pair means no access (default-deny, AC-4.4).",
  responses: {
    200: {
      content: { "application/json": { schema: EffectivePermissionsSchema } },
      description:
        "The caller's current epoch, app access, roles, departments and effective permissions",
    },
    401: {
      content: { "application/json": { schema: ProblemJsonSchema } },
      description: "No valid session",
    },
  },
});

// A dedicated OpenAPIHono instance, typed with the session Variables that
// `sessionMiddleware` sets, so `c.get("user")` is known to the handler.
export const authzRouter = new OpenAPIHono<{
  Variables: { user: User | null };
}>();

authzRouter.use("/authz/me", sessionMiddleware, requireAuth);

authzRouter.openapi(getMeRoute, async (c) => {
  // `requireAuth` has already rejected any request with no session, so
  // `user` is guaranteed non-null past this point.
  const userId = c.get("user")!.id;

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
    .filter((permission) => permission.action === ACCESS_ACTION)
    .map((permission) => permission.resource);

  // Re-shape into plain (non-readonly) objects — the resolver's
  // `EffectivePermission`/`RuleConditions` types are `readonly` by design
  // (see resolver.ts), but the OpenAPI response schema's inferred static
  // type is mutable; a structural copy satisfies both without weakening
  // either type.
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

  return c.json(
    {
      epoch: profile.permissionEpoch,
      apps,
      roles: profile.userRoles.map((userRole) => userRole.role.name),
      departments: profile.userDepartments.map(
        (userDepartment) => userDepartment.department.name,
      ),
      permissions: permissionsBody,
    },
    200,
  );
});
