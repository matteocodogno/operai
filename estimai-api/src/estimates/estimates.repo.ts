/**
 * Prisma data-access layer for the Estimates API.
 * (T4, specs/001-estimate-persistence; widened for sharing in T6,
 * specs/013-estimate-sharing — see plan.md "Access resolution inside
 * estimai-api" / the per-call-site table.)
 *
 * SECURITY: every function is scoped by `userId` derived from the verified JWT `sub`.
 * The userId is NEVER taken from the request body or path — only from the context
 * variable set by jwtMiddleware after RS256 signature verification.
 *
 * Ownership/access is enforced at the query level:
 *  - create:  userId is always the caller's sub (owner is always the creator, unchanged)
 *  - list:    where: OR[{userId}, {collaborators: {some: {userId}}}] — owner UNION grantee
 *  - getById: where: { id } gated by resolveAccess() — ANY relationship (owner, editor,
 *             or viewer) is sufficient to read; no relationship → 404 (AC-1.6)
 *  - update:  STILL owner-only (updateMany({ where: { id, userId } })) — T7
 *             (specs/013) adds the version CAS + editor-collaborator predicate;
 *             this file only widens the RESPONSE shape (version/access/owner) so
 *             it type-checks against the now-shared EstimateFull contract.
 *  - delete:  deleteMany({ where: { id, userId } }) unchanged (owner-only, AC-3.3);
 *             count===0 now branches through resolveAccess() to distinguish
 *             "no relationship" (404) from "collaborator, not owner" (403 owner_only)
 *             — the denial taxonomy in plan.md / ADR-0037.
 *
 * This file does NOT call `auth` for display-identity resolution — that is an
 * HTTP round trip requiring the caller's Authorization header, which lives in
 * estimates.routes.ts, not this DB-only layer. Repo functions return the raw
 * `ownerId` (a `sub`); routes.ts resolves it to a display identity via
 * `authClient.resolveIdentities` and decides `owner: null` vs `owner: {...}`
 * based on the resolved `access` level.
 *
 * sizeBytes is computed here as the UTF-8 byte length of the serialized content.
 */

import { Effect } from "effect";
import type { InputJsonValue } from "@prisma/client/runtime/client";
import { db } from "@/lib/db";
import { DatabaseError, ForbiddenError, NotFoundError } from "@/lib/errors";
import { resolveAccess, type AccessLevel } from "./access";
import type { EstimateContent } from "./estimates.schemas";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Compute the UTF-8 byte length of the JSON-serialised content.
 * Exported so the size guard in estimates.routes.ts (T5) and the import
 * endpoint (T6) can reuse it without duplicating the encoding logic.
 * Stored in `sizeBytes` so the list query never touches `content`.
 */
export const computeSizeBytes = (content: EstimateContent): number =>
  new TextEncoder().encode(JSON.stringify(content)).length;

// ─── Row shapes returned by this module (T6) ──────────────────────────────────
//
// These are NOT the wire response shapes (EstimateFull/EstimateListItem in
// estimates.schemas.ts) — they carry the raw `ownerId` instead of a resolved
// `owner: Identity | null`, because resolving display identity requires an
// outbound `auth` call that belongs in the route handler, not here.

export interface EstimateFullRow {
  readonly id: string;
  readonly name: string;
  readonly author: string;
  readonly content: EstimateContent;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
  readonly access: AccessLevel;
  readonly ownerId: string;
  /** Only computed for `access === "owner"` (AC-5.4 — collaborators never see this). */
  readonly collaboratorCount?: number;
}

export interface EstimateListRow {
  readonly id: string;
  readonly name: string;
  readonly author: string;
  readonly updatedAt: string;
  readonly access: AccessLevel;
  readonly ownerId: string;
}

/** Map a Prisma Estimate row (+ already-known access/owner) to EstimateFullRow. */
const toFullRow = (
  row: {
    id: string;
    name: string;
    author: string;
    content: unknown;
    createdAt: Date;
    updatedAt: Date;
    version: number;
  },
  access: AccessLevel,
  ownerId: string,
  collaboratorCount?: number,
): EstimateFullRow => ({
  id: row.id,
  name: row.name,
  author: row.author,
  content: row.content as EstimateContent,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
  version: row.version,
  access,
  ownerId,
  ...(collaboratorCount !== undefined ? { collaboratorCount } : {}),
});

