/**
 * Whose entries a read selects (specs/029 T19; plan § Sequences "Oversight", § Totals "Person filter"; AC-4.2, AC-4.3,
 * AC-5.4, ADR-0075).
 *
 * `whose=mine` is the caller's own and asks nobody: a person's own hours need only a session (AC-5.1), and keep
 * working when `auth` is down. `whose=all` — and the `userId` filter, which is a question about everyone's — is the
 * oversight path: the caller must hold `time-entry:read-all`, asked live of `auth` as the caller (./oversight.ts),
 * and the answer is the only thing that ever lets a query leave the caller's own rows.
 */

import type { EntryFilters } from "../entries/filters";
import { authzUnavailable, readAllRequired } from "./errors";
import { holdsReadAll, OversightUnavailableError, type Session } from "./oversight";

/** Whose entries a read selects: one person's, or everyone's — which only `readScope` ever hands out. */
export type EntryScope = { readonly kind: "person"; readonly userId: string } | { readonly kind: "everyone" };

/**
 * The scope of a read whose filters are valid (`readFilters` has agreed `whose` and `userId`). Throws 403
 * `read_all_required` for `whose=all` without the permission and 503 `authz_unavailable` when `auth` cannot say.
 * Decided before any owner is asked and before the database is read.
 */
export async function readScope(filters: EntryFilters, session: Session): Promise<EntryScope> {
  if (filters.whose === "mine") return { kind: "person", userId: session.sub };
  let holds: boolean;
  try {
    holds = await holdsReadAll(session);
  } catch (err) {
    throw err instanceof OversightUnavailableError ? authzUnavailable() : err;
  }
  if (!holds) throw readAllRequired();
  return filters.userId === undefined ? { kind: "everyone" } : { kind: "person", userId: filters.userId };
}
