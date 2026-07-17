/**
 * GET /authz/resolve — the caller's live effective permissions, for a
 * Bearer-authed RESOURCE SERVER (T1, specs/007-refund-service — refs AC-5.4,
 * AC-6.4, AC-7.5; ADR-0014).
 *
 * A sibling of `GET /authz/me` (spec 004's session-cookie-gated equivalent
 * for the shell), authenticated instead by `resolveAuth.middleware.ts`'s
 * `bearerJwtMiddleware` — because a resource server such as `refund-api`
 * holds no better-auth session cookie, only the caller's own already-verified
 * Bearer JWT, which it forwards here verbatim (ADR-0014 point 1; no new
 * service credential is introduced).
 *
 * Returns the CALLER'S OWN resolution only — same guard posture as
 * `/authz/me`, "never an arbitrary user's": the token's `sub` claim IS the
 * user being resolved; there is no `:id`/query-param seam that could ever
 * target someone else.
 *
 * Response shape: `{ sub, epoch, permissions[<resource,action,conditions>],
 * entity, jobTitle }`. `permissions`/`epoch` are identical in meaning to
 * `/authz/me`'s (see `authz.routes.ts`'s doc comment for the full
 * conditions/default-deny semantics — unchanged here). `entity`/`jobTitle`
 * are the ONE deliberate widening beyond `/authz/me` (ADR-0014 point 1): the
 * caller's own attribute values, so a resource server can evaluate a
 * `{key:"entity", match:"user"}` condition (specs/004, applied by ADR-0015)
 * against a record locally, without a second round trip. Safe because it is
 * (a) the caller's own data, (b) delivered only over this already-
 * authenticated channel, and (c) still never embedded in the JWT itself.
 *
 * No `apps`/`roles`/`departments` convenience fields here (unlike
 * `/authz/me`) — those are shell-UI conveniences (AC-3.3 of spec 004); a
 * resource server only ever needs the raw permission set + its own caller's
 * attributes to gate routes and evaluate conditions.
 */

import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";
import { Effect } from "effect";
import { db } from "../lib/db";
import { resolveEffectivePermissions } from "./resolver";
import { bearerJwtMiddleware, type ResolveAuthVariables } from "./resolveAuth.middleware";

// ─── Schemas ──────────────────────────────────────────────────────────────────
// Mirrors authz.routes.ts's schemas verbatim — the permission/conditions
// shape is identical; only the envelope (sub/entity/jobTitle vs epoch/apps/
// roles/departments) differs.

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

const ResolveResponseSchema = z.object({
  sub: z.string(),
  epoch: z.number().int(),
  permissions: z.array(PermissionSchema),
  entity: z.string().nullable(),
  jobTitle: z.string().nullable(),
});

const ProblemJsonSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number(),
  detail: z.string(),
  instance: z.string(),
});

// ─── Route ────────────────────────────────────────────────────────────────────

const getResolveRoute = createRoute({
  method: "get",
  path: "/authz/resolve",
  tags: ["Authorization"],
  summary: "Resolve the caller's own effective permissions (Bearer-authed, for resource servers)",
  description:
    "Resolves the Bearer token's own caller's effective permissions live — " +
    "the resource-server-facing sibling of the session-cookie-gated " +
    "GET /authz/me (ADR-0014). Never resolves any user other than the " +
    "token's own `sub`. Includes the caller's own `entity`/`jobTitle` " +
    "attributes so a resource server can evaluate ABAC conditions locally.",
  responses: {
    200: {
      content: { "application/json": { schema: ResolveResponseSchema } },
      description: "The caller's current epoch, effective permissions, and own attributes",
    },
    401: {
      content: { "application/json": { schema: ProblemJsonSchema } },
      description: "Missing, invalid, expired, or wrong-issuer/audience Bearer token",
    },
  },
});

export const resolveRouter = new OpenAPIHono<{
  Variables: ResolveAuthVariables;
}>();

resolveRouter.use("/authz/resolve", bearerJwtMiddleware);

resolveRouter.openapi(getResolveRoute, async (c) => {
  // bearerJwtMiddleware has already rejected any request with no valid
  // token, so `callerId` is guaranteed set past this point.
  const callerId = c.get("callerId");

  const [profile, permissions] = await Promise.all([
    db.user.findUniqueOrThrow({
      where: { id: callerId },
      select: { permissionEpoch: true, entity: true, jobTitle: true },
    }),
    Effect.runPromise(resolveEffectivePermissions(callerId)),
  ]);

  // Re-shape into plain (non-readonly) objects — see authz.routes.ts's
  // identical comment: the resolver's types are `readonly` by design, but
  // the OpenAPI response schema's inferred static type is mutable.
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
      sub: callerId,
      epoch: profile.permissionEpoch,
      permissions: permissionsBody,
      entity: profile.entity,
      jobTitle: profile.jobTitle,
    },
    200,
  );
});