// ─── Repository functions ─────────────────────────────────────────────────────

/**
 * Create a new estimate owned by `userId`.
 * sizeBytes is computed from the serialized content and stored alongside it.
 * The creator is always the owner (unchanged by sharing — import never
 * creates grants either, per plan.md's per-call-site table).
 */
export const createEstimate = (
  userId: string,
  name: string,
  author: string,
  content: EstimateContent,
): Effect.Effect<EstimateFullRow, DatabaseError> =>
  Effect.tryPromise({
    try: async () => {
      const sizeBytes = computeSizeBytes(content);
      const row = await db.estimate.create({
        data: { userId, name, author, sizeBytes, content: content as unknown as InputJsonValue },
      });
      // A brand-new estimate has zero collaborators — no query needed.
      return toFullRow(row, "owner", userId, 0);
    },
    catch: (cause) =>
      new DatabaseError({ message: "Failed to create estimate", cause }),
  });

/**
 * List every estimate `userId` can see — owned OR granted (T6, AC-2.1/2.2/2.3).
 * Returns only list-view columns — no `content` is fetched.
 *
 * `access` is derived per row: `"owner"` when the estimate's `userId` matches
 * the caller, otherwise the caller's own collaborator row's `accessLevel`
 * (guaranteed to exist for every non-owned row, because the WHERE clause only
 * matched it via that same collaborator relation).
 */
export const listEstimates = (
  userId: string,
): Effect.Effect<EstimateListRow[], DatabaseError> =>
  Effect.tryPromise({
    try: async () => {
      const rows = await db.estimate.findMany({
        where: {
          OR: [{ userId }, { collaborators: { some: { userId } } }],
        },
        orderBy: { updatedAt: "desc" },
        select: {
          id: true,
          name: true,
          author: true,
          updatedAt: true,
          userId: true,
          collaborators: {
            where: { userId },
            select: { accessLevel: true },
            take: 1,
          },
        },
      });
      return rows.map((row) => ({
        id: row.id,
        name: row.name,
        author: row.author,
        updatedAt: row.updatedAt.toISOString(),
        ownerId: row.userId,
        access: (row.userId === userId
          ? "owner"
          : (row.collaborators[0]?.accessLevel ?? "viewer")) as AccessLevel,
      }));
    },
    catch: (cause) =>
      new DatabaseError({ message: "Failed to list estimates", cause }),
  });

/**
 * Get a single estimate by id, gated on `resolveAccess` — ANY relationship
 * (owner, editor, or viewer) is sufficient to read (AC-1.6/3.1 — reads are
 * never level-gated, only writes/deletes/management are).
 *
 * Returns NotFoundError when the id does not exist OR the caller has no
 * relationship to it — the two cases are indistinguishable (AC-1.6, ADR-0005).
 *
 * `collaboratorCount` is populated only when the caller is the owner.
 */
export const getEstimateById = (
  id: string,
  userId: string,
): Effect.Effect<EstimateFullRow, DatabaseError | NotFoundError> =>
  Effect.gen(function* () {
    const resolved = yield* resolveAccess(id, userId);
    if (resolved === null) {
      return yield* Effect.fail(new NotFoundError({ message: `Estimate ${id} not found` }));
    }

    // Two-query read (resolveAccess, then content) is safe here — GET never
    // mutates state, so there is no TOCTOU window to close (unlike the write
    // path, where the access predicate must live inside the single CAS
    // statement — T7's concern, not this one's).
    const row = yield* Effect.tryPromise({
      try: async () => {
        const found = await db.estimate.findFirst({ where: { id } });
        if (found === null) return null;
        const collaboratorCount =
          resolved.level === "owner"
            ? await db.estimateCollaborator.count({ where: { estimateId: id } })
            : undefined;
        return toFullRow(found, resolved.level, resolved.ownerId, collaboratorCount);
      },
      catch: (cause) => new DatabaseError({ message: "Failed to fetch estimate", cause }),
    });

    if (row === null) {
      // Extremely rare race: deleted between resolveAccess and this fetch.
      // Treated identically to "no relationship" — still 404, never a 500 or
      // a stale read.
      return yield* Effect.fail(new NotFoundError({ message: `Estimate ${id} not found` }));
    }

    return row;
  });

