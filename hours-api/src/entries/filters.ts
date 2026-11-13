/**
 * What a read of entries is asked for (specs/029 T17; plan § Entries "GET /time-entries", "The span", "A day", "The
 * id rule"): the period, whose hours and the narrowing filters, shared by the list (`list.routes.ts`) and the totals
 * (`src/totals/`, T18), so both answer the same question the same way.
 *
 * Two layers. The query SCHEMA (`filterShape`) holds what a string alone decides — a real calendar day, an id inside
 * the id rule, a known target — and a violation is the router's 400 `invalid_request` naming the member
 * (src/lib/errors.ts). `readFilters` then holds what depends on two members together (the span, `userId` and
 * `whose`). Both are decided from the request alone, before any `auth`, owner or database call.
 *
 * `entryWhere` turns the filters into the database's question. The `dealId` filter is the one that asks another
 * service first: the meetings linked to the deal NOW (AC-2.6), which no entry stores.
 */

import { z } from "@hono/zod-openapi";
import { readMeetingsLinkedToDeal } from "../clients/meetings";
import type { Prisma } from "../lib/generated/prisma/client";
import { ProblemError } from "../lib/problem";
import { IdSchema, isWellFormedId } from "../lists/idRule";
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
  projectId: IdSchema.optional().openapi({ description: "Entries on this project" }),
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

const dayOf = (day: string): Date => new Date(`${day}T00:00:00Z`);

/**
 * 503 `host_unavailable`: the answer of any read that needs a fact only another service holds and cannot get
 * (plan § Errors). Nothing partial goes with it.
 */
const hostUnavailable = (detail: string): ProblemError => new ProblemError({ status: 503, code: "host_unavailable", detail });

/**
 * What "on this deal" means: the entries on the deal itself, plus the entries on the meetings linked to it NOW
 * (AC-2.6). The link is not stored on an entry, so a relinked meeting's hours move with it, and only meetings-api
 * can say which meetings those are (its system route, hours-api's own credential, ADR-0089).
 *
 * When it cannot, the whole read is refused (AC-4.11, D45): a deal's figures are never shown low. The deal
 * filter is the one place this API prefers an error to a partial answer.
 */
async function dealCondition(dealId: string): Promise<Prisma.TimeEntryWhereInput> {
  const linked = await readMeetingsLinkedToDeal(dealId);
  if (linked.state === "unavailable") {
    throw hostUnavailable("Meetings could not say which meetings are linked to this deal, so the deal's hours are not shown");
  }
  // An entry's meeting id passed the id rule when it was written, so an id outside it names no entry of ours:
  // dropping it loses nothing, and a NUL in it would otherwise reach Postgres `text` (a 500).
  const meetingIds = linked.meetingIds.filter(isWellFormedId);
  return { OR: [{ dealId }, ...(meetingIds.length > 0 ? [{ meetingId: { in: meetingIds } }] : [])] };
}

/**
 * The entries `filters` select among the CALLER's own (`whose=mine`; everyone's is behind the oversight check,
 * T19). Every filter narrows, so they combine with AND.
 */
export async function entryWhere(filters: EntryFilters, sub: string): Promise<Prisma.TimeEntryWhereInput> {
  const forDeal = filters.dealId === undefined ? undefined : await dealCondition(filters.dealId);
  return {
    userId: sub,
    ...(forDeal !== undefined ? { AND: [forDeal] } : {}),
    day: { gte: dayOf(filters.from), lte: dayOf(filters.to) },
    ...(filters.target !== undefined ? { target: filters.target } : {}),
    ...(filters.projectId !== undefined ? { projectId: filters.projectId } : {}),
    ...(filters.meetingId !== undefined ? { meetingId: filters.meetingId } : {}),
    ...(filters.categoryId !== undefined ? { categoryId: filters.categoryId } : {}),
    ...(filters.workTypeId !== undefined ? { workTypeId: filters.workTypeId } : {}),
  };
}
