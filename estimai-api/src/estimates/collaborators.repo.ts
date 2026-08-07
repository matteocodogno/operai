/**
 * Prisma data-access layer for collaborator management (T8/T9,
 * specs/013-estimate-sharing, plan.md "Data model" / "API contracts —
 * estimai-api — new").
 *
 * This module is DB-only — it never calls `auth` (that requires the caller's
 * Bearer header, which only exists in collaborators.routes.ts) and never
 * decides HTTP status codes. It returns raw rows (carrying `userId`, never a
 * resolved display identity) plus two narrow, locally-defined tagged errors
 * for the two DB-level conflict shapes T8 needs:
 *
 *   - AlreadyCollaboratorError — the `(estimateId, email)` fast-path duplicate
 *     check (AC-1.3) AND the `(estimateId, userId)` unique-constraint
 *     violation on insert (the stale-email-snapshot race the fast path
 *     cannot catch, plan.md step 8: "an email-snapshot mismatch cannot create
 *     a duplicate grant").
 *
 * Defined here rather than added to `src/lib/errors.ts` because they are
 * specific to this table's conflict shape and not part of the shared
 * DatabaseError/NotFoundError/ForbiddenError vocabulary every other
 * estimate-scoped repo function already uses (which this module also reuses
 * for the plain DB-failure and not-found cases).
 */

import { Effect, Data } from "effect";
import { db } from "@/lib/db";
import { DatabaseError } from "@/lib/errors";
import { Prisma } from "@/lib/generated/prisma/client";
import type { CollaboratorAccessLevel } from "./collaborators.schemas";

// ─── Errors ───────────────────────────────────────────────────────────────────

/**
 * A grant already exists for this estimate — either matched by the
 * `(estimateId, email)` fast-path lookup (AC-1.3's normal case) or surfaced
 * as a unique-constraint violation on `(estimateId, userId)` at INSERT time
 * (the race where the existing grant's stored email snapshot differs from
 * the email just submitted, but both resolve to the same `auth` `userId`).
 * `existingAccessLevel` is populated when known (the fast-path case); the
 * INSERT-time race does not re-fetch it before failing.
 */
export class AlreadyCollaboratorError extends Data.TaggedError(
  "AlreadyCollaboratorError",
)<{
  readonly message: string;
  readonly existingAccessLevel?: CollaboratorAccessLevel;
}> {}

/** True when `error` is a Prisma unique-constraint violation (P2002). */
const isUniqueConstraintViolation = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";

// ─── Row shapes ───────────────────────────────────────────────────────────────

export interface CollaboratorRow {
  readonly id: string;
  readonly estimateId: string;
  readonly userId: string;
  readonly email: string;
  readonly accessLevel: CollaboratorAccessLevel;
  readonly createdAt: string;
}

const toRow = (row: {
  id: string;
  estimateId: string;
  userId: string;
  email: string;
  accessLevel: string;
  createdAt: Date;
}): CollaboratorRow => ({
  id: row.id,
  estimateId: row.estimateId,
  userId: row.userId,
  email: row.email,
  accessLevel: row.accessLevel as CollaboratorAccessLevel,
  createdAt: row.createdAt.toISOString(),
});

// ─── Repository functions ─────────────────────────────────────────────────────

/**
 * Lists every collaborator grant on `estimateId`, oldest-first (stable,
 * predictable ordering for the owner's panel). Owner-only visibility is
 * enforced by the caller (collaborators.routes.ts, via `resolveAccess`) —
 * this function does not re-check access.
 */
export const listCollaborators = (
  estimateId: string,
): Effect.Effect<CollaboratorRow[], DatabaseError> =>
  Effect.tryPromise({
    try: async () => {
      const rows = await db.estimateCollaborator.findMany({
        where: { estimateId },
        orderBy: { createdAt: "asc" },
      });
      return rows.map(toRow);
    },
    catch: (cause) =>
      new DatabaseError({ message: "Failed to list collaborators", cause }),
  });

/**
 * AC-1.3's fast duplicate-check path — no `auth` round trip. Uses the
 * `(estimateId, email)` index (plan.md's "Data model" — `@@index([estimateId,
 * email])`). Returns `null` when no grant exists for this exact (lower-cased)
 * email snapshot; a differently-cased or alias email that nonetheless
 * resolves to the SAME `auth` userId is NOT caught here — that race is
 * caught by `insertCollaborator`'s unique-constraint mapping instead
 * (plan.md step 8).
 */
export const findCollaboratorByEmail = (
  estimateId: string,
  normalizedEmail: string,
): Effect.Effect<CollaboratorRow | null, DatabaseError> =>
  Effect.tryPromise({
    try: async () => {
      const row = await db.estimateCollaborator.findFirst({
        where: { estimateId, email: normalizedEmail },
      });
      return row ? toRow(row) : null;
    },
    catch: (cause) =>
      new DatabaseError({ message: "Failed to check for an existing collaborator", cause }),
  });

export interface InsertCollaboratorInput {
  readonly estimateId: string;
  readonly userId: string;
  readonly email: string;
  readonly accessLevel: CollaboratorAccessLevel;
  readonly grantedByUserId: string;
}

/**
 * Creates a new collaborator grant (plan.md step 8). `userId` MUST already
 * be the `auth`-resolved id from `checkAppAccess`'s `eligible:true` response
 * — never derived from the request body (OWASP A01).
 *
 * A `(estimateId, userId)` unique-constraint violation — the stale-email-
 * snapshot race findCollaboratorByEmail's email-keyed lookup cannot catch —
 * is mapped to `AlreadyCollaboratorError` (no `existingAccessLevel`, since
 * this path deliberately does not pay for a re-fetch just to enrich a 409
 * that is already handled generically by the route).
 */
export const insertCollaborator = (
  input: InsertCollaboratorInput,
): Effect.Effect<CollaboratorRow, DatabaseError | AlreadyCollaboratorError> =>
  Effect.tryPromise({
    try: async () => {
      const row = await db.estimateCollaborator.create({
        data: {
          estimateId: input.estimateId,
          userId: input.userId,
          email: input.email,
          accessLevel: input.accessLevel,
          grantedByUserId: input.grantedByUserId,
        },
      });
      return toRow(row);
    },
    catch: (cause) => {
      if (isUniqueConstraintViolation(cause)) {
        return new AlreadyCollaboratorError({
          message: "This person already has access to this estimate.",
        });
      }
      return new DatabaseError({ message: "Failed to add collaborator", cause });
    },
  });
