/**
 * `POST /activity-host/v1/resolve` (specs/20261110-activities T4; plan.md § Host contract, ADR 20261110-activities-service-access-delegated-to-host): the host half
 * of "may THIS caller read the activities of these companies?", asked by activities-api.
 *
 * Authenticated with the CALLER's own JWT, forwarded verbatim (ADR 20260807-third-party-app-access-decision-endpoint-forwarded-jwt model: no new secret) and
 * resolved live against `auth` on every call (ADR 20260716-refund-api-authorization-enforcing-resource-server): an `auth` outage is a 503, never a
 * `reader`. Like the meeting-host resolve, the route does NOT carry `requireCapability(crm:access)`:
 * a host answers `reader:false` (a 200), not 403, to a caller who may not read.
 *
 *   crm:access held   -> `reader:true`; each company `open` (label, href, `writable:true`,
 *                        `may.write = may.manage = true`) or `missing`; each related contact/deal
 *                        that belongs to one of the ASKED companies, with its `parentId`.
 *                        Reads are open to every holder (ADR 20261101-crm-tool-shape-and-authorization): entity scope plays no part.
 *   crm:access absent -> `reader:false`, no items, no related: nothing about any record leaks,
 *                        not even whether it exists.
 *   `ids: []`         -> only `reader` is answered (no items, no related).
 *
 * A related id that is not found, or whose company is not among the asked ones, is omitted
 * (activities-api turns that into `contact_not_in_company` / `deal_not_in_company`).
 *
 * `entityType: "deal"` (specs/20261112-time-tracking T7, AC-2.3): asked by hours-api, as the caller, to decide who may
 * book time on a deal. Same grant and same silence for a non-reader (`reader:false`, no items, so
 * not even whether a deal exists leaks); a reader gets each deal `open` (any stage — won and lost
 * included, A13) or `missing`, with `involved`: the user ids of the deal's owner and, once an
 * estimate is linked, its technical contact (as the deal view reads it) — the CRM's half of "who is
 * involved"; the activities' half (assignees, participants) is asked of activities-api by hours-api.
 * `related` belongs to companies only: sent with a deal it is a 422. The answer is no wider than
 * `GET /deals/{id}`, which shows every `crm:access` holder the same owner and technical contact
 * (ADR 20261101-crm-tool-shape-and-authorization).
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { jwtMiddleware } from "../auth/jwt.middleware";
import { authzMiddleware, type AuthzVariables } from "../auth/authz.middleware";
import { CRM_ACCESS } from "../auth/guards";
import { hasCapability } from "../authz/conditions";
import { db } from "../lib/db";
import { commonErrors } from "../lib/http";
import { validationHook } from "../lib/problem";

/** The most company ids one call may ask about. */
export const MAX_RESOLVE_IDS = 25;
/** The most related ids of one type one call may ask about. */
export const MAX_RELATED_IDS = 100;

/** Postgres text cannot hold a NUL: refused here as a 422, not left to the database as a 500. */
const Id = z
  .string()
  .min(1)
  .max(64)
  .refine((value) => !value.includes("\u0000"), "Must not contain a NUL character");

