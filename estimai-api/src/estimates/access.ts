/**
 * Access resolution for estimates (T6, specs/013-estimate-sharing).
 *
 * `resolveAccess` is the single source of truth for "what can this caller do
 * with this estimate" — every owner-scoped query in estimates.repo.ts (and,
 * later, collaborators.repo.ts in T8/T9) goes through it rather than
 * re-deriving the same OR-predicate ad hoc.
 *
 * ONE query: fetch the estimate by id, including only the CALLER'S OWN
 * collaborator row (filtered by userId in the `include`, not a separate
 * round trip). `row.userId === callerId` → owner; else the collaborator
 * row's level; else `null` (no relationship at all).
 *
 * DENIAL TAXONOMY (plan.md "Access resolution inside estimai-api" — a
 * deliberate narrowing of ADR-0005's blanket "not owned = 404"):
 *   - `null` (no relationship at all)         → the caller maps this to 404.
 *     A stranger learns nothing about the estimate's existence (ADR-0005
 *     intact).
 *   - non-null but the level is insufficient  → the caller maps this to 403.
 *     A viewer attempting PUT, or any collaborator attempting DELETE/
 *     collaborator-management, already knows the estimate exists (they can
 *     open it) — a 404 here would be a lie and would make the UI unable to
 *     distinguish "gone" from "not allowed".
 *
 * This module does NOT decide 403 vs 404 itself — that decision depends on
 * the operation being attempted (e.g. any relationship is enough for GET,
 * but DELETE requires "owner"), so it stays with each call site. This
 * module only answers "what relationship, if any, exists".
 */

import { Effect } from "effect";
import { db } from "@/lib/db";
import { DatabaseError } from "@/lib/errors";

export type AccessLevel = "owner" | "editor" | "viewer";

export interface ResolvedAccess {
  readonly level: AccessLevel;
  readonly version: number;
  readonly ownerId: string;
}

/**
 * Resolves `callerId`'s relationship to estimate `estimateId`.
 *
 * Returns `null` when the estimate does not exist OR the caller has no
 * relationship to it (owner or collaborator) — the two cases are
 * INDISTINGUISHABLE to every caller of this function, by construction
 * (AC-1.6 / ADR-0005).
 */
export const resolveAccess = (
  estimateId: string,
  callerId: string,
): Effect.Effect<ResolvedAccess | null, DatabaseError> =>
  Effect.tryPromise({
    try: async () => {
      const row = await db.estimate.findUnique({
        where: { id: estimateId },
        select: {
          userId: true,
          version: true,
          collaborators: {
            where: { userId: callerId },
            select: { accessLevel: true },
            take: 1,
          },
        },
      });

      if (row === null) {
        return null;
      }

      if (row.userId === callerId) {
        return { level: "owner" as const, version: row.version, ownerId: row.userId };
      }

      const grant = row.collaborators[0];
      if (!grant) {
        return null;
      }

      return {
        level: grant.accessLevel as AccessLevel,
        version: row.version,
        ownerId: row.userId,
      };
    },
    catch: (cause) =>
      new DatabaseError({ message: "Failed to resolve estimate access", cause }),
  });
