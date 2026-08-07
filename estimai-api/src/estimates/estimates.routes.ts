/**
 * Estimates CRUD router (T4+T5, specs/001-estimate-persistence;
 * widened for sharing in T6, specs/013-estimate-sharing).
 *
 * All routes are protected by jwtMiddleware (set userId/email on context).
 * Every repository call is scoped by userId derived from the verified JWT sub.
 *
 * Endpoints on estimatesRouter (2 MiB body limit):
 *   POST   /estimates          → 201 EstimateFull        (AC-1.1)
 *   GET    /estimates          → 200 EstimateListItem[]  (AC-2.1, AC-2.3; T6: owned ∪ shared)
 *   GET    /estimates/:id      → 200 EstimateFull        (AC-2.2; T6: any relationship suffices)
 *   PUT    /estimates/:id      → 200 EstimateFull        (AC-1.2; T6: response shape widened only —
 *                                                          predicate is still owner-only, T7 adds
 *                                                          the version CAS + editor-grant predicate)
 *   DELETE /estimates/:id      → 204 (no body)           (AC-3.1; still owner-only)
 *
 * Endpoints on importEstimatesRouter (larger body limit — see BODY LIMIT DESIGN):
 *   POST   /estimates/import   → 200 ImportResponse      (AC-5.2, AC-5.4)
 *
 * BODY LIMIT DESIGN (OWASP A04 fix):
 *   - estimatesRouter: 2 MiB wildcard bodyLimit — single-estimate POST/PUT only
 *     need headroom for a 1 MiB content plus the JSON envelope.
 *   - importEstimatesRouter: separate router with a larger bodyLimit so that a
 *     legitimate batch (e.g. three 900 KB estimates) is not rejected at the outer
 *     envelope before per-element handling can run. The import limit is:
 *       min(MAX_ESTIMATE_BYTES × 200 + 64 KiB envelope, 32 MiB hard ceiling)
 *     The 32 MiB ceiling is the DoS trade-off: the import endpoint is internal/
 *     behind-auth, so a generous-but-bounded ceiling is acceptable. The per-element
 *     checkContentSize() (1 MiB) still runs inside the handler — the body limit is
 *     only the outer envelope bound, not a substitute for per-element validation.
 *   - The two routers are mounted separately in index.ts so their bodyLimit
 *     middleware chains are completely independent (no double-capping).
 *
 * DENIAL TAXONOMY (T6, plan.md "Access resolution inside estimai-api", ADR-0037
 * — a deliberate narrowing of ADR-0005's blanket "not owned = 404"):
 *   - NO relationship at all (stranger)              → 404 (AC-1.6, ADR-0005 intact)
 *   - a relationship exists but the level is short    → 403 with a stable `code`
 *     (currently only DELETE's "owner_only" — a collaborator attempting to
 *     delete already knows the estimate exists, so 404 would be a lie)
 * `GET` is the one operation where ANY relationship (owner/editor/viewer)
 * is sufficient — there is no 403 on the read path.
 *
 * All errors are RFC 7807 Problem JSON via the global onError handler, with the
 * NotFoundError/ForbiddenError/SizeError paths handled inline (404/403/413).
 *
 * T5: per-estimate size guard enforced on POST and PUT before any DB write.
 *   - computeSizeBytes() from estimates.repo.ts measures the UTF-8 byte length
 *     of the serialised content.
 *   - If it exceeds MAX_ESTIMATE_BYTES → 413 Problem, nothing is persisted.
 *   - checkContentSize() is a small reusable helper called per element in import.
 *   - bodyLimit middleware caps raw request body (see BODY LIMIT DESIGN above).
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { Effect } from "effect";
import { bodyLimit } from "hono/body-limit";
import { jwtMiddleware, type JwtVariables } from "@/auth/jwt.middleware";
import { ForbiddenError, NotFoundError, SizeError } from "@/lib/errors";
import { env } from "@/lib/env";
import { resolveIdentities, type Identity as ResolvedIdentity } from "@/lib/authClient";
import {
  EstimateUpsertSchema,
  EstimateFullSchema,
  EstimateListItemSchema,
  EstimateIdParamSchema,
  ImportRequestSchema,
  ImportResponseSchema,
  type Identity,
} from "./estimates.schemas";
import {
  createEstimate,
  listEstimates,
  getEstimateById,
  updateEstimate,
  deleteEstimate,
  computeSizeBytes,
  type EstimateFullRow,
  type EstimateListRow,
} from "./estimates.repo";

// ─── Problem JSON helpers ─────────────────────────────────────────────────────

const problemNotFound = (path: string, detail: string) => ({
  type: "https://httpstatuses.com/404",
  title: "Not Found",
  status: 404 as const,
  detail,
  instance: path,
});

const problemBadRequest = (path: string, detail: string) => ({
  type: "https://httpstatuses.com/400",
  title: "Bad Request",
  status: 400 as const,
  detail,
  instance: path,
});

const problemPayloadTooLarge = (path: string, actualBytes: number, limitBytes: number) => ({
  type: "https://httpstatuses.com/413",
  title: "Payload Too Large",
  status: 413 as const,
  detail: `Estimate content is ${(actualBytes / 1024 / 1024).toFixed(1)} MB; the maximum is ${(limitBytes / 1024 / 1024).toFixed(1)} MB. Nothing was saved.`,
  instance: path,
});

// T6 (specs/013-estimate-sharing) — the 403 half of the denial taxonomy
// (ADR-0037): a relationship to the record exists but the caller's level is
// insufficient for the attempted operation. `code` is the stable
// machine-readable discriminant the plan's API contracts specify
// (e.g. "owner_only").
const problemForbidden = (path: string, detail: string, code: string) => ({
  type: "https://httpstatuses.com/403",
  title: "Forbidden",
  status: 403 as const,
  detail,
  code,
  instance: path,
});

const ProblemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number(),
  detail: z.string(),
  instance: z.string(),
});

const ProblemWithCodeSchema = ProblemSchema.extend({
  code: z.string(),
});

// ─── Display identity helper (T6, specs/013-estimate-sharing) ───────────────
//
// Repo functions return the raw estimate `ownerId` (a `sub`) — never a
// resolved identity (that requires an outbound `auth` call using the
// CALLER'S OWN Bearer token, which only exists here in the route handler).
// This module resolves it via authClient.resolveIdentities (fails SOFT —
// never throws, degrades to "unknown" — plan.md "Display identity" /
// ADR-0039) and strips the `id` field before it ever reaches the wire: the
// response Identity shape is {status, name} only, never a raw sub/cuid.

const toWireIdentity = (resolved: ResolvedIdentity): Identity => ({
  status: resolved.status,
  name: resolved.name,
});

const UNKNOWN_IDENTITY: Identity = { status: "unknown", name: null };

/**
 * Resolves the owner's display identity for a single non-owned row.
 * `access === "owner"` rows never call this — the caller returns `null`
 * for those without invoking `auth` at all (their own row never needs a
 * third-party identity lookup).
 */
