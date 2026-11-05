/**
 * `GET /erase/meetings` (specs/021-meetings plan.md § API contracts → Erase; AC-4.7,
 * AC-4.8). The erase screen's search: any meeting by title, creator or date, and what it
 * returns is ONLY `{ id, title, startsAt, creator }`. No status, host, participant, count or
 * a word of content, and finding a meeting here opens nothing: every content route still
 * answers the holder 404. Deleting uses `DELETE /meetings/:id`.
 *
 * `meeting:erase` is checked live and fails closed (`eraser`).
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { eraser } from "../auth/guards";
import type { AuthzVariables } from "../auth/authz.middleware";
import { db } from "../lib/db";
import type { Prisma } from "../lib/generated/prisma/client";
import { PAGE_SIZE, commonErrors, likeLiteral, pageOf, pageQuery, skipTake } from "../lib/http";
import { resolveIdentities, toPersonRef, type PersonRef } from "../lib/identities";
import { validationHook } from "../lib/problem";
import { callerOf } from "../meetings/caller";

const DAY_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

/** A bare date (the whole UTC day) or an ISO instant with an offset; `null` when it is neither. */
function bound(value: string): { at: Date; wholeDay: boolean } | null {
  if (DAY_ONLY.test(value)) {
    const at = new Date(`${value}T00:00:00.000Z`);
    // `2026-13-40` must not roll over into a real date.
    return Number.isNaN(at.getTime()) || at.toISOString().slice(0, 10) !== value ? null : { at, wholeDay: true };
  }
  return z.string().datetime({ offset: true }).safeParse(value).success ? { at: new Date(value), wholeDay: false } : null;
}

const DateBound = z.string().refine((v) => bound(v) !== null, "A date (YYYY-MM-DD) or an ISO date-time");

const EraseQuery = z.object({
  q: z.string().max(200).optional(),
  creatorId: z.string().min(1).max(64).optional(),
  from: DateBound.optional(),
  to: DateBound.optional(),
  ...pageQuery(),
});

interface EraseRow {
  id: string;
  title: string;
  startsAt: string;
  creator: PersonRef;
}

const searchMeetings = createRoute({
  method: "get",
  path: "/erase/meetings",
  tags: ["Erase"],
  summary: "Find a meeting to delete (meeting:erase); title, date and creator only",
  middleware: eraser,
  request: { query: EraseQuery },
  responses: {
    200: {
      description: "A page of { id, title, startsAt, creator }",
      content: { "application/json": { schema: pageOf(z.custom<EraseRow>((v) => typeof v === "object" && v !== null).openapi({ type: "object" })) } },
    },
    401: commonErrors[401],
    403: commonErrors[403],
    422: commonErrors[422],
    503: commonErrors[503],
  },
});

export const eraseRouter = new OpenAPIHono<{ Variables: AuthzVariables }>({ defaultHook: validationHook });

eraseRouter.openapi(searchMeetings, async (c) => {
  const { q, creatorId, from, to, page } = c.req.valid("query");
  const caller = callerOf(c);

  const startsAt: Prisma.DateTimeFilter = {};
  const lower = from ? bound(from) : null;
  const upper = to ? bound(to) : null;
  if (lower) startsAt.gte = lower.at;
  // A bare `to` date means that whole day: up to, not including, the next midnight.
  if (upper) {
    if (upper.wholeDay) startsAt.lt = new Date(upper.at.getTime() + DAY_MS);
    else startsAt.lte = upper.at;
  }

  const needle = q?.trim();
  const where: Prisma.MeetingWhereInput = {
    ...(needle ? { title: { contains: likeLiteral(needle), mode: "insensitive" as const } } : {}),
    ...(creatorId ? { creatorUserId: creatorId } : {}),
    ...(lower || upper ? { startsAt } : {}),
  };
  const [total, found] = await Promise.all([
    db.meeting.count({ where }),
    db.meeting.findMany({
      where,
      select: { id: true, title: true, startsAt: true, creatorUserId: true },
      orderBy: [{ startsAt: "desc" }, { id: "desc" }],
      ...skipTake(page),
    }),
  ]);

  const people = await resolveIdentities(caller.authorization, [...new Set(found.map((m) => m.creatorUserId))]);
  const items: EraseRow[] = found.map((m) => ({
    id: m.id,
    title: m.title,
    startsAt: m.startsAt.toISOString(),
    creator: toPersonRef(people.get(m.creatorUserId) ?? { id: m.creatorUserId, name: null, status: "unknown" }),
  }));
  return c.json({ items, total, page, pageSize: PAGE_SIZE as typeof PAGE_SIZE }, 200);
});
