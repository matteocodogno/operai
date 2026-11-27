/**
 * Person references in responses (specs/20261110-activities; carried over from crm-api, D-15): collect every
 * user id a response mentions, resolve them in one `resolveIdentities` call (fail soft), then
 * map each id to its `PersonRef`.
 */

import type { HeaderSource } from "./http";
import { resolveIdentities, type Identity } from "./identities";

export type PersonRef = Identity;

export type People = (id: string) => PersonRef;
export type OptionalPeople = (id: string | null) => PersonRef | null;

/**
 * The longest a response waits, in all, for the names it shows (specs/20261126-teams R13 b, ADR 20261119-on-demand-outbound-work-...).
 * activities-api's list routes answer hours-api inside its 6 s, after up to two sequential host rounds of 2 s: a slow `auth` must cost
 * the names (`unknown`, the fail-soft display), not the page. The lookup is not aborted, it keeps `REQUEST_TIMEOUT_MS` per batch and
 * fills the 60 s cache, so the next load has the names. Pinned by `hours-api/src/clients/owners.budgets.cross-package.test.ts`.
 */
export const NAMES_WAIT_MS = 800;

/** Resolves `ids` (nulls ignored) and returns a lookup that never misses. */
export async function loadPeople(
  c: HeaderSource,
  ids: readonly (string | null | undefined)[],
): Promise<{ person: People; maybe: OptionalPeople }> {
  const wanted = ids.filter((id): id is string => typeof id === "string" && id !== "");
  const resolved =
    wanted.length > 0
      ? await resolveIdentities(c.req.header("Authorization") ?? "", wanted, { waitMs: NAMES_WAIT_MS })
      : new Map<string, Identity>();
  const person: People = (id) => resolved.get(id) ?? { id, name: null, status: "unknown" };
  return { person, maybe: (id) => (id === null ? null : person(id)) };
}
