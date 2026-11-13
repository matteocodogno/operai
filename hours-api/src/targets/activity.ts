/**
 * May an entry on this project or deal point at this activity? Asked of activities-api, AS THE CALLER, when the
 * pointer is new on the entry or carried to another target (specs/029 T16; plan § Sequences step 5, "A change and a
 * move"; AC-2.7, AC-2.11; ledger D47; ADR-0089).
 *
 * The pointer is the entry's own claim that its hours went into this task or this call, so it must be an activity
 * ABOUT the project or the deal the entry is on — a task of the project, an activity of the deal — and one the caller
 * may read: activities-api answers as the caller and leaves out an activity they may not read exactly as it leaves
 * out one that does not exist, so both are the one 422 and nothing tells them apart (AC-2.10's posture).
 *
 * What this module decides, and what it does not:
 *   - the activity is not there for the caller, or is about something else      → 422 activity_not_allowed
 *   - activities-api did not answer, or answered with a list that ignored `ids` → 503 host_unavailable (the client
 *     reads "another activity and not the asked one" as `unavailable`, never as "absent": that would be a false 422)
 * A target that is a meeting or no entity never gets here: it takes no activity, decided locally with no call
 * (src/entries/rules.ts `activityNotAllowed`).
 *
 * Whether to ask at all is the route's decision, not this module's: never for `activityId: null`, never for a pointer
 * that is already stored and whose target did not change (D47). Every id reaching here has passed the id rule
 * (src/lists/idRule.ts), which keeps a comma and a blank out of the `ids` parameter (plan R7).
 */

import { listActivitiesByIds } from "../clients/activities";
import { activityNotAllowed } from "../entries/rules";
import type { Caller } from "./bookability";
import { hostUnavailable } from "./errors";

/** The activity an entry will point at, and the project or the deal the entry will be on. */
export interface Pointer {
  readonly id: string;
  readonly target: { readonly type: "project" | "deal"; readonly id: string };
}

/**
 * Resolves unless `pointer.id` is not an activity of `pointer.target` that the caller may read; then throws the
 * `ProblemError` that says why (above).
 */
export async function assertActivityOf({ authorization }: Pick<Caller, "authorization">, pointer: Pointer): Promise<void> {
  const outcome = await listActivitiesByIds(authorization, [pointer.id]);
  if (outcome.state === "unavailable") throw hostUnavailable();

  const activity = outcome.items.get(pointer.id);
  if (activity === undefined) throw activityNotAllowed();
  // A task of the project (an operational activity), or a pre-sales activity of the deal.
  const about = pointer.target.type === "project" ? activity.projectId : activity.dealId;
  if (about !== pointer.target.id) throw activityNotAllowed();
}
