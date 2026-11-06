/**
 * A purchase order's Bexio order id (specs/021 T9 as renamed by specs/022 T23; AC-3.1, AC-3.2,
 * AC-3.3, AC-1.7, AC-4.5).
 *
 * `PUT /projects/:id/purchase-order/bexio-order` is the ONLY way to write it: it needs the
 * `purchase-order:bexio` capability (the `accounting` role, D35) — not `project:manage`, and not
 * scoped to an entity, so accounting writes it on a purchase order of either one. The id is typed in,
 * free text of at most 64 characters, trimmed (empty clears it); it is not checked against Bexio nor
 * for uniqueness (A24). Nothing else in the module reads it to decide anything: a project is created,
 * started and closed with or without it (AC-3.3), so no other route looks at it.
 *
 * A hand-made project has no purchase order, ever (D38): `404 purchase_order_not_found`.
 *
 * It is a write on the purchase order like any other: `If-Match` required, and it bumps the order's
 * `version` (ADR-0038).
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { PURCHASE_ORDER_BEXIO, authorized, requireCapability } from "../auth/guards";
import type { AuthzVariables } from "../auth/authz.middleware";
import { db } from "../lib/db";
import { IdParams, assertVersion, commonErrors, etag, isRecordNotFound, requireIfMatch, versionConflict } from "../lib/http";
import { notFound, validationHook } from "../lib/problem";
import { PurchaseOrderSchema } from "../projects/projects.schemas";
import { purchaseOrderNotFound, toPurchaseOrderView } from "./view";

export const MAX_BEXIO_ORDER_ID = 64;

/** Trimmed, at most 64 characters once trimmed; empty or blank means "none". The member itself is required. */
const BexioOrderSchema = z
  .object({
    bexioOrderId: z
      .string()
      .transform((value) => value.trim())
      .pipe(z.string().max(MAX_BEXIO_ORDER_ID))
      .transform((value) => (value === "" ? null : value))
      .nullable(),
  })
  .strict();

const json = (schema: z.ZodTypeAny) => ({ content: { "application/json": { schema } } });

const setBexioOrderRoute = createRoute({
  method: "put",
  path: "/projects/{id}/purchase-order/bexio-order",
  tags: ["Purchase orders"],
  summary: "Set, change or clear a purchase order's Bexio order id (purchase-order:bexio, If-Match required)",
  middleware: [...authorized, requireCapability(PURCHASE_ORDER_BEXIO)],
  request: {
    params: IdParams,
    body: { content: { "application/json": { schema: BexioOrderSchema } }, required: true },
  },
  responses: {
    200: { description: "The purchase order with its new Bexio order id", ...json(PurchaseOrderSchema) },
    404: { description: "Project not found, or purchase_order_not_found (a hand-made project has none)" },
    409: { description: "version_conflict" },
    428: { description: "precondition_required" },
    ...commonErrors,
  },
});

export const bexioRouter = new OpenAPIHono<{ Variables: AuthzVariables }>({ defaultHook: validationHook });

bexioRouter.openapi(setBexioOrderRoute, async (c) => {
  const { id } = c.req.valid("param");
  const { bexioOrderId } = c.req.valid("json");
  const expected = requireIfMatch(c);
  const project = await db.project.findUnique({ where: { id }, select: { companyId: true, purchaseOrder: true } });
  if (!project) throw notFound("Project not found");
  const current = project.purchaseOrder;
  if (!current) throw purchaseOrderNotFound();
  assertVersion(current.version, expected);
  // Compare-and-set on the version: of two saves of the same version only one matches.
  const row = await db.purchaseOrder
    .update({
      where: { id: current.id, version: expected },
      data: { bexioOrderId, version: { increment: 1 } },
    })
    .catch(async (error: unknown) => {
      if (!isRecordNotFound(error)) throw error;
      const now = await db.purchaseOrder.findUnique({ where: { id: current.id }, select: { version: true } });
      if (!now) throw purchaseOrderNotFound();
      throw versionConflict(now.version);
    });
  c.header("ETag", etag(row.version));
  // The echo carries the live referent too (specs/022 T26), so it is `no-store` like the rest of the order.
  return c.json(await toPurchaseOrderView(c, row, project.companyId), 200);
});
