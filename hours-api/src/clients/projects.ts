/**
 * projects-api's activity-host resolve, asked as the caller (specs/20261112-time-tracking T11; plan § Sequences "On a
 * project", ADR 20261112-time-bookability-asked-of-owners-meeting-hosts-system-route, AC-2.2, AC-2.10, AC-2.11, AC-4.10).
 *
 *   POST {PROJECTS_API_URL}/activity-host/v1/resolve  { entityType: "project", ids }  (≤ 25 ids)
 *
 * `reader` is the caller's `projects:access`: without it the answer is `not_reader` and every id is
 * as good as missing (the same 404 as a project that does not exist, AC-2.10). For a reader each id is
 * `missing` or `open`, and an open project says who is `assignees`: its project manager and its team
 * (a project from a deal still awaiting its manager answers its team only), the people who may book
 * time on it. `writable` is false for a closed or cancelled project; entries are accepted in any state
 * (A12), so hours-api reads it only to ignore it. It also says who MANAGES the project (`projectManagerId`,
 * specs/20261112-project-hours AC-2.3): the one fact that lets the manager see its hours per person.
 *
 * See `owner.ts` for what counts as an answer and what is `unavailable`.
 */

import { z } from "zod";
import { env } from "../lib/env";
import { isSuitePath, resolveAtHost, type CallOptions, type HostResolve, type ResolveOutcome } from "./owner";

export type ResolvedProject =
  | { readonly state: "missing" }
  | {
      readonly state: "open";
      readonly label: string;
      /** A path inside the suite (`/projects/<id>`), checked. */
      readonly href: string;
      readonly writable: boolean;
      /**
       * The project manager and the team (attached teams' members included): the people who may book time on
       * it. `null` is "the host could not find out" (a team's members unavailable), never "nobody": the label
       * still resolves, a booking is refused (specs/20261126-teams D3, AC-5.4).
       */
      readonly assignees: readonly string[] | null;
      /**
       * The project's manager, the one fact the per-person figure of a record's hours turns on (specs/20261112-project-hours AC-2.3, plan D-P2):
       * a user id; `null` while the project still awaits one (AC-2.7: nobody is its manager, so only holders of see everyone's hours see it per
       * person); `undefined` from a projects-api that predates the member. `undefined` is not `null` — it means "not stated" — but neither is ever
       * a grant: only an id equal to the caller's is.
       */
      readonly projectManagerId: string | null | undefined;
    };

const nonEmpty = z.string().min(1);

const wireItem = z.discriminatedUnion("state", [
  z.object({ id: nonEmpty, state: z.literal("missing") }),
  z.object({
    id: nonEmpty,
    state: z.literal("open"),
    writable: z.boolean(),
    label: nonEmpty,
    href: z.string(),
    // The people a task may go to: absent is not "nobody", and neither is null ("unknown", D3); only absent is malformed.
    assignees: z.array(nonEmpty).nullable(),
    // The manager: a user id, `null` (awaiting one), or absent (a projects-api before specs/20261112-project-hours T2). Anything else breaks the contract.
    projectManagerId: nonEmpty.nullable().optional(),
  }),
]);

const config = (): HostResolve<z.infer<typeof wireItem>, ResolvedProject> => ({
  owner: "projects",
  entityType: "project",
  baseUrl: env.PROJECTS_API_URL,
  item: wireItem,
  toResolved(item) {
    if (item.state === "missing") return { state: "missing" };
    if (!isSuitePath(item.href)) return undefined;
    return {
      state: "open",
      label: item.label,
      href: item.href,
      writable: item.writable,
      assignees: item.assignees === null ? null : [...new Set(item.assignees)],
      projectManagerId: item.projectManagerId,
    };
  },
});

/** One entry per distinct id in `ids` — `open` or `missing` — for a reader; `not_reader`; or `unavailable`. */
export function resolveProjects(
  authorization: string,
  ids: readonly string[],
  options?: CallOptions,
): Promise<ResolveOutcome<ResolvedProject>> {
  return resolveAtHost(config(), authorization, ids, options);
}
