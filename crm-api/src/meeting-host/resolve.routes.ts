/**
 * `POST /meeting-host/v1/resolve` (specs/021 T7; plan.md § Host integration
 * contract, ADR-0059): the host half of "may THIS caller open these entities?".
 *
 * Authenticated with the CALLER's own JWT, forwarded verbatim by meetings-api
 * (ADR-0035 model: no new secret), and resolved live against `auth` on every
 * call (ADR-0014): an `auth` outage is a 503, never an `open`. The route
 * deliberately does NOT carry `requireCapability(crm:access)`: a host answers
 * `closed` (a 200), not 403, to a caller who may not open the entity, so one
 * call answers a mixed batch.
 *
 *   crm:access held    -> existing deal: `open` + title + href + hostVisible;
 *                         unknown id: `missing`. Reads are open to every holder
 *                         (ADR-0052), so entity scope plays no part here.
 *   crm:access absent  -> existing deal: `closed`; unknown id: `missing`. Neither
 *                         carries a title (the accepted existence oracle: ids
 *                         are unguessable cuids and nothing about the deal leaks).
 *
 * `hostVisible` is what this host requires for a host-visible meeting:
 * `deal:financials` (AC-5.6, ADR-0054). It is only ever present on `open`.
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { jwtMiddleware } from "../auth/jwt.middleware";
import { authzMiddleware, type AuthzVariables } from "../auth/authz.middleware";
import { CRM_ACCESS, canSeeFinancials } from "../auth/guards";
import { hasCapability } from "../authz/conditions";
import { db } from "../lib/db";
import { commonErrors } from "../lib/http";
import { validationHook } from "../lib/problem";

/** The most ids one call may ask about (ADR-0059). */
export const MAX_RESOLVE_IDS = 25;

const ResolveBody = z
  .object({
    entityType: z.literal("deal"),
    ids: z.array(z.string().min(1).max(64)).min(1).max(MAX_RESOLVE_IDS),
  })
  .strict();

const ResolvedItem = z.object({
  id: z.string(),
  state: z.enum(["open", "closed", "missing"]),
  title: z.string().optional(),
  href: z.string().optional(),
  hostVisible: z.boolean().optional(),
});

// Typed as a plain list for the same reason `authorized` is (guards.ts): a literal tuple would
// narrow the handler's context type.
const hostCaller: MiddlewareHandler[] = [jwtMiddleware, authzMiddleware];

const resolveRoute = createRoute({
  method: "post",
  path: "/meeting-host/v1/resolve",
  tags: ["Meeting host"],
  summary: "May this caller open these deals? (host contract v1)",
  // jwt + live authz, but NOT crm:access: a caller without it is answered `closed`.
  middleware: hostCaller,
  request: { body: { content: { "application/json": { schema: ResolveBody } }, required: true } },
  responses: {
    200: {
      description: "One item per distinct id, in the order asked",
      content: { "application/json": { schema: z.object({ items: z.array(ResolvedItem) }) } },
    },
    ...commonErrors,
  },
});

export const meetingHostResolveRouter = new OpenAPIHono<{ Variables: AuthzVariables }>({
  defaultHook: validationHook,
});

meetingHostResolveRouter.openapi(resolveRoute, async (c) => {
  const { ids: asked } = c.req.valid("json");
  const ids = [...new Set(asked)];
  const { permissions } = c.get("authz");
  const mayOpen = hasCapability(permissions, CRM_ACCESS[0], CRM_ACCESS[1]);
  const hostVisible = canSeeFinancials(c);

  const deals = await db.deal.findMany({ where: { id: { in: ids } }, select: { id: true, title: true } });
  const byId = new Map(deals.map((deal) => [deal.id, deal.title]));

  const items = ids.map((id) => {
    const title = byId.get(id);
    if (title === undefined) return { id, state: "missing" as const };
    if (!mayOpen) return { id, state: "closed" as const };
    return { id, state: "open" as const, title, href: `/crm/deals/${id}`, hostVisible };
  });
  return c.json({ items }, 200);
});
