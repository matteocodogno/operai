/**
 * What a read of entries is asked for (specs/20261112-time-tracking T17; plan § Entries "GET /time-entries", "The span", "A day", "The
 * id rule"): the period, whose hours and the narrowing filters, shared by the list (`list.routes.ts`) and the totals
 * (`src/totals/`, T18), so both answer the same question the same way.
 *
 * Two layers. The query SCHEMA (`filterShape`) holds what a string alone decides — a real calendar day, an id inside
 * the id rule, a known target — and a violation is the router's 400 `invalid_request` naming the member
 * (src/lib/errors.ts). `readFilters` then holds what depends on two members together (the span, `userId` and
 * `whose`). Both are decided from the request alone, before any `auth`, owner or database call.
 *
 * `entryWhere` turns the filters into the database's question. The `dealId` and `projectId` filters are the ones that ask another
 * service first: the meetings linked to the deal or the project NOW (AC-2.6; specs/20261112-project-hours AC-4.4), which no entry stores.
 */

import { createHash } from "node:crypto";
import { z } from "@hono/zod-openapi";
import { readMeetingsLinkedToDeal, readMeetingsLinkedToProject, type LinkedMeetings } from "../clients/meetings";
import type { Prisma } from "../lib/generated/prisma/client";
import { ProblemError } from "../lib/problem";
import { IdSchema, isWellFormedId } from "../lists/idRule";
import type { EntryScope } from "../oversight/scope";
import { hostUnavailable } from "../targets/errors";
import { dayDate } from "./rules";
import { DaySchema } from "./schemas";

// ─── The members ─────────────────────────────────────────────────────────────

/** The longest period a read takes, counting both end days: a whole leap year (plan § Entries, "The span"). */
export const MAX_SPAN_DAYS = 366;

export const WHOSE = ["mine", "all"] as const;
export const TARGETS = ["project", "deal", "meeting", "none"] as const;

/**
 * The query members the list and the totals share. Everything but `from` and `to` is optional, and an optional
 * member that is sent is checked: sent empty (`projectId=`) or twice it is outside its rule, never "no filter".
 */
export const filterShape = {
  whose: z.enum(WHOSE).optional().openapi({
    description: "`mine` (the default): the caller's own entries. `all`: everyone's, which needs `time-entry:read-all`",
  }),
  from: DaySchema.openapi({ description: "First day of the period, a real calendar day from 2000-01-01, `YYYY-MM-DD`. Required" }),
  to: DaySchema.openapi({
    description: `Last day of the period (included), a real calendar day from 2000-01-01. Required; at most ${MAX_SPAN_DAYS} days from \`from\`, both end days counted`,
  }),
  userId: IdSchema.optional().openapi({ description: "One person's entries. Only with `whose=all`" }),
  target: z.enum(TARGETS).optional().openapi({ description: "What the entry is on: its own kind (a meeting entry is `meeting`, whatever deal the meeting is linked to)" }),
  projectId: IdSchema.optional().openapi({
    description:
      "Entries on this project, and entries on the meetings currently linked to it. Refused 503 `host_unavailable` while meetings-api cannot say which meetings those are",
  }),
  dealId: IdSchema.optional().openapi({
    description: "Entries on this deal, and entries on the meetings currently linked to it. Refused 503 `host_unavailable` while meetings-api cannot say which meetings those are",
  }),
  meetingId: IdSchema.optional().openapi({ description: "Entries on this meeting" }),
  categoryId: IdSchema.optional().openapi({ description: "Entries on no entity, in this category" }),
  workTypeId: IdSchema.optional().openapi({ description: "Entries with this work type" }),
};

const FiltersSchema = z.object(filterShape);
type FilterQuery = z.infer<typeof FiltersSchema>;

/** The filters of a valid query: `whose` is always there (`mine` unless said). */
export type EntryFilters = Omit<FilterQuery, "whose"> & { readonly whose: (typeof WHOSE)[number] };

