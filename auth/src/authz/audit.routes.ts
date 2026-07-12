/**
 * GET /admin/audit — paginated, reverse-chronological, read-only view of the
 * audit trail (T7, AC-5.2). There is intentionally no PATCH/PUT/DELETE route
 * anywhere in this router — the audit trail is immutable (AC-5.3); the only
 * writer is `withAudit()` (`../authz/audit.ts`), called by every mutating
 * admin route.
 */

import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";
import { requireAuth, sessionMiddleware } from "../auth/auth.middleware";
import { listAuditLog } from "./audit";

// ─── Schemas ──────────────────────────────────────────────────────────────────

const AuditLogActorSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    email: z.string(),
  })
  .nullable();

const AuditLogEntrySchema = z.object({
  id: z.string(),
  actorUserId: z.string().nullable(),
  actor: AuditLogActorSchema,
  action: z.string(),
  targetType: z.string(),
  targetId: z.string().nullable(),
  summary: z.string(),
  data: z.unknown().nullable(),
  createdAt: z.string().datetime(),
});

const AuditLogQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

const AuditLogListResponseSchema = z.object({
  items: z.array(AuditLogEntrySchema),
  page: z.number().int(),
  pageSize: z.number().int(),
  total: z.number().int(),
  totalPages: z.number().int(),
});

const ProblemJsonSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number(),
  detail: z.string(),
  instance: z.string(),
});

// ─── Route ────────────────────────────────────────────────────────────────────

const getAuditLogRoute = createRoute({
  method: "get",
  path: "/admin/audit",
  tags: ["Admin"],
  summary: "List the authorization audit trail",
  description:
    "Paginated, reverse-chronological, read-only history of authorization " +
    "changes (role/department/user_role mutations, etc). No mutate route " +
    "exists for this resource — the trail is immutable (AC-5.3).",
  request: { query: AuditLogQuerySchema },
  responses: {
    200: {
      content: { "application/json": { schema: AuditLogListResponseSchema } },
      description: "A page of audit_log rows, newest first",
    },
    401: {
      content: { "application/json": { schema: ProblemJsonSchema } },
      description: "No valid session",
    },
  },
});

// A dedicated OpenAPIHono instance so a malformed `?page=`/`?pageSize=`
// (or any future validation failure on this router) surfaces as RFC 7807
// Problem JSON rather than @hono/zod-openapi's default `{ success, error }`
// shape — matching the rest of the service (auth/src/index.ts onError).
export const auditRouter = new OpenAPIHono({
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

// sessionMiddleware + requireAuth per plan.md's "all admin routes" baseline.
// TODO(T4): once `requireAdmin` lands (auth/src/auth/auth.middleware.ts or
// authz/), add it here so only admins can list the audit trail — e.g.:
//   auditRouter.use("/admin/audit", sessionMiddleware, requireAuth, requireAdmin);
auditRouter.use("/admin/audit", sessionMiddleware, requireAuth);

auditRouter.openapi(getAuditLogRoute, async (c) => {
  const { page, pageSize } = c.req.valid("query");

  const result = await listAuditLog({ page, pageSize });

  return c.json(
    {
      ...result,
      items: result.items.map((item) => ({
        id: item.id,
        actorUserId: item.actorUserId,
        actor: item.actor,
        action: item.action,
        targetType: item.targetType,
        targetId: item.targetId,
        summary: item.summary,
        data: item.data,
        createdAt: item.createdAt.toISOString(),
      })),
    },
    200,
  );
});
