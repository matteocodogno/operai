/**
 * projects-api's activity-host resolve, asked as the caller (specs/029 T11; plan § Sequences "On a
 * project", ADR-0089, AC-2.2, AC-2.10, AC-2.11, AC-4.10).
 *
 *   POST {PROJECTS_API_URL}/activity-host/v1/resolve  { entityType: "project", ids }  (≤ 25 ids)
 *
 * `reader` is the caller's `projects:access`: without it the answer is `not_reader` and every id is
 * as good as missing (the same 404 as a project that does not exist, AC-2.10). For a reader each id is
 * `missing` or `open`, and an open project says who is `assignees`: its project manager and its team
 * (a project from a deal still awaiting its manager answers its team only), the people who may book
 * time on it. `writable` is false for a closed or cancelled project; entries are accepted in any state
 * (A12), so hours-api reads it only to ignore it.
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
      /** The project manager and the team: the people who may book time on it. */
      readonly assignees: readonly string[];
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
    // The people a task may go to: absent is not "nobody".
    assignees: z.array(nonEmpty),
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
    return { state: "open", label: item.label, href: item.href, writable: item.writable, assignees: [...new Set(item.assignees)] };
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
