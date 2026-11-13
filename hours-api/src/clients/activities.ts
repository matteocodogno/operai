/**
 * activities-api, asked as the caller (specs/029 T11; plan § API contracts "activities-api", § Sequences,
 * ADR-0089, AC-2.3, AC-2.7, AC-2.8, AC-2.9, AC-4.7, risks R6, R7, R9; activities-api T6). Two questions:
 *
 *   listActivitiesByIds   GET /activities?ids=a,b,c   (≤ 50 ids)
 *       Which of these activities exist and may the caller read, and what are they about? Serves the
 *       activity pointer (is it a task of the project, an activity of the deal — AC-2.7) and its label
 *       (subject, AC-2.9). ALWAYS ONE PAGE: an id the owner leaves out is "does not exist, or the caller
 *       may not read it" — one outcome, nothing tells the two apart — never "cut off"; so this client
 *       sends no `page` and no `pageSize` and never pages through an answer.
 *   listDealActivities    GET /activities?dealId=<id>&page=&pageSize=100
 *       The activities about a deal, for the second half of "is the caller involved in this deal": an
 *       assignee of one of its tasks or a participant of one of its activities (AC-2.3). Paged, a hundred
 *       to a page, at most 10 pages (1000 activities; R9): a deal with more says `truncated`.
 *
 * Neither is cached or kept: what a person may read changes.
 *
 * A FILTER THE OWNER IGNORED PROVES NOTHING ABOUT WHAT IS ABSENT. An activities-api that predates T6
 * answers 422 to `ids` alone (`unavailable`), but a list that comes back with activities nobody asked
 * for — or about another deal — is an owner that did not apply the filter: those items are never
 * believed, and an asked id missing from such an answer is not "does not exist" but unanswered. For a
 * deal scan, where "absent" means "not involved" (a 403), that is `unavailable` outright: an activity
 * about another deal must never make someone involved in this one.
 *
 * See `owner.ts` for what counts as an answer and what is `unavailable`.
 */

import { z } from "zod";
import { env } from "../lib/env";
import { callOwner, inBatches, keepAsked, unavailable, UNAVAILABLE, type CallOptions, type Unavailable } from "./owner";

/** activities-api's cap on `ids` (elements as sent). */
export const ACTIVITIES_IDS_BATCH_SIZE = 50;
/** activities-api's `MAX_PAGE_SIZE`: the largest page a deal scan can ask for. */
export const DEAL_SCAN_PAGE_SIZE = 100;
/** R9: a deal's activities are scanned for 10 pages at most. */
export const DEAL_SCAN_MAX_PAGES = 10;

/** What hours-api needs of an activity: never its body, its author or its dates. */
export interface ActivityFact {
  readonly id: string;
  readonly subject: string;
  /** `task`, `call`, `note`, `meeting`, `email`. */
  readonly type: string;
  /** The project it is a task of (an operational activity), or null. */
  readonly projectId: string | null;
  /** The deal it is about (a pre-sales activity), or null. */
  readonly dealId: string | null;
  /** A task's assignee (a user id), else null. */
  readonly assigneeId: string | null;
  /** The colleagues who took part, besides the author and the assignee (user ids). */
  readonly participantIds: readonly string[];
}

export type ActivitiesByIds = Unavailable | { readonly state: "ok"; readonly items: ReadonlyMap<string, ActivityFact> };
export type DealActivities =
  | Unavailable
  | { readonly state: "ok"; readonly items: readonly ActivityFact[]; /** True when the deal has more activities than the bound reads (R9). */ readonly truncated: boolean };

const nonEmpty = z.string().min(1);
const ref = z.object({ id: nonEmpty });

const wireActivity = z.object({
  id: nonEmpty,
  type: z.string(),
  subject: z.string(),
  project: ref.nullable(),
  deal: ref.nullable(),
  participants: z.array(ref),
  task: z.object({ assignee: ref.nullable() }).nullable(),
});

const byIdsBody = z.object({ items: z.array(wireActivity) });
const dealPageBody = z.object({ items: z.array(wireActivity), total: z.number().int().min(0) });

const toFact = (wire: z.infer<typeof wireActivity>): ActivityFact => ({
  id: wire.id,
  subject: wire.subject,
  type: wire.type,
  projectId: wire.project?.id ?? null,
  dealId: wire.deal?.id ?? null,
  assigneeId: wire.task?.assignee?.id ?? null,
  participantIds: [...new Set(wire.participants.map((person) => person.id))],
});

/** The activities among `ids` that exist and that the caller may read; the others are absent from the map. */
export async function listActivitiesByIds(authorization: string, ids: readonly string[], options: CallOptions = {}): Promise<ActivitiesByIds> {
  const outcome = await inBatches<ReadonlyMap<string, ActivityFact>, Unavailable>(ids, ACTIVITIES_IDS_BATCH_SIZE, async (batch) => {
    const answer = await callOwner({
      owner: "activities",
      op: "list-by-ids",
      method: "GET",
      baseUrl: env.ACTIVITIES_API_URL,
      path: "/activities",
      authorization,
      // One comma-separated member, and no `page` / `pageSize`: the answer is always one page.
      query: new URLSearchParams({ ids: batch.join(",") }),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });
    if (answer.kind === "unavailable") return { stop: UNAVAILABLE };
    const parsed = byIdsBody.safeParse(answer.json);
    if (!parsed.success) return { stop: unavailable("activities", "list-by-ids", "malformed") };

    const { kept, filterIgnored } = keepAsked(batch, parsed.data.items);
    if (filterIgnored) return { stop: unavailable("activities", "list-by-ids", "filter_ignored") };
    return { done: new Map([...kept].map(([id, wire]) => [id, toFact(wire)])) };
  });

  if ("stop" in outcome) return outcome.stop;
  return { state: "ok", items: new Map(outcome.done.flatMap((items) => [...items])) };
}

/** Every activity about `dealId` the caller may read, up to 1000 (10 pages), newest first. */
export async function listDealActivities(authorization: string, dealId: string, options: CallOptions = {}): Promise<DealActivities> {
  const items = new Map<string, ActivityFact>();
  for (let page = 1; page <= DEAL_SCAN_MAX_PAGES; page++) {
    const answer = await callOwner({
      owner: "activities",
      op: "list-by-deal",
      method: "GET",
      baseUrl: env.ACTIVITIES_API_URL,
      path: "/activities",
      authorization,
      query: new URLSearchParams({ dealId, page: String(page), pageSize: String(DEAL_SCAN_PAGE_SIZE) }),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });
    if (answer.kind === "unavailable") return UNAVAILABLE;
    const parsed = dealPageBody.safeParse(answer.json);
    if (!parsed.success) return unavailable("activities", "list-by-deal", "malformed");

    for (const wire of parsed.data.items) {
      // An activity about another deal is an owner that ignored the filter: it must never make the caller involved here.
      if (wire.deal?.id !== dealId) return unavailable("activities", "list-by-deal", "filter_ignored");
      if (!items.has(wire.id)) items.set(wire.id, toFact(wire));
    }
    if (page * DEAL_SCAN_PAGE_SIZE >= parsed.data.total) {
      // The whole list, or the owner's `total` and its pages disagree (a page ignored, a write in between): not a complete answer.
      if (items.size !== parsed.data.total) return unavailable("activities", "list-by-deal", "incomplete");
      return { state: "ok", items: [...items.values()], truncated: false };
    }
    if (parsed.data.items.length === 0) return unavailable("activities", "list-by-deal", "incomplete");
  }
  return { state: "ok", items: [...items.values()], truncated: true };
}