const resolveOwnerIdentity = async (
  authHeader: string,
  ownerId: string,
): Promise<Identity> => {
  const identities = await resolveIdentities(authHeader, [ownerId]);
  const found = identities.get(ownerId);
  return found ? toWireIdentity(found) : UNKNOWN_IDENTITY;
};

/** Maps a repo EstimateListRow (raw ownerId) to the wire EstimateListItem. */
const toWireListItem = (
  row: EstimateListRow,
  identities: Map<string, ResolvedIdentity>,
) => ({
  id: row.id,
  name: row.name,
  author: row.author,
  updatedAt: row.updatedAt,
  access: row.access,
  owner:
    row.access === "owner"
      ? null
      : toWireIdentity(identities.get(row.ownerId) ?? { id: row.ownerId, ...UNKNOWN_IDENTITY }),
});

/** Maps a repo EstimateFullRow (raw ownerId) to the wire EstimateFull. */
const toWireFull = (row: EstimateFullRow, owner: Identity | null) => ({
  id: row.id,
  name: row.name,
  author: row.author,
  content: row.content,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  version: row.version,
  access: row.access,
  owner,
  ...(row.collaboratorCount !== undefined ? { collaboratorCount: row.collaboratorCount } : {}),
});

// ─── Size guard helper (reusable by T6 import endpoint) ─────────────────────
//
// Returns a SizeError if `content` serialises to more than `limitBytes` UTF-8
// bytes, otherwise returns undefined. Callers check the return value before
// any DB write so nothing is persisted on rejection (AC-1.4).

