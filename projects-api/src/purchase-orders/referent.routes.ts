/**
 * The referent of a purchase order (specs/022 T26; AC-3.6, AC-3.7, AC-3.8; T18 M1, M3, M5, L1, L6): the
 * CRM contact the client names as the person to talk to about the order.
 *
 *   GET   /projects/:id/purchase-order/contacts  the picker: the PROJECT's company's non-archived contacts
 *   PATCH /projects/:id/purchase-order           set, change or clear it (`{ referentContactId }`)
 *
 * Both need `project:manage` for the project's entity (`forbidden` for a caller who manages none, then
 * `out_of_scope` once the record's entity is known): anyone else gets no control and the server refuses
 * (AC-3.7). Reading the referent is the project page's job (`GET /projects/:id`, any access holder).
 *
 * The company is the PROJECT's, read from the row — a client never names one (T18 M1), so the picker is not
 * a CRM contact directory for people who cannot open the CRM. A contact is checked through the CRM's `ids`
 * mode, with the same rule at set and at read (`assertValidReferent`, one identical `referent_invalid` body
 * for every reason: T18 M3, L1). Only the contact's id is stored; its data is read at every opening and never
 * copied, never cached, so every answer here is `Cache-Control: no-store` (T18 M5).
 *
 * A hand-made project has no purchase order, ever (D38): `404 purchase_order_not_found`. The write is one on
 * the purchase order like any other: `If-Match` required, `version` bumped (ADR-0038).
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { PROJECT_MANAGE, assertCanManage, authorized, requireCapability } from "../auth/guards";
import type { AuthzVariables } from "../auth/authz.middleware";
import { assertValidReferent, companyContacts, orCrmUnavailable, referentInvalid } from "../lib/crm";
import { db } from "../lib/db";
import { IdParams, IdSchema, assertVersion, commonErrors, etag, isRecordNotFound, requireIfMatch, versionConflict } from "../lib/http";
import { notFound, validationHook } from "../lib/problem";
import { ContactChoicesSchema, PurchaseOrderSchema } from "../projects/projects.schemas";
import { noStore, purchaseOrderNotFound, toPurchaseOrderView } from "./view";

/** `null` clears the referent. The id's charset is `assertValidReferent`'s to refuse, with the one identical 422. */
const SetReferentSchema = z.object({ referentContactId: IdSchema.nullable() }).strict();

const json = (schema: z.ZodTypeAny) => ({ content: { "application/json": { schema } } });

const listContactsRoute = createRoute({
  method: "get",
  path: "/projects/{id}/purchase-order/contacts",
  tags: ["Purchase orders"],
  summary: "The project company's non-archived CRM contacts, for the referent (project:manage for the project's entity)",
  description:
    "The company is the project's, never the client's (T18 M1). Read live from the CRM, never cached: " +
    "`Cache-Control: no-store`.",
  middleware: [...authorized, requireCapability(PROJECT_MANAGE)],
  request: { params: IdParams },
  responses: {
    200: { description: "The contacts", ...json(ContactChoicesSchema) },
    404: { description: "Project not found, or purchase_order_not_found (a hand-made project has none)" },
    ...commonErrors,
    503: { description: "crm_unavailable or authz_unavailable" },
  },
});

const setReferentRoute = createRoute({
  method: "patch",
  path: "/projects/{id}/purchase-order",
  tags: ["Purchase orders"],
  summary: "Set, change or clear a purchase order's referent (project:manage for the project's entity, If-Match required)",
  description:
    "`referentContactId` must be a non-archived CRM contact of the project's company; `null` clears it. " +
    "Only the id is stored. The answer carries the referent live and is `Cache-Control: no-store`.",
  middleware: [...authorized, requireCapability(PROJECT_MANAGE)],
  request: {
    params: IdParams,
    body: { content: { "application/json": { schema: SetReferentSchema } }, required: true },
  },
  responses: {
    200: { description: "The purchase order with its new referent", ...json(PurchaseOrderSchema) },
    404: { description: "Project not found, or purchase_order_not_found (a hand-made project has none)" },
    409: { description: "version_conflict" },
    422: { description: "referent_invalid (one body for an unknown, other-company, companyless or archived contact)" },
    428: { description: "precondition_required" },
    ...commonErrors,
    503: { description: "crm_unavailable or authz_unavailable" },
  },
});

export const referentRouter = new OpenAPIHono<{ Variables: AuthzVariables }>({ defaultHook: validationHook });

referentRouter.openapi(listContactsRoute, async (c) => {
  const { id } = c.req.valid("param");
  const project = await db.project.findUnique({
    where: { id },
    select: { entity: true, companyId: true, purchaseOrder: { select: { id: true } } },
  });
  if (!project) throw notFound("Project not found");
  assertCanManage(c, project.entity);
  if (!project.purchaseOrder || project.companyId === null) throw purchaseOrderNotFound();
  const { items } = await orCrmUnavailable(companyContacts(project.companyId));
  noStore(c);
  return c.json({ items }, 200);
});

referentRouter.openapi(setReferentRoute, async (c) => {
  const { id } = c.req.valid("param");
  const { referentContactId } = c.req.valid("json");
  const expected = requireIfMatch(c);
  const project = await db.project.findUnique({ where: { id }, select: { entity: true, companyId: true, purchaseOrder: true } });
  if (!project) throw notFound("Project not found");
  assertCanManage(c, project.entity);
  const current = project.purchaseOrder;
  if (!current) throw purchaseOrderNotFound();
  assertVersion(current.version, expected);
  if (referentContactId !== null) {
    // Against the PROJECT's company (fixed at creation), as read from its row: never from the request.
    if (project.companyId === null) throw referentInvalid();
    await assertValidReferent(referentContactId, project.companyId);
  }
  // Compare-and-set on the version: of two saves of the same version only one matches.
  const row = await db.purchaseOrder
    .update({
      where: { id: current.id, version: expected },
      data: { referentContactId, version: { increment: 1 } },
    })
    .catch(async (error: unknown) => {
      if (!isRecordNotFound(error)) throw error;
      const now = await db.purchaseOrder.findUnique({ where: { id: current.id }, select: { version: true } });
      if (!now) throw purchaseOrderNotFound();
      throw versionConflict(now.version);
    });
  // The audit line (T18 L6): which event, which project, who — never the contact's id or any of its data.
  console.log(
    JSON.stringify({ event: referentContactId === null ? "referent.cleared" : "referent.set", projectId: id, actorId: c.get("userId") }),
  );
  c.header("ETag", etag(row.version));
  return c.json(await toPurchaseOrderView(c, row, project.companyId), 200);
});
