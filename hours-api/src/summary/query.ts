/**
 * What `GET /time-entries/summary` is asked for (specs/20261112-project-hours T9; plan § API contracts "hours-api — `GET /time-entries/summary`"):
 * ONE record — a project or a deal — and, for a project, optionally a window of days.
 *
 * Two layers, as the list's (src/entries/filters.ts). The query SCHEMA (`summaryQueryShape`, `.strict()`) holds what a string alone decides: an id
 * inside the id rule, a real calendar day, no member the route does not know. `readSummaryQuery` then holds what depends on two members together:
 * exactly one of `projectId` and `dealId`, the window both-or-neither and only with a project, `windowFrom` not after `windowTo`. Every refusal is the
 * router's 400 `invalid_request` naming a member (src/lib/errors.ts), decided from the request alone, before any owner, `auth` or database call.
 *
 * The window has no span cap: it is one record's entries, and the project's package period (a year, or an open capacity package) is longer than the
 * period the list and the totals take at most.
 */

import { z } from "@hono/zod-openapi";
import { invalidRequest } from "../entries/filters";
import { DaySchema } from "../entries/schemas";
import { IdSchema } from "../lists/idRule";

export const summaryQueryShape = {
  projectId: IdSchema.optional().openapi({ description: "The project whose hours are summed: its own entries and those on the meetings linked to it now. Exactly one of `projectId` and `dealId`" }),
  dealId: IdSchema.optional().openapi({ description: "The deal whose hours are summed: its own entries and those on the meetings linked to it now. Exactly one of `projectId` and `dealId`" }),
  windowFrom: DaySchema.optional().openapi({ description: "First day of the window `windowMinutes` counts, `YYYY-MM-DD`. Only with `projectId`, and only together with `windowTo`" }),
  windowTo: DaySchema.optional().openapi({ description: "Last day of the window (included), `YYYY-MM-DD`; not before `windowFrom`. Only with `projectId`, and only together with `windowFrom`" }),
};

export const SummaryQuerySchema = z.object(summaryQueryShape).strict();
type SummaryQuery = z.infer<typeof SummaryQuerySchema>;

/** The record a summary is about. */
export type SummaryRecord = { readonly type: "project" | "deal"; readonly id: string };

/** A valid query: the record, and the window when there is one. */
export interface SummaryRequest {
  readonly record: SummaryRecord;
  readonly window: { readonly from: string; readonly to: string } | null;
}

/** The request of a valid query, once the members that depend on each other agree. Throws a 400 `invalid_request` naming the member that does not. */
export function readSummaryQuery(query: SummaryQuery): SummaryRequest {
  const { projectId, dealId, windowFrom, windowTo } = query;
  if (projectId === undefined && dealId === undefined) throw invalidRequest("projectId", "give exactly one of projectId and dealId");
  if (projectId !== undefined && dealId !== undefined) throw invalidRequest("dealId", "give exactly one of projectId and dealId, not both");

  // A window is a package period, which only a project has; a half of one is a client that did not finish its request, never "from the start".
  if (windowFrom !== undefined && windowTo === undefined) throw invalidRequest("windowTo", "is required with windowFrom");
  if (windowTo !== undefined && windowFrom === undefined) throw invalidRequest("windowFrom", "is required with windowTo");
  if (windowFrom !== undefined && windowTo !== undefined) {
    if (dealId !== undefined) throw invalidRequest("windowFrom", "is only for projectId");
    // `YYYY-MM-DD` of two real days sorts as the calendar does.
    if (windowFrom > windowTo) throw invalidRequest("windowTo", "must not be before windowFrom");
  }

  const record: SummaryRecord = projectId !== undefined ? { type: "project", id: projectId } : { type: "deal", id: dealId as string };
  return { record, window: windowFrom !== undefined && windowTo !== undefined ? { from: windowFrom, to: windowTo } : null };
}