export const checkContentSize = (
  content: Parameters<typeof computeSizeBytes>[0],
  limitBytes: number,
): SizeError | undefined => {
  const actualBytes = computeSizeBytes(content);
  if (actualBytes > limitBytes) {
    return new SizeError({
      message: `Estimate content is ${(actualBytes / 1024 / 1024).toFixed(1)} MB; the maximum is ${(limitBytes / 1024 / 1024).toFixed(1)} MB. Nothing was saved.`,
      actualBytes,
      limitBytes,
    });
  }
  return undefined;
};

// ─── Body-size limit constants ────────────────────────────────────────────────

// Single-estimate endpoints (POST /estimates, PUT /estimates/:id): 2 MiB gives
// headroom for the JSON envelope around a max-size (1 MiB) content (AC-1.4, DoS).
const BODY_SIZE_LIMIT = 2 * 1024 * 1024; // 2 MiB

// Import endpoint: must accommodate up to 200 elements each up to MAX_ESTIMATE_BYTES
// plus a small envelope (~64 KiB). An absolute 32 MiB ceiling is applied as the
// DoS trade-off: this endpoint is internal/behind-auth, so a generous-but-bounded
// ceiling is acceptable. The per-element checkContentSize() (1 MiB) still runs
// inside the handler — the body limit is only the outer envelope bound.
//
// Ceiling derivation: MAX_ESTIMATE_BYTES (default 1 MiB) × 200 + 65536 ≈ 200 MiB
// computed value is much larger than the 32 MiB ceiling, so the ceiling always
// applies with the default. If MAX_ESTIMATE_BYTES were reduced to e.g. 100 KiB,
// the computed value (≈ 20 MiB) would fall under the ceiling.
const IMPORT_BODY_SIZE_LIMIT = (() => {
  const MAX_CEILING = 32 * 1024 * 1024; // 32 MiB hard ceiling
  const ENVELOPE_BYTES = 64 * 1024; // 64 KiB for the outer JSON envelope
  if (env.MAX_IMPORT_REQUEST_BYTES !== undefined) {
    // Honour the explicit env override but still cap at 32 MiB.
    return Math.min(env.MAX_IMPORT_REQUEST_BYTES, MAX_CEILING);
  }
  const computed = env.MAX_ESTIMATE_BYTES * 200 + ENVELOPE_BYTES;
  return Math.min(computed, MAX_CEILING);
})();

// ─── Routers ──────────────────────────────────────────────────────────────────
//
// estimatesRouter: CRUD endpoints (2 MiB body limit).
// importEstimatesRouter: bulk-import endpoint (IMPORT_BODY_SIZE_LIMIT).
//
// The two routers are mounted separately in index.ts so their bodyLimit middleware
// chains are completely independent — the import route is never subject to the 2 MiB
// cap, and single-estimate endpoints are never given the larger import limit.

export const estimatesRouter = new OpenAPIHono<{
  Variables: JwtVariables;
}>();

estimatesRouter.use(
  "*",
  bodyLimit({
    maxSize: BODY_SIZE_LIMIT,
    onError: (c) =>
      c.json(
        {
          type: "https://httpstatuses.com/413",
          title: "Payload Too Large",
          status: 413,
          detail: `Request body exceeds the maximum allowed size of ${(BODY_SIZE_LIMIT / 1024 / 1024).toFixed(0)} MB.`,
          instance: c.req.path,
        },
        413,
      ),
  }),
);

