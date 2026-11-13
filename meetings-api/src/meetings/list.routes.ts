/**
 * `GET /meetings`: "My meetings" (specs/20261104-meetings plan.md § API contracts → Meetings;
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
 *
 * `folder` narrows to one of the caller's OWN folders (ADR 20261113-personal-meeting-folders), or `none` for the meetings they filed nowhere;
 * a folder id that is not theirs simply matches nothing. Each row carries the caller's own `folderId`.
 *
 * `ids` (at most 25, specs/029 AC-2.5, AC-2.10) is one more filter, ANDed with the caller's own
 * set like the rest: hours-api asks it "which of these meetings may this person record hours on,
 * and what are they called". Only a meeting the caller created or was added to as an Operai
 * participant comes back; one they could open only through its host, someone else's, and an id
 * that does not exist are all simply absent, with nothing to tell them apart.
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

/** The most ids one `ids` filter names: a page, so the answer is always one page (specs/029 plan.md). */
const MAX_IDS = 25;
const MAX_ID_LENGTH = 64;

/**
 * `ids=a,b,c`: comma-separated meeting ids, each 1-64 characters (ids are text, never uuids), at most
 * {@link MAX_IDS}. An empty member (`ids=`, `a,,b`, a trailing comma) is a 422, not "no filter": a caller
 * that built its list from nothing must not be handed the whole list back (crm-api's `IdsSchema` rule).
 */
const IdsQuery = z
  .string()
  .max(MAX_IDS * (MAX_ID_LENGTH + 1))
  .openapi({ description: `Comma-separated meeting ids, at most ${MAX_IDS}. Narrows the caller's own meetings (created or Operai participant) to these; any other id, unknown or not the caller's, is simply absent.`, example: "cm0a1,cm0b2" })
  .transform((value) => value.split(",").map((id) => id.trim()))
  .refine((ids) => ids.length <= MAX_IDS, `At most ${MAX_IDS} ids`)
  .refine((ids) => ids.every((id) => id.length >= 1 && id.length <= MAX_ID_LENGTH), `Every id is 1-${MAX_ID_LENGTH} characters`);

const ListQuery = z.object({
  q: z.string().max(200).optional(),
  role: z.enum(["creator", "participant"]).optional(),
  status: z.enum(DERIVED_STATUSES).optional(),
  hostApp: z.string().min(1).max(64).optional(),
  /** One of the caller's folder ids, or `none`. */
  folder: z.string().min(1).max(64).optional(),
  ids: IdsQuery.optional(),
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
  const { q, role, status, hostApp, folder, ids, page } = c.req.valid("query");
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
  if (folder === "none") filters.push({ folderEntries: { none: { userId: caller.userId } } });
  else if (folder) filters.push({ folderEntries: { some: { userId: caller.userId, folderId: folder } } });
  // Narrows `mine`, never widens it: an id the caller may not list is absent exactly like one that does not exist.
  // Postgres text cannot hold a NUL, so such an id names no meeting and is never sent (the driver would throw: a 500).
  if (ids) filters.push({ id: { in: ids.filter((id) => !id.includes("\u0000")) } });

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

  const [rows, entries] = await Promise.all([
    buildMeetingRows(found, {
      authorization: caller.authorization,
      now,
      roleOf: (row) => (row.creatorUserId === caller.userId ? "creator" : "participant"),
    }),
    db.meetingFolderEntry.findMany({
      where: { userId: caller.userId, meetingId: { in: found.map((m) => m.id) } },
      select: { meetingId: true, folderId: true },
    }),
  ]);
  const folderOf = new Map(entries.map((e) => [e.meetingId, e.folderId]));
  const items = rows.map((row) => ({ ...row, folderId: folderOf.get(row.id) ?? null }));
  return c.json({ items, total, page, pageSize: PAGE_SIZE as typeof PAGE_SIZE }, 200);
});