// ─── What two members decide together ────────────────────────────────────────

/** A 400 `invalid_request` naming `field`, in the shape of the router's own (src/lib/errors.ts `invalidRequestHook`). */
export const invalidRequest = (field: string, message: string): ProblemError =>
  new ProblemError({ status: 400, code: "invalid_request", detail: `${field}: ${message}`, extras: { field, errors: [{ field, message }] } });

const DAY_MS = 86_400_000;

/** The days from `from` to `to` counting both end days: `from = to` is one day. Both are valid days (`DaySchema`). */
export const spanDays = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;

/** 400 `field: "to"` when `from` is after `to`, or the period is longer than `MAX_SPAN_DAYS` (the field hours-ui's Custom period marks). */
export function assertPeriod(from: string, to: string): void {
  const days = spanDays(from, to);
  if (days < 1) throw invalidRequest("to", "must not be before from");
  if (days > MAX_SPAN_DAYS) throw invalidRequest("to", `the period is at most ${MAX_SPAN_DAYS} days, counting both end days`);
}

/** The filters of a valid query, once the members that depend on each other agree. */
export function readFilters(query: FilterQuery): EntryFilters {
  assertPeriod(query.from, query.to);
  const whose = query.whose ?? "mine";
  // One person's entries is a question about everyone's: a `userId` next to `whose=mine` is a client that
  // mixed the two up, never "mine, narrowed" (AC-4.2).
  if (query.userId !== undefined && whose !== "all") throw invalidRequest("userId", "is only for whose=all");
  // Named one by one: a route's own members (`cursor`, `limit`, `groupBy`) are not filters and must not travel as one.
  const { from, to, userId, target, projectId, dealId, meetingId, categoryId, workTypeId } = query;
  return { whose, from, to, userId, target, projectId, dealId, meetingId, categoryId, workTypeId };
}

// ─── The database's question ─────────────────────────────────────────────────

/** What a filter that counts linked meetings hands back: the database's question, and the meetings it was built from. */
interface LinkedCondition {
  readonly condition: Prisma.TimeEntryWhereInput;
  readonly meetingIds: readonly string[];
}

/**
 * "On this record" for a deal or a project: the entries on the record itself (`own`), plus the entries on the meetings linked to it NOW, which
 * only meetings-api can say. When it cannot, the whole read is refused (AC-4.11, D45; specs/20261112-project-hours AC-4.8, AC-4.9): a record's
 * figures are never shown low. These filters are the one place this API prefers an error to a partial answer.
 */
function linkedCondition(own: Prisma.TimeEntryWhereInput, linked: LinkedMeetings, what: "deal" | "project"): LinkedCondition {
  if (linked.state === "unavailable") {
    throw hostUnavailable(`Meetings could not say which meetings are linked to this ${what}, so the ${what}'s hours are not shown`);
  }
  // An entry's meeting id passed the id rule when it was written, so an id outside it names no entry of ours:
  // dropping it loses nothing, and a NUL in it would otherwise reach Postgres `text` (a 500).
  const meetingIds = linked.meetingIds.filter(isWellFormedId);
  return { condition: { OR: [own, ...(meetingIds.length > 0 ? [{ meetingId: { in: meetingIds } }] : [])] }, meetingIds };
}

/**
 * What "on this deal" means: the entries on the deal itself, plus the entries on the meetings linked to it NOW (AC-2.6). The link is not stored
 * on an entry, so a relinked meeting's hours move with it, and only meetings-api can say which meetings those are (its system route, hours-api's
 * own credential, ADR 20261112-time-bookability-asked-of-owners-meeting-hosts-system-route).
 */
export async function dealCondition(dealId: string): Promise<LinkedCondition> {
  return linkedCondition({ dealId }, await readMeetingsLinkedToDeal(dealId), "deal");
}