// Apply jwtMiddleware to ALL routes on the CRUD router.
estimatesRouter.use("*", jwtMiddleware);

// ─── Import sub-router (separate bodyLimit — see BODY LIMIT DESIGN in file header) ──

export const importEstimatesRouter = new OpenAPIHono<{
  Variables: JwtVariables;
}>();

importEstimatesRouter.use(
  "*",
  bodyLimit({
    maxSize: IMPORT_BODY_SIZE_LIMIT,
    onError: (c) =>
      c.json(
        {
          type: "https://httpstatuses.com/413",
          title: "Payload Too Large",
          status: 413,
          detail: `Import request body exceeds the maximum allowed size of ${(IMPORT_BODY_SIZE_LIMIT / 1024 / 1024).toFixed(1)} MB.`,
          instance: c.req.path,
        },
        413,
      ),
  }),
);

// Apply jwtMiddleware to ALL routes on the import router.
importEstimatesRouter.use("*", jwtMiddleware);

// ─── POST /estimates — Create ─────────────────────────────────────────────────

const createEstimateRoute = createRoute({
  method: "post",
  path: "/estimates",
  tags: ["Estimates"],
  summary: "Create an estimate",
  description:
    "Persists a new estimate under the caller's account. Returns the full estimate on success.",
  request: {
    body: {
      required: true,
      content: {
        "application/json": { schema: EstimateUpsertSchema },
      },
    },
  },
  responses: {
    201: {
      content: { "application/json": { schema: EstimateFullSchema } },
      description: "Estimate created (AC-1.1)",
    },
    400: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "Validation error",
    },
    401: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "Missing or invalid Bearer JWT",
    },
    413: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "Content exceeds MAX_ESTIMATE_BYTES; nothing was persisted (AC-1.4)",
    },
  },
});

estimatesRouter.openapi(createEstimateRoute, async (c) => {
  const userId = c.get("userId");
  const body = c.req.valid("json");

  // T5: enforce size guard BEFORE any DB write (AC-1.4 — no partial write).
  const sizeErr = checkContentSize(body.content, env.MAX_ESTIMATE_BYTES);
  if (sizeErr) {
    return c.json(
      problemPayloadTooLarge(c.req.path, sizeErr.actualBytes, sizeErr.limitBytes),
      413,
    );
  }

  const effect = createEstimate(userId, body.name, body.author, body.content);

  const exit = await Effect.runPromiseExit(effect);

  if (exit._tag === "Failure") {
    const cause = exit.cause;
    if (cause._tag === "Fail") {
      return c.json(
        problemBadRequest(c.req.path, cause.error.message),
        400,
      );
    }
    throw new Error("Unexpected database failure creating estimate");
  }

  // The creator is always the owner — no `auth` identity round trip needed.
  return c.json(toWireFull(exit.value, null), 201);
});

// ─── GET /estimates — List ────────────────────────────────────────────────────

const listEstimatesRoute = createRoute({
  method: "get",
  path: "/estimates",
  tags: ["Estimates"],
  summary: "List estimates for the current user",
  description:
    "Returns every estimate the caller owns OR holds a collaborator grant on, " +
    "ordered newest-first (T6, AC-2.1/2.2/2.3). Returns an empty array for a " +
    "user with no estimates and no grants — this is not an error.",
  responses: {
    200: {
      content: {
        "application/json": { schema: z.array(EstimateListItemSchema) },
      },
      description: "List of estimates, owned and shared (AC-2.1, AC-2.3)",
    },
    401: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "Missing or invalid Bearer JWT",
    },
  },
});

