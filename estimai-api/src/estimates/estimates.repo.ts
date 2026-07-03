/**
 * Prisma data-access layer for the Estimates API (T4, specs/001-estimate-persistence).
 *
 * SECURITY: every function is scoped by `userId` derived from the verified JWT `sub`.
 * The userId is NEVER taken from the request body or path — only from the context
 * variable set by jwtMiddleware after RS256 signature verification.
 *
 * Ownership is enforced at the query level:
 *  - create:  userId is always the caller's sub
 *  - list:    where: { userId }
 *  - getById: where: { id, userId }  — "not yours" === "not found" (AC-4.1)
 *  - update:  where: { id, userId }  — "not yours" === "not found" (AC-4.1)
 *  - delete:  findFirst({ where: { id, userId } }) then delete by id
 *
 * sizeBytes is computed here as the UTF-8 byte length of the serialized content.
 * T5 will enforce the limit; T4 only populates the column.
 */

import { Effect } from "effect";
import type { InputJsonValue } from "@prisma/client/runtime/client";
import { db } from "@/lib/db";
import { DatabaseError, NotFoundError } from "@/lib/errors";
import type { EstimateContent, EstimateFull, EstimateListItem } from "./estimates.schemas";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Compute the UTF-8 byte length of the JSON-serialised content.
 * This is stored in `sizeBytes` so the size guard (T5) can check it without
 * parsing the JSONB column, and so the list query never touches `content`.
 */
const computeSizeBytes = (content: EstimateContent): number =>
  new TextEncoder().encode(JSON.stringify(content)).length;

/** Map a Prisma Estimate row to the API EstimateFull shape. */
const toFull = (row: {
  id: string;
  name: string;
  author: string;
  content: unknown;
  createdAt: Date;
  updatedAt: Date;
}): EstimateFull => ({
  id: row.id,
  name: row.name,
  author: row.author,
  content: row.content as EstimateContent,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

/** Map a Prisma Estimate row to the API EstimateListItem shape. */
const toListItem = (row: {
  id: string;
  name: string;
  author: string;
  updatedAt: Date;
}): EstimateListItem => ({
  id: row.id,
  name: row.name,
  author: row.author,
  updatedAt: row.updatedAt.toISOString(),
});

// ─── Repository functions ─────────────────────────────────────────────────────

/**
 * Create a new estimate owned by `userId`.
 * sizeBytes is computed from the serialized content and stored alongside it.
 */
export const createEstimate = (
  userId: string,
  name: string,
  author: string,
  content: EstimateContent,
): Effect.Effect<EstimateFull, DatabaseError> =>
  Effect.tryPromise({
    try: async () => {
      const sizeBytes = computeSizeBytes(content);
      const row = await db.estimate.create({
        data: { userId, name, author, sizeBytes, content: content as unknown as InputJsonValue },
      });
      return toFull(row);
    },
    catch: (cause) =>
      new DatabaseError({ message: "Failed to create estimate", cause }),
  });

/**
 * List all estimates for `userId`, ordered newest-first.
 * Returns only list-view columns — no `content` is fetched.
 */
export const listEstimates = (
  userId: string,
): Effect.Effect<EstimateListItem[], DatabaseError> =>
  Effect.tryPromise({
    try: async () => {
      const rows = await db.estimate.findMany({
        where: { userId },
        orderBy: { updatedAt: "desc" },
        select: { id: true, name: true, author: true, updatedAt: true },
      });
      return rows.map(toListItem);
    },
    catch: (cause) =>
      new DatabaseError({ message: "Failed to list estimates", cause }),
  });

/**
 * Get a single estimate by id, scoped to userId.
 * Returns NotFoundError when the id does not exist OR belongs to a different
 * user — the caller cannot distinguish the two cases (AC-4.1).
 */
export const getEstimateById = (
  id: string,
  userId: string,
): Effect.Effect<EstimateFull, DatabaseError | NotFoundError> =>
  Effect.tryPromise({
    try: async () => {
      const row = await db.estimate.findFirst({
        where: { id, userId },
      });
      return row;
    },
    catch: (cause) =>
      new DatabaseError({ message: "Failed to fetch estimate", cause }),
  }).pipe(
    Effect.flatMap((row) =>
      row !== null
        ? Effect.succeed(toFull(row))
        : Effect.fail(
            new NotFoundError({
              message: `Estimate ${id} not found`,
            }),
          ),
    ),
  );

/**
 * Update an existing estimate in place, scoped to userId.
 * updatedAt is advanced automatically by Prisma (@updatedAt).
 * sizeBytes is recomputed from the new content.
 *
 * Ownership check: we first attempt findFirst({ where: { id, userId } }).
 * If the row does not exist (id absent or owned by a different user) we return
 * NotFoundError — the caller sees 404 in both cases (AC-4.1).
 *
 * The actual update uses `update({ where: { id } })` after the ownership check
 * passes, because Prisma's `update` requires a unique predicate.
 */
export const updateEstimate = (
  id: string,
  userId: string,
  name: string,
  author: string,
  content: EstimateContent,
): Effect.Effect<EstimateFull, DatabaseError | NotFoundError> =>
  Effect.tryPromise({
    try: async () => {
      // First verify ownership (scoped check).
      const existing = await db.estimate.findFirst({ where: { id, userId } });
      if (!existing) return null;

      const sizeBytes = computeSizeBytes(content);
      const updated = await db.estimate.update({
        where: { id },
        data: { name, author, sizeBytes, content: content as unknown as InputJsonValue },
      });
      return updated;
    },
    catch: (cause) =>
      new DatabaseError({ message: "Failed to update estimate", cause }),
  }).pipe(
    Effect.flatMap((row) =>
      row !== null
        ? Effect.succeed(toFull(row))
        : Effect.fail(
            new NotFoundError({
              message: `Estimate ${id} not found`,
            }),
          ),
    ),
  );

/**
 * Delete an estimate by id, scoped to userId.
 * Returns NotFoundError when absent or not owned (AC-4.1).
 *
 * We use findFirst+delete rather than deleteMany so we can distinguish
 * "not found / not owned" (→ 404) from a database error.
 */
export const deleteEstimate = (
  id: string,
  userId: string,
): Effect.Effect<void, DatabaseError | NotFoundError> =>
  Effect.tryPromise({
    try: async () => {
      const existing = await db.estimate.findFirst({ where: { id, userId } });
      if (!existing) return false;

      await db.estimate.delete({ where: { id } });
      return true;
    },
    catch: (cause) =>
      new DatabaseError({ message: "Failed to delete estimate", cause }),
  }).pipe(
    Effect.flatMap((deleted) =>
      deleted
        ? Effect.succeed(undefined)
        : Effect.fail(
            new NotFoundError({
              message: `Estimate ${id} not found`,
            }),
          ),
    ),
  );
