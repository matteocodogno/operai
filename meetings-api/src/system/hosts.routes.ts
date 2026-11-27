/**
 * GET /system/meetings/hosts (specs/20261112-time-tracking T9 — AC-2.6, AC-4.5, AC-4.11; ADR 20261112-time-bookability-asked-of-owners-meeting-hosts-system-route § 6):
 * the host entity (today a CRM deal) each meeting is CURRENTLY linked to, read service-to-service.
 * hours-api counts the hours recorded on a meeting for the meeting's deal and must follow a relink,
 * so it asks here instead of storing the deal on the entry. This is meetings-api's first `/system/*`
 * route and trusts a scoped SERVICE credential (`meetings.hosts.read`, `sub` `system:hours-api`),
 * never a user JWT. It is not behind `selfScoped` or `capability`: no user, no participation.
 *
 *   ids      comma-separated meeting ids (at most 100): each one's current host, or `null` when it is
 *            linked to none. An id that names no meeting is absent.
 *   dealId   the meetings currently linked to that CRM deal (no paging: a row is an id and a link).
 *   projectId the meetings currently linked to that Projects project, by the same rule (specs/20261112-project-hours T1 —
 *            AC-4.1, AC-4.2, AC-4.4, AC-4.8, AC-4.9; D78: the hours on a project include its linked meetings').
 *
 * Exactly one of the three (422 otherwise). The answer is `{ items: { id, host }[] }` and NOTHING else —
 * never a title, a participant, a duration or any content (ADR 20261104-meetings-tool-shape-visibility-by-participation: content opens by relationship to
 * the record, for no role and no service). The link is independent of the creator's `hostVisible`
 * choice, which only decides whether host readers may open the meeting.
 *
 * A host is data, never a branch (ADR 20261104-meeting-host-contract-resolve-and-notices): `host` reports whatever the meeting stores. Only the
 * `dealId` and `projectId` filters name a host, because their contracts are "the CRM deal" and "the Projects project":
 * each matches the app, the entity type AND the id, so another app's entity of the same type or id is never a match.
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { createSystemAuthMiddleware, type SystemAuthVariables } from "../auth/systemAuth.middleware";
import { db } from "../lib/db";
import type { Prisma } from "../lib/generated/prisma/client";
import { commonErrors } from "../lib/http";
import { validationHook } from "../lib/problem";

/** The scope this route requires (`auth/src/system/serviceClients.ts`, specs/20261112-time-tracking T2). */
export const HOSTS_SCOPE = "meetings.hosts.read";

/**
 * The one service principal this route serves. Holding `meetings.hosts.read` is not enough: a service
 * credential opens only the routes that list its `sub` (ADR 20261103-projects-api-reads-crm-companies-with-scoped-service-credential, 20261105-estimai-closes-the-estimate-crm-follows posture).
 */
export const HOSTS_ALLOWED_SUBS = ["system:hours-api"] as const;

/** What the `dealId` filter means: the CRM's deal host (`src/hosts/registry.ts`). */
const DEAL_HOST = { app: "crm", entityType: "deal" } as const;

/** What the `projectId` filter means: the Projects app's project host (`src/hosts/registry.ts`, specs/20261112-project-hours D78). */
const PROJECT_HOST = { app: "projects", entityType: "project" } as const;

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

/** `dealId=<id>` / `projectId=<id>`: one host entity id, 1-64 characters (ids are text). */
const hostEntityIdQuery = (what: "deal" | "project", description: string, example: string) =>
  z
    .string()
    .max(MAX_ID_LENGTH * 2)
    .openapi({ description, example })
    .transform((value) => value.trim())
    .refine(lengthOk, `The ${what} id is 1-${MAX_ID_LENGTH} characters`);

const DealIdQuery = hostEntityIdQuery("deal", "A CRM deal id: the meetings currently linked to it. Exactly one of ids, dealId and projectId.", "cm0d1");

const ProjectIdQuery = hostEntityIdQuery(
  "project",
  "A Projects project id: the meetings currently linked to it. Exactly one of ids, dealId and projectId.",
  "cm0p1",
);

/** Exactly one filter: none would be "every meeting" and two would be a question nobody asked. */
const Query = z
  .object({ ids: IdsQuery.optional(), dealId: DealIdQuery.optional(), projectId: ProjectIdQuery.optional() })
  .superRefine((query, ctx) => {
    const given = [query.ids, query.dealId, query.projectId].filter((filter) => filter !== undefined).length;
    if (given !== 1) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["ids"], message: "Give exactly one of ids, dealId or projectId" });
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
      "an unknown id is absent), `dealId` (the meetings currently linked to that CRM deal) and `projectId` " +
      "(the meetings currently linked to that project). " +
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

/** The meetings whose stored host is exactly this entity now; an id that cannot name one matches none. */
const linkedTo = (host: { readonly app: string; readonly entityType: string }, entityId: string): Prisma.MeetingWhereInput | null =>
  queryable(entityId) ? { hostApp: host.app, hostEntityType: host.entityType, hostEntityId: entityId } : null;

export const createSystemHostsRouter = (auth: MiddlewareHandler) => {
  const router = new OpenAPIHono<{ Variables: SystemAuthVariables }>({ defaultHook: validationHook });

  // The guard rides on the route (`middleware`), never `router.use("*")`: Hono copies a
  // sub-app's `use("*")` onto the whole app.
  router.openapi(hostsRoute(auth), async (c) => {
    const { ids, dealId, projectId } = c.req.valid("query");
    const where: Prisma.MeetingWhereInput | null =
      ids !== undefined
        ? { id: { in: ids.filter(queryable) } }
        : dealId !== undefined
          ? linkedTo(DEAL_HOST, dealId)
          : projectId !== undefined
            ? linkedTo(PROJECT_HOST, projectId)
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
