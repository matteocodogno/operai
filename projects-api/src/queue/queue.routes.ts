/**
 * The to-start queue (specs/022-projects-handoff T6; AC-1.1, AC-1.6, AC-2.1, AC-2.2, A20, A26):
 * the won deals no project has taken yet.
 *
 * Nothing is stored or synced. Every read asks crm-api for its won deals (`wonDeals()`, as the
 * service principal, live) and subtracts the deals that already have a purchase order here, so a deal
 * leaves the queue the moment it is taken or reopened in the CRM and is back when it is won again
 * — by construction, with no event to miss. Taking a deal is `take.routes.ts`. A summary carries no amount, currency, owner
 * or notes: crm-api's `DealSummary` has none and this route copies only named members (D14).
 *
 * specs/022 T24: reading the queue needs `handoff:take` under ANY entity (sales, admin: AC-1.1, AC-1.9) —
 * a sales user of one entity reads the whole queue and takes its own entity's deals only. Two sibling
 * routes serve the take's form, both gated like the take and both deriving the entity / company from
 * the live deal (T18 M1): `GET /queue/{dealId}/ops-managers` (auth's holders of `purchase-order:receive`)
 * and `GET /queue/{dealId}/contacts` (the deal company's CRM contacts, `no-store`).
 *
 * crm-api down is a 503 `crm_unavailable`: unlike a project page, the queue has nothing to show
 * without the CRM. `truncated` is crm-api's: it returns the newest 500 won deals (A26, deferred
 * pagination), so `q` and `entity` filter within those.
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { HANDOFF_TAKE, authorized, requireCapability } from "../auth/guards";
import type { AuthzVariables } from "../auth/authz.middleware";
import { companyContacts, orCrmUnavailable, wonDeals } from "../lib/crm";
import { db } from "../lib/db";
import { opsManagerCandidates } from "../lib/holders";
import { EntitySchema, IdSchema, commonErrors } from "../lib/http";
import { validationHook } from "../lib/problem";
import { CompanyRefSchema } from "../projects/projects.schemas";
import { loadDealForCaller, loadTakeableDeal } from "./deal";

const QueueQuery = z.object({
  /** Case-insensitive substring of the deal's title or its company's name. */
  q: z.string().max(200).optional(),
  entity: EntitySchema.optional(),
});

const QueueItemSchema = z.object({
  dealId: z.string(),
  title: z.string(),
  entity: EntitySchema,
  company: CompanyRefSchema,
  wonAt: z.string().nullable(),
  estimate: z.object({ id: z.string(), name: z.string() }).nullable(),
});

const QueueSchema = z.object({ items: z.array(QueueItemSchema), truncated: z.boolean() });

const getQueueRoute = createRoute({
  method: "get",
  path: "/queue",
  tags: ["Queue"],
  summary: "The to-start queue: won deals without a purchase order, newest win first (handoff:take, any entity)",
  middleware: [...authorized, requireCapability(HANDOFF_TAKE)],
  request: { query: QueueQuery },
  responses: {
    200: { description: "The queue", content: { "application/json": { schema: QueueSchema } } },
    ...commonErrors,
    503: { description: "crm_unavailable (the queue is read live from the CRM) or authz_unavailable" },
  },
});

const DealParams = z.object({ dealId: IdSchema });

const OpsManagersSchema = z.object({
  items: z.array(z.object({ id: z.string(), name: z.string(), admin: z.boolean() })),
  prefillId: z.string().nullable(),
});

const ContactsSchema = z.object({
  items: z.array(z.object({ id: z.string(), name: z.string(), jobTitle: z.string().nullable() })),
});

