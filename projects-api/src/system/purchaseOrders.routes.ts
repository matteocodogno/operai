/**
 * GET /system/purchase-orders (specs/022-projects-handoff T4 as renamed by T23, AC-3.4; ADR-0060) —
 * the purchase orders of the asked deals, read service-to-service. crm-api's deal page shows the
 * project that carries a deal and its purchase order's Bexio order id, for CRM users who may hold no
 * `projects:access`, so this route trusts a scoped SERVICE credential
 * (`projects.purchase-orders.read`), never a user JWT. It is not behind `authorized`: no user, no
 * `projects:access`, no entity scope.
 *
 *   dealIds  comma-separated CRM deal ids, 1-100, each 1-64 characters.
 *
 * Deals without a purchase order are absent from the answer; the rest come back in the order asked.
 * The select is explicit (id, project name, Bexio order id): no terms, dates, referent, ops-manager
 * or other people leave the module through this route.
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { db } from "../lib/db";
import { problem } from "../lib/problem";
import { createSystemAuthMiddleware, type SystemAuthVariables } from "./systemAuth.middleware";

export const MAX_DEAL_IDS = 100;
const MAX_DEAL_ID_LENGTH = 64;

const DealIdsSchema = z
  .string()
  // +1 per comma: a hard cap before the split, so a huge string is never split.
  .max(MAX_DEAL_IDS * (MAX_DEAL_ID_LENGTH + 1))
  .transform((value) => value.split(",").map((id) => id.trim()))
  .refine((ids) => ids.length <= MAX_DEAL_IDS, `At most ${MAX_DEAL_IDS} deal ids`)
  .refine(
    (ids) => ids.every((id) => id.length >= 1 && id.length <= MAX_DEAL_ID_LENGTH),
    `Every deal id is 1-${MAX_DEAL_ID_LENGTH} characters`,
  );

const QuerySchema = z.object({ dealIds: DealIdsSchema });

const ItemSchema = z.object({
  dealId: z.string(),
  purchaseOrderId: z.string(),
  project: z.object({ id: z.string(), name: z.string() }),
  bexioOrderId: z.string().nullable(),
});

const ProblemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number(),
  detail: z.string(),
  instance: z.string(),
  code: z.string().optional(),
});

const purchaseOrdersRoute = (auth: MiddlewareHandler) =>
  createRoute({
    method: "get",
    path: "/system/purchase-orders",
    tags: ["System"],
    summary: "Purchase orders of the asked deals for a service principal (scope projects.purchase-orders.read)",
    middleware: auth,
    description:
      "Authorization: Bearer <service JWT> from auth (aud = SERVICE_AUDIENCE, scope projects.purchase-orders.read). " +
      `A user JWT is never accepted. \`dealIds\`: 1-${MAX_DEAL_IDS} comma-separated CRM deal ids. ` +
      "Deals without a purchase order are absent from the answer.",
    request: { query: QuerySchema },
    responses: {
      200: {
        description: "The purchase orders, in the order the deals were asked for",
        content: { "application/json": { schema: z.object({ items: z.array(ItemSchema) }) } },
      },
      400: {
        description: "dealIds missing, empty, with an empty or over-long id, or with more than 100 ids",
        content: { "application/json": { schema: ProblemSchema } },
      },
      401: { description: "Missing or invalid service credential (one body for every failure)" },
    },
  });

export const createSystemPurchaseOrdersRouter = (auth: MiddlewareHandler) => {
  const router = new OpenAPIHono<{ Variables: SystemAuthVariables }>({
    defaultHook: (result, c) => {
      if (result.success) return undefined;
      const issue = result.error.issues[0];
      const field = issue?.path.join(".") ?? "";
      return problem({ status: 400, detail: `${field || "query"}: ${issue?.message ?? "Invalid request"}` }, c.req.path);
    },
  });

  // The guard rides on the route (`middleware`), never `router.use("*")`: Hono copies a
  // sub-app's `use("*")` onto the whole app.
  router.openapi(purchaseOrdersRoute(auth), async (c) => {
    const { dealIds } = c.req.valid("query");
    const unique = [...new Set(dealIds)];
    const rows = await db.purchaseOrder.findMany({
      where: { dealId: { in: unique } },
      select: {
        id: true,
        dealId: true,
        bexioOrderId: true,
        project: { select: { id: true, name: true } },
      },
    });
    const byDeal = new Map(rows.map((row) => [row.dealId, row]));
    const items = unique.flatMap((dealId) => {
      const row = byDeal.get(dealId);
      if (!row) return [];
      return [{ dealId, purchaseOrderId: row.id, project: row.project, bexioOrderId: row.bexioOrderId }];
    });
    return c.json({ items }, 200);
  });

  return router;
};

/** The router `src/system/system.routes.ts` mounts: the default JWKS and SERVICE_AUDIENCE. */
export const systemPurchaseOrdersRouter = createSystemPurchaseOrdersRouter(
  createSystemAuthMiddleware({ scope: "projects.purchase-orders.read" }),
);
