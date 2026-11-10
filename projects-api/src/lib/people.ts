/**
 * Person references in responses (specs/025-projects, AC-1.6): collect every user id a
 * response mentions, resolve them in one `resolveIdentities` call (fail soft), then map
 * each id to its `Person = { id, name, deleted }`. Names are live, never stored
 * (ADR-0039); an unknown or deleted user has `name: null`.
 */

import type { HeaderSource } from "./http";
import { resolveIdentities, type Identity } from "./identities";

export interface Person {
  readonly id: string;
  readonly name: string | null;
  readonly deleted: boolean;
}

export type People = (id: string) => Person;
export type OptionalPeople = (id: string | null) => Person | null;

// `resolveIdentities` already surfaces a name for an active user only.
const toPerson = (identity: Identity): Person => ({
  id: identity.id,
  name: identity.name,
  deleted: identity.status === "deleted",
});

/** Resolves `ids` (nulls ignored) and returns a lookup that never misses. */
export async function loadPeople(
  c: HeaderSource,
  ids: readonly (string | null | undefined)[],
): Promise<{ person: People; maybe: OptionalPeople }> {
  const wanted = ids.filter((id): id is string => typeof id === "string" && id !== "");
  const resolved =
    wanted.length > 0
      ? await resolveIdentities(c.req.header("Authorization") ?? "", wanted)
      : new Map<string, Identity>();
  const person: People = (id) => toPerson(resolved.get(id) ?? { id, name: null, status: "unknown" });
  return { person, maybe: (id) => (id === null ? null : person(id)) };
}