const getOpsManagersRoute = createRoute({
  method: "get",
  path: "/queue/{dealId}/ops-managers",
  tags: ["Queue"],
  summary: "Who may be the ops-manager of a purchase order taken from this deal (handoff:take and project:manage for its entity)",
  description:
    "The holders of purchase-order:receive for the deal's entity, read live from auth with the caller's token; " +
    "`admin` marks an unconditioned grant (the admins), who come last. `prefillId` is the only non-admin holder " +
    "when there is exactly one, else null. Never cached.",
  middleware: [...authorized, requireCapability(HANDOFF_TAKE)],
  request: { params: DealParams },
  responses: {
    200: { description: "The candidates", content: { "application/json": { schema: OpsManagersSchema } } },
    404: { description: "deal_not_found" },
    ...commonErrors,
    503: { description: "crm_unavailable, identity_unavailable (auth cannot answer: never an empty picker) or authz_unavailable" },
  },
});

const getContactsRoute = createRoute({
  method: "get",
  path: "/queue/{dealId}/contacts",
  tags: ["Queue"],
  summary: "The deal's company's non-archived CRM contacts, for the referent (handoff:take and project:manage for its entity)",
  description:
    "The company is the live deal's, never the client's (T18 M1). Read live from the CRM, never cached: " +
    "`Cache-Control: no-store`. A deal that is taken or no longer won is refused.",
  middleware: [...authorized, requireCapability(HANDOFF_TAKE)],
  request: { params: DealParams },
  responses: {
    200: { description: "The contacts", content: { "application/json": { schema: ContactsSchema } } },
    404: { description: "deal_not_found" },
    409: { description: "deal_taken or deal_not_won" },
    ...commonErrors,
    503: { description: "crm_unavailable or authz_unavailable" },
  },
});

export const queueRouter = new OpenAPIHono<{ Variables: AuthzVariables }>({ defaultHook: validationHook });

queueRouter.openapi(getQueueRoute, async (c) => {
  const { q, entity } = c.req.valid("query");
  const { items: won, truncated } = await orCrmUnavailable(wonDeals());

  const taken = new Set(
    (
      await db.purchaseOrder.findMany({
        where: { dealId: { in: won.map((deal) => deal.id) } },
        select: { dealId: true },
      })
    ).map((order) => order.dealId),
  );

  const needle = q?.trim().toLowerCase();
  const items = won
    .filter((deal) => !taken.has(deal.id))
    .filter((deal) => entity === undefined || deal.entity === entity)
    .filter(
      (deal) =>
        !needle || deal.title.toLowerCase().includes(needle) || deal.company.name.toLowerCase().includes(needle),
    )
    .map((deal) => ({
      dealId: deal.id,
      title: deal.title,
      entity: deal.entity,
      company: { id: deal.company.id, name: deal.company.name },
      wonAt: deal.wonAt,
      estimate: deal.estimate === null ? null : { id: deal.estimate.id, name: deal.estimate.name },
    }));

  return c.json({ items, truncated }, 200);
});

queueRouter.openapi(getOpsManagersRoute, async (c) => {
  const { dealId } = c.req.valid("param");
  const deal = await loadDealForCaller(c, dealId);
  const holders = await opsManagerCandidates(c.req.header("Authorization") ?? "", deal.entity);
  // Role holders first (auth's name order), admins after; the prefill counts role holders only (AC-4.1).
  const roleHolders = holders.filter((holder) => !holder.unconditioned);
  const admins = holders.filter((holder) => holder.unconditioned);
  const items = [...roleHolders, ...admins].map((holder) => ({ id: holder.id, name: holder.name, admin: holder.unconditioned }));
  const only = roleHolders.length === 1 ? roleHolders[0] : undefined;
  c.header("Cache-Control", "no-store");
  return c.json({ items, prefillId: only ? only.id : null }, 200);
});

queueRouter.openapi(getContactsRoute, async (c) => {
  const { dealId } = c.req.valid("param");
  // The company is the live deal's: a taken or reopened deal gives its company's contacts to nobody.
  const deal = await loadTakeableDeal(c, dealId);
  const { items } = await orCrmUnavailable(companyContacts(deal.company.id));
  c.header("Cache-Control", "no-store");
  return c.json({ items }, 200);
});