const CompanyBody = z
  .object({
    entityType: z.literal("company"),
    ids: z.array(Id).max(MAX_RESOLVE_IDS),
    related: z
      .object({
        contact: z.array(Id).max(MAX_RELATED_IDS).optional(),
        deal: z.array(Id).max(MAX_RELATED_IDS).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

// Strict: `related` is a company-only member, so a deal body carrying it is refused, not ignored.
const DealBody = z.object({ entityType: z.literal("deal"), ids: z.array(Id).max(MAX_RESOLVE_IDS) }).strict();

const ResolveBody = z.discriminatedUnion("entityType", [CompanyBody, DealBody]);

const ResolvedItem = z.object({
  id: z.string(),
  state: z.enum(["open", "missing"]),
  writable: z.boolean().optional(),
  label: z.string().optional(),
  href: z.string().optional(),
  may: z.object({ write: z.boolean(), manage: z.boolean() }).optional(),
});

const ResolvedDealItem = z.union([
  z.object({ id: z.string(), state: z.literal("missing") }),
  z.object({
    id: z.string(),
    state: z.literal("open"),
    writable: z.literal(true),
    label: z.string(),
    href: z.string(),
    may: z.object({ write: z.literal(true), manage: z.literal(true) }),
    involved: z.array(z.string()),
  }),
]);

const RelatedItem = z.object({
  type: z.enum(["contact", "deal"]),
  id: z.string(),
  parentId: z.string(),
  label: z.string(),
  href: z.string(),
});

// Typed as a plain list for the same reason `authorized` is (guards.ts): a literal tuple would
// narrow the handler's context type.
const hostCaller: MiddlewareHandler[] = [jwtMiddleware, authzMiddleware];

const resolveRoute = createRoute({
  method: "post",
  path: "/activity-host/v1/resolve",
  tags: ["Activity host"],
  summary: "May this caller read the activities of these companies or deals? (host contract v1)",
  // jwt + live authz, but NOT crm:access: a caller without it is answered `reader:false`.
  middleware: hostCaller,
  request: { body: { content: { "application/json": { schema: ResolveBody } }, required: true } },
  responses: {
    200: {
      description:
        "reader and one item per distinct id in the order asked; for a company also the related rows found, for a deal each open item carries `involved`",
      content: {
        "application/json": {
          schema: z.union([
            z.object({ reader: z.boolean(), items: z.array(ResolvedItem), related: z.array(RelatedItem) }),
            z.object({ reader: z.boolean(), items: z.array(ResolvedDealItem) }),
          ]),
        },
      },
    },
    ...commonErrors,
  },
});

/** One item per distinct deal id, in the order asked. Reads are open to every holder: no entity scope. */
async function resolveDeals(ids: readonly string[]): Promise<z.infer<typeof ResolvedDealItem>[]> {
  const deals = await db.deal.findMany({
    where: { id: { in: [...ids] } },
    select: {
      id: true,
      title: true,
      ownerUserId: true,
      estimate: { select: { estimateId: true, technicalUserId: true } },
    },
  });
  const byId = new Map(deals.map((deal) => [deal.id, deal]));

  return ids.map((id) => {
    const deal = byId.get(id);
    if (deal === undefined) return { id, state: "missing" as const };
    // The technical contact exactly as the deal view reads it (deals.routes.ts `toViews`): a row whose
    // `estimateId` is "" links no estimate (an admin's override with no estimate, or one left after an
    // unlink), and the `technicalUserId` it still carries is the overriding admin or a past contact.
    const technical = deal.estimate && deal.estimate.estimateId !== "" ? [deal.estimate.technicalUserId] : [];
    return {
      id,
      state: "open" as const,
      writable: true as const,
      label: deal.title,
      href: `/crm/deals/${id}`,
      may: { write: true as const, manage: true as const },
      // People, not roles: the owner who is also the technical contact is listed once.
      involved: [...new Set([deal.ownerUserId, ...technical])],
    };
  });
}

export const activityHostResolveRouter = new OpenAPIHono<{ Variables: AuthzVariables }>({
  defaultHook: validationHook,
});

activityHostResolveRouter.openapi(resolveRoute, async (c) => {
  const body = c.req.valid("json");
  const { permissions } = c.get("authz");
  const reader = hasCapability(permissions, CRM_ACCESS[0], CRM_ACCESS[1]);
  const ids = [...new Set(body.ids)];

  if (body.entityType === "deal") {
    // No grant, or nothing asked about: no lookup at all, so nothing can leak.
    if (!reader || ids.length === 0) return c.json({ reader, items: [] }, 200);
    return c.json({ reader, items: await resolveDeals(ids) }, 200);
  }

  // No grant, or nothing asked about: no lookup at all, so nothing can leak.
  if (!reader || ids.length === 0) return c.json({ reader, items: [], related: [] }, 200);

  const companies = await db.company.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
  const nameOf = new Map(companies.map((company) => [company.id, company.name]));

  const items = ids.map((id) => {
    const label = nameOf.get(id);
    if (label === undefined) return { id, state: "missing" as const };
    return {
      id,
      state: "open" as const,
      writable: true,
      label,
      href: `/crm/companies/${id}`,
      may: { write: true, manage: true },
    };
  });

  const contactIds = [...new Set(body.related?.contact ?? [])];
  const dealIds = [...new Set(body.related?.deal ?? [])];
  const [contacts, deals] = await Promise.all([
    contactIds.length === 0
      ? []
      : db.contact.findMany({
          where: { id: { in: contactIds }, companyId: { in: ids } },
          select: { id: true, companyId: true, firstName: true, lastName: true },
        }),
    dealIds.length === 0
      ? []
      : db.deal.findMany({
          where: { id: { in: dealIds }, companyId: { in: ids } },
          select: { id: true, companyId: true, title: true },
        }),
  ]);

  const related = [
    ...contacts.flatMap((contact) =>
      contact.companyId === null
        ? []
        : [
            {
              type: "contact" as const,
              id: contact.id,
              parentId: contact.companyId,
              label: `${contact.firstName} ${contact.lastName}`.trim(),
              href: `/crm/contacts/${contact.id}`,
            },
          ],
    ),
    ...deals.map((deal) => ({
      type: "deal" as const,
      id: deal.id,
      parentId: deal.companyId,
      label: deal.title,
      href: `/crm/deals/${deal.id}`,
    })),
  ];

  return c.json({ reader, items, related }, 200);
});
