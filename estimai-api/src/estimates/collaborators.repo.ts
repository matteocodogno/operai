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

// ─── T9 — manage / revoke / leave ─────────────────────────────────────────────
//
// GET/POST above are T8. The four functions below back
// PATCH/DELETE {collaboratorId} and DELETE me (T9, plan.md "API contracts —
// estimai-api — new"). Like the rest of this module they are DB-only and do
// not decide HTTP status codes or re-check owner-only access — that stays
// with collaborators.routes.ts via `resolveAccess` (T6), exactly as GET/POST
// already do.

/**
 * Looks up a single grant by its GRANT id, scoped to `estimateId` (T9,
 * PATCH/DELETE `{collaboratorId}`, AC-5.1/AC-5.2/AC-5.4). Scoping by BOTH
 * fields means a grant id lifted from a different estimate — or a wholly
 * fabricated id, including the deliberate AC-5.4 case of a caller guessing
 * an id shaped like the OWNER's own `sub` — returns `null` here exactly like
 * a grant that never existed; an owner never has an `EstimateCollaborator`
 * row of their own (AC-1.4), so there is nothing to find either way.
 */
export const findCollaboratorById = (
  estimateId: string,
  collaboratorId: string,
): Effect.Effect<CollaboratorRow | null, DatabaseError> =>
  Effect.tryPromise({
    try: async () => {
      const row = await db.estimateCollaborator.findFirst({
        where: { id: collaboratorId, estimateId },
      });
      return row ? toRow(row) : null;
    },
    catch: (cause) =>
      new DatabaseError({ message: "Failed to look up the collaborator grant", cause }),
  });

/**
 * Updates a grant's `accessLevel` (T9, `PATCH .../collaborators/{collaboratorId}`,
 * AC-5.1). Callers MUST have already confirmed the row exists via
 * `findCollaboratorById` (the route handler does, to produce the right 404) —
 * this function assumes it does and does not re-derive a 404 case itself.
 * No notification is fired anywhere in this path (AC-7.3) — the route
 * handler simply never calls `notify.ts` here.
 */
export const updateCollaboratorAccessLevel = (
  collaboratorId: string,
  accessLevel: CollaboratorAccessLevel,
): Effect.Effect<CollaboratorRow, DatabaseError> =>
  Effect.tryPromise({
    try: async () => {
      const row = await db.estimateCollaborator.update({
        where: { id: collaboratorId },
        data: { accessLevel },
      });
      return toRow(row);
    },
    catch: (cause) =>
      new DatabaseError({ message: "Failed to update the collaborator's access level", cause }),
  });

/**
 * Removes a grant by its GRANT id (T9, owner-initiated
 * `DELETE .../collaborators/{collaboratorId}`, AC-5.2). Like
 * `updateCollaboratorAccessLevel`, assumes the route handler already
 * confirmed existence via `findCollaboratorById`. Returns the row as it was
 * immediately before deletion so T10's best-effort removal notification can
 * read the departed collaborator's `userId` without a second round trip —
 * nothing in T9 calls `notify.ts` with it yet (that wiring is T10's scope).
 */
export const deleteCollaboratorById = (
  collaboratorId: string,
): Effect.Effect<CollaboratorRow, DatabaseError> =>
  Effect.tryPromise({
    try: async () => {
      const row = await db.estimateCollaborator.delete({ where: { id: collaboratorId } });
      return toRow(row);
    },
    catch: (cause) => new DatabaseError({ message: "Failed to remove the collaborator", cause }),
  });

/**
 * Looks up the CALLER's own grant on `estimateId` by `(estimateId, userId)`
 * — the same unique key `insertCollaborator` relies on (T9,
 * `DELETE .../collaborators/me`, AC-6.1/AC-6.2). Returns `null` for a
 * genuine stranger, a collaborator on a DIFFERENT estimate, AND — the
 * AC-6.2 case — the OWNER themselves, indistinguishably: an owner never has
 * an `EstimateCollaborator` row of their own (AC-1.4), so this lookup simply
 * finds nothing for them, exactly as it would for anyone else with no grant.
 */
export const findCollaboratorByUserId = (
  estimateId: string,
  userId: string,
): Effect.Effect<CollaboratorRow | null, DatabaseError> =>
  Effect.tryPromise({
    try: async () => {
      const row = await db.estimateCollaborator.findUnique({
        where: { estimateId_userId: { estimateId, userId } },
      });
      return row ? toRow(row) : null;
    },
    catch: (cause) =>
      new DatabaseError({ message: "Failed to look up the caller's own collaborator grant", cause }),
  });

/**
 * Removes the CALLER's own grant (T9, `DELETE .../collaborators/me`,
 * AC-6.1). Callers MUST have already confirmed the row exists via
 * `findCollaboratorByUserId`. NO notification is ever fired for this path
 * (AC-7.2 explicitly excludes self-leave) — collaborators.routes.ts simply
 * never calls `notify.ts` here, now or in T10.
 */
export const deleteCollaboratorByUserId = (
  estimateId: string,
  userId: string,
): Effect.Effect<void, DatabaseError> =>
  Effect.tryPromise({
    try: async () => {
      await db.estimateCollaborator.delete({
        where: { estimateId_userId: { estimateId, userId } },
      });
    },
    catch: (cause) =>
      new DatabaseError({ message: "Failed to remove the caller's own collaborator grant", cause }),
  });

// ─── T10 — notification wiring ─────────────────────────────────────────────

/**
 * Reads a single estimate's current `name` (T10, specs/013-estimate-sharing,
 * plan.md "Notifications (US-7)"). The ONLY thing `POST`/owner-initiated
 * `DELETE .../collaborators/{collaboratorId}` need from the `estimate` row
 * that isn't already carried by `resolveAccess`'s narrower `{level, version,
 * ownerId}` shape (T6, access.ts) — kept as its own single-field query here
 * rather than widening `resolveAccess` itself, since that function is shared
 * by every estimate-scoped read/write path in estimates.repo.ts and has no
 * other reason to carry `name`.
 *
 * Called ONLY after the grant/removal transaction has already committed
 * (plan.md step 9 / AC-7.2) — never gates access itself. Returns `null` on
 * the (effectively unreachable, since the caller just wrote to this same
 * row) chance the estimate vanished between the write and this read; the
 * caller falls back to an empty name rather than failing the already-
 * committed response.
 */
export const findEstimateName = (
  estimateId: string,
): Effect.Effect<string | null, DatabaseError> =>
  Effect.tryPromise({
    try: async () => {
      const row = await db.estimate.findUnique({
        where: { id: estimateId },
        select: { name: true },
      });
      return row?.name ?? null;
    },
    catch: (cause) =>
      new DatabaseError({ message: "Failed to look up the estimate's name", cause }),
  });