/**
 * What "on this project" means (specs/20261112-project-hours AC-4.1, AC-4.2, AC-4.4, D78): the deal's twin. The entries on the project
 * itself, plus the entries on the meetings linked to it NOW, whoever recorded them and whether or not that person is on the team. A meeting has
 * one host, so a meeting's hours count for a deal or for a project, never both.
 */
export async function projectCondition(projectId: string): Promise<LinkedCondition> {
  return linkedCondition({ projectId }, await readMeetingsLinkedToProject(projectId), "project");
}

const meetingsKeyOf = (prefix: string, meetingIds: readonly string[]): string => {
  const joined = [...new Set(meetingIds)].sort().join(",");
  return createHash("sha256").update(`${prefix}${joined}`, "utf8").digest("base64url").slice(0, 11);
};

/**
 * A short, stable name for the set of meetings linked to a deal: the first 66 bits of the SHA-256 of the sorted,
 * distinct ids joined by `,` (a comma is outside the id rule, so the join is unambiguous), in base64url (11 characters).
 * The list's cursor carries it under a `dealId` filter, so a page read after the deal's meetings changed is refused
 * instead of being filtered against another set than the pages before it.
 */
export function dealMeetingsKey(meetingIds: readonly string[]): string {
  return meetingsKeyOf("", meetingIds);
}

/**
 * The same for a project (specs/20261112-project-hours D78), with the hash taken over `project:` in front of the ids: the key of a project's
 * meetings is never the key of a deal's, even when both name the same set (or none), so a cursor minted under one filter is refused, not
 * taken, under the other.
 */
export function projectMeetingsKey(meetingIds: readonly string[]): string {
  return meetingsKeyOf("project:", meetingIds);
}

/** What `entryQuery` hands back: the database's question, and (under a `dealId` / `projectId` filter) the key of the meetings it counted. */
export interface EntryQuery {
  readonly where: Prisma.TimeEntryWhereInput;
  /** `dealMeetingsKey` of the meetings linked to the deal NOW; `null` without a `dealId` filter. */
  readonly dealMeetings: string | null;
  /** `projectMeetingsKey` of the meetings linked to the project NOW; `null` without a `projectId` filter. */
  readonly projectMeetings: string | null;
}

/**
 * The entries `filters` select among those `scope` names — the caller's own, one person's, or everyone's, which
 * only the oversight check (src/oversight/scope.ts) hands out. Every filter narrows, so they combine with AND.
 */
export async function entryWhere(filters: EntryFilters, scope: EntryScope): Promise<Prisma.TimeEntryWhereInput> {
  return (await entryQuery(filters, scope)).where;
}

/** `entryWhere`, plus the keys of the meetings the question was built from (the list's cursor carries them). */
export async function entryQuery(filters: EntryFilters, scope: EntryScope): Promise<EntryQuery> {
  const [forDeal, forProject] = await Promise.all([
    filters.dealId === undefined ? undefined : dealCondition(filters.dealId),
    filters.projectId === undefined ? undefined : projectCondition(filters.projectId),
  ]);
  const linked = [forDeal, forProject].flatMap((found) => (found === undefined ? [] : [found.condition]));
  const where: Prisma.TimeEntryWhereInput = {
    ...(scope.kind === "person" ? { userId: scope.userId } : {}),
    ...(linked.length > 0 ? { AND: linked } : {}),
    day: { gte: dayDate(filters.from), lte: dayDate(filters.to) },
    ...(filters.target !== undefined ? { target: filters.target } : {}),
    ...(filters.meetingId !== undefined ? { meetingId: filters.meetingId } : {}),
    ...(filters.categoryId !== undefined ? { categoryId: filters.categoryId } : {}),
    ...(filters.workTypeId !== undefined ? { workTypeId: filters.workTypeId } : {}),
  };
  return {
    where,
    dealMeetings: forDeal === undefined ? null : dealMeetingsKey(forDeal.meetingIds),
    projectMeetings: forProject === undefined ? null : projectMeetingsKey(forProject.meetingIds),
  };
}
