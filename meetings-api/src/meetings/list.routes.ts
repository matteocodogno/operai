/**
 * `GET /meetings`: "My meetings" (specs/021-meetings plan.md § API contracts → Meetings;
 * AC-10.1, AC-10.2, AC-10.3, AC-11.5). Every signed-in user gets it, with no grant at all
 * and while `auth` is down (`selfScoped`, AC-10.6).
 *
 * The list is the caller's own: meetings they created, and meetings they were added to as
 * an Operai participant. Nothing else, whatever they hold: an administrator, an erase holder
 * and a host reader (who opens a meeting through its host entity, not from here) see only
 * their own (AC-4.8). Newest first, 25 a page.
 *
 * `status` filters on the DERIVED status: `interrupted` is never stored, so the rows still
 * `recording` are partitioned with the same `derivedStatus` the rows are shown with. That
 * set is the caller's few live recordings, never a page worth.
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { selfScoped } from "../auth/guards";
import type { AuthzVariables } from "../auth/authz.middleware";
import { db } from "../lib/db";
import type { Prisma } from "../lib/generated/prisma/client";
import { PAGE_SIZE, commonErrors, likeLiteral, pageOf, pageQuery, skipTake } from "../lib/http";
import { validationHook } from "../lib/problem";
import { callerOf } from "./caller";
import { derivedStatus } from "./derived";
import { ROW_SELECT, buildMeetingRows } from "./rows";
import { DERIVED_STATUSES, MeetingRowSchema } from "./schemas";

const ListQuery = z.object({
  q: z.string().max(200).optional(),
  role: z.enum(["creator", "participant"]).optional(),
  status: z.enum(DERIVED_STATUSES).optional(),
  hostApp: z.string().min(1).max(64).optional(),
  ...pageQuery(),
});

const listMeetings = createRoute({
  method: "get",
  path: "/meetings",
  tags: ["Meetings"],
  summary: "My meetings: created by or shared with the caller",
  middleware: selfScoped,
  request: { query: ListQuery },
  responses: {
    200: { description: "A page of meetings", content: { "application/json": { schema: pageOf(MeetingRowSchema) } } },
    401: commonErrors[401],
    422: commonErrors[422],
  },
});

export const listRouter = new OpenAPIHono<{ Variables: AuthzVariables }>({ defaultHook: validationHook });

listRouter.openapi(listMeetings, async (c) => {
  const { q, role, status, hostApp, page } = c.req.valid("query");
  const caller = callerOf(c);
  const now = new Date();

  const mine: Prisma.MeetingWhereInput =
    role === "creator"
      ? { creatorUserId: caller.userId }
      : role === "participant"
        ? { creatorUserId: { not: caller.userId }, participants: { some: { userId: caller.userId } } }
        : { OR: [{ creatorUserId: caller.userId }, { participants: { some: { userId: caller.userId } } }] };

  const filters: Prisma.MeetingWhereInput[] = [mine];
  const needle = q?.trim();
  if (needle) filters.push({ title: { contains: likeLiteral(needle), mode: "insensitive" } });
  if (hostApp) filters.push({ hostApp });

  if (status === "recording" || status === "interrupted") {
    const candidates = await db.meeting.findMany({
      where: { AND: [...filters, { status: "recording" }] },
      select: { id: true, sessions: { orderBy: [{ startedAt: "desc" }, { id: "desc" }], take: 1 } },
    });
    const live = candidates.filter((m) => derivedStatus("recording", m.sessions[0] ?? null, now) === "recording").map((m) => m.id);
    filters.push({ status: "recording", id: status === "recording" ? { in: live } : { notIn: live } });
  } else if (status) {
    filters.push({ status });
  }

  const where: Prisma.MeetingWhereInput = { AND: filters };
  const [total, found] = await Promise.all([
    db.meeting.count({ where }),
    db.meeting.findMany({ where, select: ROW_SELECT, orderBy: [{ startsAt: "desc" }, { id: "desc" }], ...skipTake(page) }),
  ]);

  const items = await buildMeetingRows(found, {
    authorization: caller.authorization,
    now,
    roleOf: (row) => (row.creatorUserId === caller.userId ? "creator" : "participant"),
  });
  return c.json({ items, total, page, pageSize: PAGE_SIZE as typeof PAGE_SIZE }, 200);
});
