/**
 * `GET /time-entries` — the hours of a period, newest day first, a page at a time (specs/20261112-time-tracking T17; plan § Entries;
 * AC-1.1, AC-2.4, AC-2.6, AC-4.2, AC-4.4, AC-4.7, AC-4.11).
 *
 * Reading one's own hours needs only a session (AC-5.1): `whose=mine` is scoped to the JWT subject in the
 * statement itself and asks `auth` nothing. What the request SAYS is validated first (src/entries/filters.ts and
 * the `limit` and `cursor` here), then the entries are read in the order `day desc, createdAt desc, id desc`, and
 * every name next to them is read as the viewer through `viewEntries` (src/entries/view.ts), each source
 * failing soft and named in `unavailable`. Live, except a person's name, which may be up to 60 s old (plan § Sequences
 * "Names", the cache in src/lib/identities.ts).
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { JwtVariables } from "../auth/jwt.middleware";
import { db } from "../lib/db";
import { invalidRequestHook } from "../lib/errors";
import type { Prisma } from "../lib/generated/prisma/client";
import { ProblemSchema } from "../lists/errorDocs";
import { isWellFormedId } from "../lists/idRule";
import { readScope } from "../oversight/scope";
import { conflict } from "../lib/problem";
import { entryQuery, filterShape, invalidRequest, readFilters } from "./filters";
import { isCalendarDay } from "./rules";
import { ENTRY_INCLUDE, TimeEntryViewSchema, viewEntries } from "./view";

export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 500;

// ─── limit ───────────────────────────────────────────────────────────────────

/** A whole number from 1 to 500, written plainly (no sign, no zero in front, no exponent): else 400 naming `limit`. */
const isLimit = (text: string): boolean => /^[1-9]\d{0,2}$/.test(text) && Number(text) <= MAX_LIMIT;

// ─── The cursor (plan § Entries, "The cursor") ───────────────────────────────

/**
 * Where a page ended: the last item's day, createdAt (epoch milliseconds) and id — and, under a `dealId` filter, the
 * key of the meetings linked to the deal when that page was read (`dealMeetingsKey`, src/entries/filters.ts).
 */
interface Position {
  readonly day: string;
  readonly createdAtMs: number;
  readonly id: string;
  readonly dealMeetings: string | null;
}

const CURSOR_MAX_LENGTH = 200;
const CURSOR_ALPHABET = /^[A-Za-z0-9_-]+$/;
/** createdAt is `TIMESTAMP(3)`: whole milliseconds, written as exactly 13 digits (1970 to 2286, so every instant the column can hold). */
const EPOCH_MS = /^\d{13}$/;
/** `dealMeetingsKey`'s shape: 11 base64url characters. */
const DEAL_MEETINGS_KEY = /^[A-Za-z0-9_-]{11}$/;

/**
 * `base64url("<day>|<13-digit epoch ms>|<id>")` of an entry: the position `GET /time-entries` continues after. Under a
 * `dealId` filter a fourth part, `|<dealMeetingsKey>`, names the deal's meetings the page was filtered against.
 */
export function mintCursor(
  row: { readonly day: Date; readonly createdAt: Date; readonly id: string },
  dealMeetings: string | null = null,
): string {
  const day = row.day.toISOString().slice(0, 10);
  const createdAt = String(row.createdAt.getTime()).padStart(13, "0");
  const text = `${day}|${createdAt}|${row.id}${dealMeetings === null ? "" : `|${dealMeetings}`}`;
  return Buffer.from(text, "utf8").toString("base64url");
}

/**
 * The position a cursor names, or `null` when hours-api could not have minted it. Accepted only when it is short,
 * in the base64url alphabet, canonical (the decoder skips foreign characters and ignores trailing bits, so `YR`
 * decodes like `YQ`: re-encoding must give the same string), and three `|`-separated parts — a real calendar
 * day inside `from..to`, 13 digits, and an id inside the id rule. Checked in full before anything reaches the
 * database: a NUL would be a 500 in `text`, an impossible day a 500 in `date`.
 */
function readCursor(cursor: string, from: string, to: string, withDeal: boolean): Position | null {
  if (cursor.length > CURSOR_MAX_LENGTH || !CURSOR_ALPHABET.test(cursor)) return null;
  const text = Buffer.from(cursor, "base64url").toString("utf8");
  if (Buffer.from(text, "utf8").toString("base64url") !== cursor) return null;
  const parts = text.split("|");
  // A cursor minted under a `dealId` filter has four parts, any other three: one is never taken for the other.
  if (parts.length !== (withDeal ? 4 : 3)) return null;
  const [day, createdAt, id, dealMeetings] = parts as [string, string, string, string | undefined];
  if (!isCalendarDay(day) || day < from || day > to) return null;
  if (!EPOCH_MS.test(createdAt) || !isWellFormedId(id)) return null;
  if (dealMeetings !== undefined && !DEAL_MEETINGS_KEY.test(dealMeetings)) return null;
  return { day, createdAtMs: Number(createdAt), id, dealMeetings: dealMeetings ?? null };
}

/** The rows strictly after `position` in the list's order (`day desc, createdAt desc, id desc`). */
function after({ day, createdAtMs, id }: Position): Prisma.TimeEntryWhereInput {
  const dayDate = new Date(`${day}T00:00:00Z`);
  const createdAt = new Date(createdAtMs);
  return { OR: [{ day: { lt: dayDate } }, { day: dayDate, createdAt: { lt: createdAt } }, { day: dayDate, createdAt, id: { lt: id } }] };
}

