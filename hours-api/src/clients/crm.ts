/**
 * crm-api's activity-host resolve for deals, asked as the caller (specs/029 T11; plan § Sequences
 * "Record an entry on a deal", ADR-0089, AC-2.3, AC-2.10, AC-2.11, AC-4.10; crm-api T7).
 *
 *   POST {CRM_API_URL}/activity-host/v1/resolve  { entityType: "deal", ids }  (≤ 25 ids, no `related`)
 *
 * `reader` is the caller's `crm:access`; without it the answer is `not_reader`, with no item at all, so
 * not even whether a deal exists leaks (the same 404 as a deal that does not exist, AC-2.10). For a
 * reader each id is `missing` or `open` (a deal in ANY stage, won and lost included, A13) and an open
 * deal says who is `involved`: its owner and, once an estimate is linked, its technical contact — the
 * CRM's half of "who may book time on this deal"; the other half, a task's assignee or an activity's
 * participant, is asked of activities-api (`activities.ts`).
 *
 * A crm-api that predates T7 answers 422 to `entityType: "deal"` (plan R7): `unavailable`, never
 * "missing". See `owner.ts` for what counts as an answer.
 */

import { z } from "zod";
import { env } from "../lib/env";
import { isSuitePath, resolveAtHost, type CallOptions, type HostResolve, type ResolveOutcome } from "./owner";

export type ResolvedDeal =
  | { readonly state: "missing" }
  | {
      readonly state: "open";
      readonly label: string;
      /** A path inside the suite (`/crm/deals/<id>`), checked. */
      readonly href: string;
      /** User ids: the owner and the technical contact, each once. */
      readonly involved: readonly string[];
    };

const nonEmpty = z.string().min(1);

const wireItem = z.discriminatedUnion("state", [
  z.object({ id: nonEmpty, state: z.literal("missing") }),
  z.object({
    id: nonEmpty,
    state: z.literal("open"),
    label: nonEmpty,
    href: z.string(),
    // Who is involved: absent is not "nobody".
    involved: z.array(nonEmpty),
  }),
]);

const config = (): HostResolve<z.infer<typeof wireItem>, ResolvedDeal> => ({
  owner: "crm",
  entityType: "deal",
  baseUrl: env.CRM_API_URL,
  item: wireItem,
  toResolved(item) {
    if (item.state === "missing") return { state: "missing" };
    if (!isSuitePath(item.href)) return undefined;
    return { state: "open", label: item.label, href: item.href, involved: [...new Set(item.involved)] };
  },
});

/** One entry per distinct id in `ids` — `open` or `missing` — for a reader; `not_reader`; or `unavailable`. */
export function resolveDeals(authorization: string, ids: readonly string[], options?: CallOptions): Promise<ResolveOutcome<ResolvedDeal>> {
  return resolveAtHost(config(), authorization, ids, options);
}