/**
 * Update an existing estimate in place, scoped to userId.
 * updatedAt is advanced automatically by Prisma (@updatedAt).
 * sizeBytes is recomputed from the new content.
 *
 * T6 SCOPE NOTE: this predicate is STILL owner-only
 * (`updateMany({ where: { id, userId } })`), unchanged from spec 001/T5.
 * T7 (specs/013, deps: T6) replaces this with the version-CAS + editor-grant
 * predicate (`where: { id, version, OR: [owner, editor-collaborator] }`,
 * `version: { increment: 1 }`) — do not read the current owner-only gate as
 * the final behaviour. This function's return type is widened here (adds
 * version/access/owner/collaboratorCount) only so it satisfies the now-shared
 * EstimateFull response contract; T7 will populate a real post-CAS version.
 *
 * count === 0 → NotFoundError (id absent OR owned by a different user → 404).
 * Since the predicate is still owner-only, success here means the caller IS
 * the owner — access is always "owner" on the success path.
 */
export const updateEstimate = (
  id: string,
  userId: string,
  name: string,
  author: string,
  content: EstimateContent,
): Effect.Effect<EstimateFullRow, DatabaseError | NotFoundError> =>
  Effect.tryPromise({
    try: async () => {
      const sizeBytes = computeSizeBytes(content);
      const { count } = await db.estimate.updateMany({
        where: { id, userId },
        data: { name, author, sizeBytes, content: content as unknown as InputJsonValue },
      });
      if (count === 0) return null;
      // Re-fetch to get the full row (including updatedAt stamped by @updatedAt).
      const row = await db.estimate.findFirst({ where: { id, userId } });
      return row ?? null;
    },
    catch: (cause) =>
      new DatabaseError({ message: "Failed to update estimate", cause }),
  }).pipe(
    Effect.flatMap((row) =>
      row !== null
        ? Effect.succeed(toFullRow(row, "owner", userId))
        : Effect.fail(
            new NotFoundError({
              message: `Estimate ${id} not found`,
            }),
          ),
    ),
  );

/**
 * Delete an estimate by id. The delete predicate stays owner-only, unchanged
 * (AC-3.3/AC-9.1 — only the owner may delete; collaborators cascade away).
 *
 * count === 0 now branches through `resolveAccess` (T6, ADR-0037):
 *   - no relationship at all         → NotFoundError (404, AC-1.6)
 *   - a relationship, but not owner  → ForbiddenError code:"owner_only" (403)
 * count > 0 → success (void).
 */
export const deleteEstimate = (
  id: string,
  userId: string,
): Effect.Effect<void, DatabaseError | NotFoundError | ForbiddenError> =>
  Effect.gen(function* () {
    const deleted = yield* Effect.tryPromise({
      try: async () => {
        const { count } = await db.estimate.deleteMany({ where: { id, userId } });
        return count > 0;
      },
      catch: (cause) => new DatabaseError({ message: "Failed to delete estimate", cause }),
    });

    if (deleted) {
      return;
    }

    // count === 0 — either no relationship at all, or a collaborator (viewer
    // or editor) attempted an owner-only operation. Distinguish via
    // resolveAccess (T6, ADR-0037): 404 vs 403 owner_only.
    const resolved = yield* resolveAccess(id, userId);
    if (resolved === null) {
      return yield* Effect.fail(new NotFoundError({ message: `Estimate ${id} not found` }));
    }
    return yield* Effect.fail(
      new ForbiddenError({
        message: "Only the owner can delete this estimate",
        code: "owner_only",
      }),
    );
  });