estimatesRouter.openapi(listEstimatesRoute, async (c) => {
  const userId = c.get("userId");
  const authHeader = c.req.header("Authorization") ?? "";

  const effect = listEstimates(userId);

  const exit = await Effect.runPromiseExit(effect);

  if (exit._tag === "Failure") {
    throw new Error("Unexpected database failure listing estimates");
  }

  const rows = exit.value;

  // Batch-resolve display identity for every DISTINCT non-owned row's owner
  // in one call (plan.md "one batch per list render, distinct owner subs,
  // self excluded") — never one auth round trip per row. resolveIdentities
  // never throws (fails soft to "unknown" — AC keeps GET /estimates at 200
  // even when `auth` is unreachable).
  const ownerIdsToResolve = Array.from(
    new Set(rows.filter((row) => row.access !== "owner").map((row) => row.ownerId)),
  );
  const identities =
    ownerIdsToResolve.length > 0
      ? await resolveIdentities(authHeader, ownerIdsToResolve)
      : new Map<string, ResolvedIdentity>();

  return c.json(
    rows.map((row) => toWireListItem(row, identities)),
    200,
  );
});

// ─── GET /estimates/:id — Get full estimate ───────────────────────────────────

const getEstimateRoute = createRoute({
  method: "get",
  path: "/estimates/{id}",
  tags: ["Estimates"],
  summary: "Get a single estimate",
  description:
    "Returns the full estimate including content to ANY caller with a " +
    "relationship to it — owner, editor, or viewer (T6, AC-3.1). Returns 404 " +
    "if the estimate does not exist or the caller has no relationship to it " +
    "at all (AC-1.6 — no existence leak, ADR-0005/ADR-0037).",
  request: {
    params: EstimateIdParamSchema,
  },
  responses: {
    200: {
      content: { "application/json": { schema: EstimateFullSchema } },
      description: "Full estimate (AC-2.2)",
    },
    401: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "Missing or invalid Bearer JWT",
    },
    404: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "No relationship to this estimate (AC-1.6)",
    },
  },
});

estimatesRouter.openapi(getEstimateRoute, async (c) => {
  const userId = c.get("userId");
  const { id } = c.req.valid("param");
  const authHeader = c.req.header("Authorization") ?? "";

  const effect = getEstimateById(id, userId);

  const exit = await Effect.runPromiseExit(effect);

  if (exit._tag === "Failure") {
    const cause = exit.cause;
    if (cause._tag === "Fail" && cause.error instanceof NotFoundError) {
      return c.json(problemNotFound(c.req.path, cause.error.message), 404);
    }
    throw new Error("Unexpected database failure fetching estimate");
  }

  const row = exit.value;
  const owner =
    row.access === "owner" ? null : await resolveOwnerIdentity(authHeader, row.ownerId);

  return c.json(toWireFull(row, owner), 200);
});

// ─── PUT /estimates/:id — Update ─────────────────────────────────────────────

const updateEstimateRoute = createRoute({
  method: "put",
  path: "/estimates/{id}",
  tags: ["Estimates"],
  summary: "Update an estimate",
  description:
    "Updates the estimate in place (same id, no duplicate). updatedAt is advanced. " +
    "Returns 404 if the estimate does not exist or is not owned by the caller (AC-4.1).",
  request: {
    params: EstimateIdParamSchema,
    body: {
      required: true,
      content: {
        "application/json": { schema: EstimateUpsertSchema },
      },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: EstimateFullSchema } },
      description: "Updated estimate (AC-1.2)",
    },
    400: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "Validation error",
    },
    401: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "Missing or invalid Bearer JWT",
    },
    404: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "Not found or not owned (AC-4.1)",
    },
    413: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "Content exceeds MAX_ESTIMATE_BYTES; prior stored version untouched (AC-1.4)",
    },
  },
});

