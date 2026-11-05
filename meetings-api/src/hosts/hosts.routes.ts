/**
 * Host routes (specs/021-meetings plan.md § API contracts → Hosts, ADR-0059; AC-1.1,
 * AC-1.7, AC-5.5, AC-5.6, AC-11.2, AC-11.3, AC-11.4). A host is DATA: none of these routes
 * branches on which host it is, so a new host needs no change here (AC-11.4).
 *
 *   GET /hosts                          the registry's public part (labels, never a base URL)
 *   GET /hosts/:app/:type/:id           the entity, resolved AS THE CALLER
 *   GET /hosts/:app/:type/:id/meetings  what THIS viewer may open on that entity. Hidden
 *                                       meetings leave no trace: not in the items, the
 *                                       total, or any flag that varies with them.
 *   GET /hosts/:app/:type/:id/linkable-meetings   the caller's own meetings that could be
 *                                       linked to the entity (G2)
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { MEETINGS_ACCESS, capability, selfScoped } from "../auth/guards";
import type { AuthzVariables } from "../auth/authz.middleware";
import { db } from "../lib/db";
import type { Prisma } from "../lib/generated/prisma/client";
import { PAGE_SIZE, commonErrors, likeLiteral, pageOf, pageQuery, skipTake } from "../lib/http";
import { validationHook } from "../lib/problem";
import { callerOf } from "../meetings/caller";
import { ROW_SELECT, buildMeetingRows, hostKey, type MeetingRow } from "../meetings/rows";
import { MeetingRowSchema } from "../meetings/schemas";
import type { HostView } from "../meetings/view";
import { creatorFrozen } from "../meetings/visibility";
import { resolve as resolveAtHost } from "./client";
import { publicView, hostRegistry } from "./registry";
import { requireHost, verifyHostReference } from "./reference";

const HostParams = z.object({
  app: z.string().min(1).max(64),
  type: z.string().min(1).max(64),
  id: z.string().min(1).max(64),
});

const ListQuery = z.object({ q: z.string().max(200).optional(), ...pageQuery() });
const EntityMeetingsQuery = z.object({ ...pageQuery() });

const listHosts = createRoute({
  method: "get",
  path: "/hosts",
  tags: ["Hosts"],
  summary: "The registered hosts (public part)",
  middleware: selfScoped,
  responses: {
    200: { description: "The hosts, with the labels the meeting screens render", content: { "application/json": { schema: z.object({ items: z.array(z.any()) }) } } },
    401: commonErrors[401],
  },
});

const getEntity = createRoute({
  method: "get",
  path: "/hosts/{app}/{type}/{id}",
  tags: ["Hosts"],
  summary: "A host entity, resolved as the caller (meetings:access)",
  middleware: capability(MEETINGS_ACCESS),
  request: { params: HostParams },
  responses: {
    200: { description: "The entity", content: { "application/json": { schema: z.object({ host: z.any() }) } } },
    401: commonErrors[401],
    403: commonErrors[403],
    422: { description: "host_not_registered or host_entity_not_found (identical for missing and closed)" },
    503: { description: "host_unavailable, or auth is unavailable" },
  },
});

const entityMeetings = createRoute({
  method: "get",
  path: "/hosts/{app}/{type}/{id}/meetings",
  tags: ["Hosts"],
  summary: "The meetings on a host entity that the caller may open",
  middleware: selfScoped,
  request: { params: HostParams, query: EntityMeetingsQuery },
  responses: {
    200: {
      description: "A page of rows, and whether host readers could not be checked",
      content: { "application/json": { schema: pageOf(MeetingRowSchema).extend({ hostReadersUnavailable: z.boolean() }) } },
    },
    401: commonErrors[401],
    422: { description: "host_not_registered" },
  },
});

const linkable = createRoute({
  method: "get",
  path: "/hosts/{app}/{type}/{id}/linkable-meetings",
  tags: ["Hosts"],
  summary: "The caller's own meetings that can be linked to this entity (meetings:access)",
  middleware: capability(MEETINGS_ACCESS),
  request: { params: HostParams, query: ListQuery },
  responses: {
    200: { description: "A page of rows", content: { "application/json": { schema: pageOf(MeetingRowSchema) } } },
    401: commonErrors[401],
    403: commonErrors[403],
    422: { description: "host_not_registered" },
    503: commonErrors[503],
  },
});

export const hostsRouter = new OpenAPIHono<{ Variables: AuthzVariables }>({ defaultHook: validationHook });

hostsRouter.openapi(listHosts, (c) => c.json({ items: hostRegistry().all().map(publicView) }, 200));

hostsRouter.openapi(getEntity, async (c) => {
  const { app, type, id } = c.req.valid("param");
  const { entity } = await verifyHostReference({ app, entityType: type, entityId: id }, callerOf(c).authorization);
  const host: HostView = { app, entityType: type, entityId: id, state: "open", title: entity.title ?? null, href: entity.href ?? null };
  return c.json({ host }, 200);
});

hostsRouter.openapi(entityMeetings, async (c) => {
  const { app, type, id } = c.req.valid("param");
  const { page } = c.req.valid("query");
  const definition = requireHost(app, type);
  const caller = callerOf(c);
  const now = new Date();

  // ONE question to the host decides both the label of every row and whether this viewer is a
  // host reader of any of them: host-granted visibility is per entity, never per meeting.
  const answer = await resolveAtHost(definition, caller.authorization, [id]);
  const entity = answer.state === "ok" ? answer.entities.get(id) : undefined;
  const label: HostView =
    entity?.state === "open"
      ? { app, entityType: type, entityId: id, state: "open", title: entity.title ?? null, href: entity.href ?? null }
      : { app, entityType: type, entityId: id, state: entity?.state ?? "unavailable", title: null, href: null };
  const readsViaHost = caller.holdsAccess && entity?.state === "open" && entity.hostVisible === true;
  // Whether host readers COULD be checked depends on the host and `auth`, never on what is stored.
  const hostReadersUnavailable = caller.capabilities === "unavailable" || (caller.holdsAccess && answer.state === "unavailable");

  const where: Prisma.MeetingWhereInput = {
    hostApp: app,
    hostEntityType: type,
    hostEntityId: id,
    OR: [
      { creatorUserId: caller.userId },
      { participants: { some: { userId: caller.userId } } },
      ...(readsViaHost ? [{ hostVisible: true }] : []),
    ],
  };
  const [total, found] = await Promise.all([
    db.meeting.count({ where }),
    db.meeting.findMany({
      where,
      select: { ...ROW_SELECT, participants: { where: { userId: caller.userId }, select: { id: true } } },
      orderBy: [{ startsAt: "desc" }, { id: "desc" }],
      ...skipTake(page),
    }),
  ]);

  const rows = await buildMeetingRows(found, {
    authorization: caller.authorization,
    now,
    knownHosts: new Map([[hostKey(app, type, id), label]]),
    roleOf: (row) => {
      if (row.creatorUserId === caller.userId) return "creator";
      return found.find((m) => m.id === row.id)!.participants.length > 0 ? "participant" : "host_reader";
    },
  });
  return c.json({ items: rows, total, page, pageSize: PAGE_SIZE as typeof PAGE_SIZE, hostReadersUnavailable }, 200);
});

hostsRouter.openapi(linkable, async (c) => {
  const { app, type, id } = c.req.valid("param");
  const { q, page } = c.req.valid("query");
  requireHost(app, type);
  const caller = callerOf(c);

  // A deactivated creator's meetings are frozen and cannot be linked (AC-5.11). This list is a
  // hint (the link itself is refused again), so an unknown answer does not hide it.
  const empty = { items: [] as MeetingRow[], total: 0, page, pageSize: PAGE_SIZE as typeof PAGE_SIZE };
  if ((await creatorFrozen(caller.authorization, caller.userId)) === true) return c.json(empty, 200);

  const where: Prisma.MeetingWhereInput = {
    creatorUserId: caller.userId,
    // NOT (on this entity), spelt out: a standalone meeting has NULL host columns and `NOT (NULL = …)` is NULL, not true.
    OR: [{ hostApp: null }, { hostApp: { not: app } }, { hostEntityType: { not: type } }, { hostEntityId: { not: id } }],
    ...(q ? { title: { contains: likeLiteral(q), mode: "insensitive" as const } } : {}),
  };
  const [total, found] = await Promise.all([
    db.meeting.count({ where }),
    db.meeting.findMany({ where, select: ROW_SELECT, orderBy: [{ startsAt: "desc" }, { id: "desc" }], ...skipTake(page) }),
  ]);
  const items = await buildMeetingRows(found, { authorization: caller.authorization, now: new Date(), roleOf: () => "creator" });
  return c.json({ items, total, page, pageSize: PAGE_SIZE as typeof PAGE_SIZE }, 200);
});