// ─── The route ───────────────────────────────────────────────────────────────

const ListQuerySchema = z
  .object({
    ...filterShape,
    cursor: z.string().optional().openapi({ maxLength: CURSOR_MAX_LENGTH, description: "The `nextCursor` of the previous page, exactly as returned; anything else is 400 (`field: \"cursor\"`)" }),
    limit: z
      .string()
      .refine(isLimit, { message: `must be a whole number from 1 to ${MAX_LIMIT}` })
      .optional()
      .openapi({ type: "integer", minimum: 1, maximum: MAX_LIMIT, description: `The page size, 1 to ${MAX_LIMIT} (default ${DEFAULT_LIMIT})` }),
  })
  .strict();

/** The sources a read asked and that did not answer (plan § Views, `Unavailable`). Shared with the totals (T18). */
export const UnavailableSchema = z
  .array(z.enum(["projects", "crm", "activities", "meetings", "meeting-deals", "identities"]))
  .openapi({ description: "The sources that were asked and did not answer: what each covers is shown as unavailable, and the entries are still listed and counted" });

const problemDoc = (description: string) => ({ description, content: { "application/json": { schema: ProblemSchema } } });

const listEntriesRoute = createRoute({
  method: "get",
  path: "/time-entries",
  tags: ["Entries"],
  summary: "The hours of a period (any session; whose=all needs time-entry:read-all)",
  description:
    "The entries of `from..to`, both end days included, newest day first (`day desc, createdAt desc, id desc`), " +
    "a page at a time: `nextCursor` goes back as `cursor` until it is `null`. `whose=mine` (the default) is the caller's own, " +
    "needs only a session and never asks `auth`. `whose=all`, and `userId` (one person's, only with `whose=all`), need `time-entry:read-all`, " +
    "asked live of `auth` as the caller: 403 without it, 503 when `auth` cannot say. " +
    "The `id` of the project, deal, meeting or activity an entry is on is returned only for the caller's own entries and for records the caller may read " +
    "(`visibility: visible`); on anyone else's entry it is `null` while the record is hidden or its owner did not answer.",
  request: { query: ListQuerySchema },
  responses: {
    200: {
      description: "A page of entries",
      content: {
        "application/json": {
          schema: z.object({ items: z.array(TimeEntryViewSchema), nextCursor: z.string().nullable(), unavailable: UnavailableSchema }),
        },
      },
    },
    400: problemDoc("`invalid_request`: a bad or missing period, a filter outside its rule, a limit or a cursor that is not valid (`field` names it)"),
    401: problemDoc("No valid session"),
    403: problemDoc("`read_all_required`: `whose=all` or a `userId` without `time-entry:read-all`"),
    409: problemDoc(
      "`deal_meetings_changed`: with a `dealId` filter and a `cursor`, the meetings linked to the deal are no longer those of the first page. " +
        "Read the list again without a cursor: a walk never mixes two sets of the deal's meetings",
    ),
    503: problemDoc(
      "`authz_unavailable`: `whose=all` or a `userId`, and `auth` could not say whether the caller holds `time-entry:read-all` (never allowed, AC-5.4). " +
        "`host_unavailable`: with a `dealId` filter, meetings-api could not say which meetings are linked to the deal. " +
        "Nothing partial is returned: a deal's hours are never shown low",
    ),
  },
});

export const entryListRouter = new OpenAPIHono<{ Variables: JwtVariables }>({ defaultHook: invalidRequestHook });

entryListRouter.openapi(listEntriesRoute, async (c) => {
  const query = c.req.valid("query");
  const filters = readFilters(query);
  // After the period: a cursor's day is judged against `from..to`, which must hold first.
  let position: Position | null = null;
  if (query.cursor !== undefined) {
    position = readCursor(query.cursor, filters.from, filters.to, filters.dealId !== undefined);
    if (position === null) throw invalidRequest("cursor", "is not a cursor this API returned");
  }
  const limit = query.limit === undefined ? DEFAULT_LIMIT : Number(query.limit);
  const authorization = c.req.header("Authorization") ?? "";

  // Everything the request alone decides is decided by now, so nothing malformed ever costs a call to `auth`.
  // Whose entries are read is decided next (the oversight check for `whose=all`), then the `dealId` filter asks
  // meetings-api: a caller who may not read everyone's hours never makes hours-api ask it anything.
  const userId = c.get("userId");
  const scope = await readScope(filters, { sub: userId, permEpoch: c.get("permEpoch"), authorization });
  const { where, dealMeetings } = await entryQuery(filters, scope);
  // The deal's meetings are asked again on every page; when they are no longer the ones the walk began with, its
  // pages would be filtered against two different sets, so the page is refused and the walk starts over.
  if (position !== null && position.dealMeetings !== dealMeetings) {
    throw conflict("deal_meetings_changed", "The meetings linked to this deal changed since the first page: read the list again from the start");
  }
  const rows = await db.timeEntry.findMany({
    where: position === null ? where : { AND: [where, after(position)] },
    include: ENTRY_INCLUDE,
    orderBy: [{ day: "desc" }, { createdAt: "desc" }, { id: "desc" }],
    // One more than a page: whether it exists is whether there is a next page, without a count.
    take: limit + 1,
  });
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const { items, unavailable } = await viewEntries(authorization, page, userId);
  return c.json({ items, nextCursor: rows.length > limit && last !== undefined ? mintCursor(last, dealMeetings) : null, unavailable }, 200);
});