estimatesRouter.openapi(updateEstimateRoute, async (c) => {
  const userId = c.get("userId");
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");

  // T5: enforce size guard BEFORE any DB write (AC-1.4 — prior version stays intact).
  const sizeErr = checkContentSize(body.content, env.MAX_ESTIMATE_BYTES);
  if (sizeErr) {
    return c.json(
      problemPayloadTooLarge(c.req.path, sizeErr.actualBytes, sizeErr.limitBytes),
      413,
    );
  }

  const effect = updateEstimate(id, userId, body.name, body.author, body.content);

  const exit = await Effect.runPromiseExit(effect);

  if (exit._tag === "Failure") {
    const cause = exit.cause;
    if (cause._tag === "Fail" && cause.error instanceof NotFoundError) {
      return c.json(problemNotFound(c.req.path, cause.error.message), 404);
    }
    throw new Error("Unexpected database failure updating estimate");
  }

  // updateEstimate's predicate is still owner-only (T7 scope — version CAS +
  // editor-collaborator predicate, If-Match/ETag, 403 insufficient_access for
  // a viewer/editor's PUT) — a success here always means the caller is the
  // owner, so `owner` is always null and no identity round trip is needed.
  return c.json(toWireFull(exit.value, null), 200);
});

// ─── DELETE /estimates/:id — Delete ──────────────────────────────────────────

const deleteEstimateRoute = createRoute({
  method: "delete",
  path: "/estimates/{id}",
  tags: ["Estimates"],
  summary: "Delete an estimate",
  description:
    "Deletes the estimate; every EstimateCollaborator grant cascades away " +
    "(AC-9.1). Owner-only (AC-3.3) — a collaborator (editor or viewer) gets " +
    "403 owner_only, NOT 404, because they already know the estimate exists " +
    "(T6, ADR-0037). 404 is reserved for callers with no relationship at all.",
  request: {
    params: EstimateIdParamSchema,
  },
  responses: {
    204: {
      description: "Deleted (AC-3.1)",
    },
    401: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "Missing or invalid Bearer JWT",
    },
    403: {
      content: { "application/json": { schema: ProblemWithCodeSchema } },
      description: "Caller is a collaborator, not the owner — code: owner_only (AC-3.3)",
    },
    404: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "No relationship to this estimate (AC-1.6)",
    },
  },
});

estimatesRouter.openapi(deleteEstimateRoute, async (c) => {
  const userId = c.get("userId");
  const { id } = c.req.valid("param");

  const effect = deleteEstimate(id, userId);

  const exit = await Effect.runPromiseExit(effect);

  if (exit._tag === "Failure") {
    const cause = exit.cause;
    if (cause._tag === "Fail" && cause.error instanceof NotFoundError) {
      return c.json(problemNotFound(c.req.path, cause.error.message), 404);
    }
    if (cause._tag === "Fail" && cause.error instanceof ForbiddenError) {
      return c.json(
        problemForbidden(c.req.path, cause.error.message, cause.error.code),
        403,
      );
    }
    throw new Error("Unexpected database failure deleting estimate");
  }

  return new Response(null, { status: 204 });
});

// ─── POST /estimates/import — Bulk import (T6, AC-5.2, AC-5.4) ───────────────
//
// Registered on importEstimatesRouter (not estimatesRouter) so it gets its own,
// larger bodyLimit — see BODY LIMIT DESIGN in the file header.
//
// Each element is processed independently, in its own try/catch (one transaction
// per element). A failure in any element never aborts or rolls back others.
//
// SECURITY (OWASP A01/A04):
//   - userId is ALWAYS taken from c.get('userId') (JWT sub) — never from the body.
//   - The ImportRequestSchema reuses EstimateUpsert which strips id/userId/timestamps,
//     so callers cannot smuggle server-controlled fields (IDOR prevention).
//   - Per-element size guard (checkContentSize) runs before each DB write.
//   - Per-element error messages are sanitized (A09): SizeError messages are
//     user-safe (they name the size limit); DatabaseError is replaced with a
//     generic message to avoid leaking Prisma/DB internals to the wire.
//
// Response contract (plan.md):
//   - 200 as long as the REQUEST ENVELOPE is well-formed (per-element outcomes in results).
//   - 400 if the envelope is malformed (not an array, missing top-level fields).
//   - 401 handled by jwtMiddleware upstream.
//   - 413 if the entire import request body exceeds IMPORT_BODY_SIZE_LIMIT.

