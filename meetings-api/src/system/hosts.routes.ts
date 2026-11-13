/**
 * GET /system/meetings/hosts (specs/029-time-tracking T9 — AC-2.6, AC-4.5, AC-4.11; ADR-0089 § 6):
 * the host entity (today a CRM deal) each meeting is CURRENTLY linked to, read service-to-service.
 * hours-api counts the hours recorded on a meeting for the meeting's deal and must follow a relink,
 * so it asks here instead of storing the deal on the entry. This is meetings-api's first `/system/*`
 * route and trusts a scoped SERVICE credential (`meetings.hosts.read`, `sub` `system:hours-api`),
 * never a user JWT. It is not behind `selfScoped` or `capability`: no user, no participation.
 *
 *   ids      comma-separated meeting ids (at most 100): each one's current host, or `null` when it is
 *            linked to none. An id that names no meeting is absent.
 *   dealId   the meetings currently linked to that CRM deal (no paging: a row is an id and a link).
 *
 * Exactly one of the two (422 otherwise). The answer is `{ items: { id, host }[] }` and NOTHING else —
 * never a title, a participant, a duration or any content (ADR-0058: content opens by relationship to
 * the record, for no role and no service). The link is independent of the creator's `hostVisible`
 * choice, which only decides whether host readers may open the meeting.
 *
 * A host is data, never a branch (ADR-0059): `host` reports whatever the meeting stores. Only the
 * `dealId` filter names a host, because its contract is "the CRM deal".
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { createSystemAuthMiddleware, type SystemAuthVariables } from "../auth/systemAuth.middleware";
import { db } from "../lib/db";
import type { Prisma } from "../lib/generated/prisma/client";
import { commonErrors } from "../lib/http";
import { validationHook } from "../lib/problem";

/** The scope this route requires (`auth/src/system/serviceClients.ts`, specs/029 T2). */
export const HOSTS_SCOPE = "meetings.hosts.read";

/**
 * The one service principal this route serves. Holding `meetings.hosts.read` is not enough: a service
 * credential opens only the routes that list its `sub` (ADR-0080/0073 posture).
 */
export const HOSTS_ALLOWED_SUBS = ["system:hours-api"] as const;

/** What the `dealId` filter means: the CRM's deal host (`src/hosts/registry.ts`). */
const DEAL_HOST = { app: "crm", entityType: "deal" } as const;

export const MAX_IDS = 100;
const MAX_ID_LENGTH = 64;

const lengthOk = (id: string) => id.length >= 1 && id.length <= MAX_ID_LENGTH;

/**
 * `ids=a,b,c`: each 1-64 characters (ids are text), at most {@link MAX_IDS}, counted as sent. An empty
 * member (`ids=`, `a,,b`, a trailing comma) is a 422, never "no filter".
 */
const IdsQuery = z
  .string()
  .max(MAX_IDS * (MAX_ID_LENGTH + 1))
  .openapi({ description: `Comma-separated meeting ids, at most ${MAX_IDS}. Exactly one of ids and dealId.`, example: "cm0a1,cm0b2" })
  .transform((value) => value.split(",").map((id) => id.trim()))
  .refine((ids) => ids.length <= MAX_IDS, `At most ${MAX_IDS} ids`)
  .refine((ids) => ids.every(lengthOk), `Every id is 1-${MAX_ID_LENGTH} characters`);

/** `dealId=<id>`: one CRM deal id, 1-64 characters. */
const DealIdQuery = z
  .string()
  .max(MAX_ID_LENGTH * 2)
  .openapi({ description: "A CRM deal id: the meetings currently linked to it. Exactly one of ids and dealId.", example: "cm0d1" })
  .transform((value) => value.trim())
  .refine(lengthOk, `The deal id is 1-${MAX_ID_LENGTH} characters`);

/** Exactly one filter: neither would be "every meeting" and both would be a question nobody asked. */
const Query = z.object({ ids: IdsQuery.optional(), dealId: DealIdQuery.optional() }).superRefine((query, ctx) => {
  if ((query.ids === undefined) === (query.dealId === undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["ids"], message: "Give exactly one of ids or dealId" });
  }
});

const HostSchema = z.object({ app: z.string(), entityType: z.string(), entityId: z.string() });

const ItemSchema = z.object({ id: z.string(), host: HostSchema.nullable() });

const hostsRoute = (auth: MiddlewareHandler) =>
  createRoute({
    method: "get",
    path: "/system/meetings/hosts",
    tags: ["System"],
    summary: "The host each meeting is linked to (scope meetings.hosts.read)",
    middleware: auth,
    description:
      "Authorization: Bearer <service JWT> from auth (aud = SERVICE_AUDIENCE, scope meetings.hosts.read, sub system:hours-api). " +
      "A user JWT is never accepted. Exactly one of `ids` (at most 100: each one's current host, or null when it is linked to none; " +
      "an unknown id is absent) and `dealId` (the meetings currently linked to that CRM deal). " +
      "Returns the link and nothing else: no title, participant, duration or content.",
    request: { query: Query },
    responses: {
      200: { description: "The meetings and their current host (null: linked to none)", content: { "application/json": { schema: z.object({ items: z.array(ItemSchema) }) } } },
      401: { description: "Missing or invalid service credential (one body for every failure)" },
      422: commonErrors[422],
    },
  });

/** Postgres text cannot hold a NUL: such an id names no meeting, and sending it would make the driver throw (a 500). */
const queryable = (id: string) => !id.includes("\u0000");

export const createSystemHostsRouter = (auth: MiddlewareHandler) => {
  const router = new OpenAPIHono<{ Variables: SystemAuthVariables }>({ defaultHook: validationHook });

  // The guard rides on the route (`middleware`), never `router.use("*")`: Hono copies a
  // sub-app's `use("*")` onto the whole app.
  router.openapi(hostsRoute(auth), async (c) => {
    const { ids, dealId } = c.req.valid("query");
    const where: Prisma.MeetingWhereInput | null =
      ids !== undefined
        ? { id: { in: ids.filter(queryable) } }
        : dealId !== undefined && queryable(dealId)
          ? { hostApp: DEAL_HOST.app, hostEntityType: DEAL_HOST.entityType, hostEntityId: dealId }
          : null;
    const rows = where
      ? await db.meeting.findMany({
          where,
          select: { id: true, hostApp: true, hostEntityType: true, hostEntityId: true },
          orderBy: { id: "asc" },
        })
      : [];
    return c.json(
      {
        items: rows.map((row) => ({
          id: row.id,
          host:
            row.hostApp !== null && row.hostEntityType !== null && row.hostEntityId !== null
              ? { app: row.hostApp, entityType: row.hostEntityType, entityId: row.hostEntityId }
              : null,
        })),
      },
      200,
    );
  });

  return router;
};

/** The router `src/index.ts` mounts: the default JWKS and SERVICE_AUDIENCE. */
export const systemHostsRouter = createSystemHostsRouter(createSystemAuthMiddleware({ scope: HOSTS_SCOPE, allowedSubs: HOSTS_ALLOWED_SUBS }));