const importEstimatesRoute = createRoute({
  method: "post",
  path: "/estimates/import",
  tags: ["Estimates"],
  summary: "Bulk import estimates (one-time migration, US-5)",
  description:
    "Imports a batch of estimates from local storage under the caller's account. " +
    "Each element is imported independently in its own transaction — one failure " +
    "never aborts or rolls back others (AC-5.4). Per-element size guard applies. " +
    "Returns 200 with per-element results as long as the request envelope is well-formed.",
  request: {
    body: {
      required: true,
      content: {
        "application/json": { schema: ImportRequestSchema },
      },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: ImportResponseSchema } },
      description: "Batch processed — check each element's status in results (AC-5.2, AC-5.4)",
    },
    400: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "Malformed request envelope (not an array, missing required fields)",
    },
    401: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "Missing or invalid Bearer JWT",
    },
    413: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "Import request body exceeds IMPORT_BODY_SIZE_LIMIT; no elements processed",
    },
  },
});

importEstimatesRouter.openapi(importEstimatesRoute, async (c) => {
  // userId is derived from the JWT sub — never from the request body (OWASP A01).
  const userId = c.get("userId");
  const { estimates } = c.req.valid("json");

  // Process each element independently so one failure cannot abort the batch.
  // We deliberately do NOT use Promise.all here — sequential processing avoids
  // overwhelming the DB connection pool with a large batch (200 elements) and
  // makes the per-element isolation explicit and auditable.
  const results = [];

  for (const element of estimates) {
    const { localId, name, author, content } = element;

    // Per-element size guard (reuses T5's checkContentSize).
    // Over-size → that element is marked failed; others continue (AC-5.4).
    // SizeError.message is user-safe (names the size limit in MB) — safe to wire.
    const sizeErr = checkContentSize(content, env.MAX_ESTIMATE_BYTES);
    if (sizeErr) {
      results.push({
        localId,
        status: "failed" as const,
        error: sizeErr.message,
      });
      continue;
    }

    // Each create runs in its own Effect — a DB error on this element is caught
    // here and marks only this element failed; the loop continues (AC-5.4).
    const exit = await Effect.runPromiseExit(
      createEstimate(userId, name, author, content),
    );

    if (exit._tag === "Success") {
      results.push({
        localId,
        status: "imported" as const,
        id: exit.value.id,
      });
    } else {
      // OWASP A09 — error sanitization at the wire boundary:
      //   SizeError (_tag === "SizeError"): message names the size limit in MB — safe to
      //     forward (e.g. if the caller re-uses this handler for other error types).
      //   DatabaseError: replace with generic message — never forward Prisma/cause
      //     internals (connection strings, table names, constraint names).
      //   Other (e.g. unexpected Die): generic fallback.
      //
      // Note: currently createEstimate only fails with DatabaseError, so the SizeError
      // branch is unreachable in this code path. It is kept as a forward-compatibility
      // guard: if the error union is ever widened (e.g. a retry layer adds SizeError),
      // the sanitization remains correct without further changes. Using _tag
      // discriminant (not instanceof) avoids TypeScript narrowing issues with
      // Data.TaggedError intersections.
      const errorMessage = (() => {
        if (exit.cause._tag !== "Fail") {
          return "Unexpected error while importing estimate";
        }
        const err = exit.cause.error as { _tag: string; message: string };
        if (err._tag === "SizeError") {
          return err.message; // user-safe: "X.X MB; maximum is Y.Y MB. Nothing was saved."
        }
        // DatabaseError or any other typed error — use a generic message.
        return "Failed to import estimate";
      })();
      results.push({
        localId,
        status: "failed" as const,
        error: errorMessage,
      });
    }
  }

  return c.json({ results }, 200);
});
