/**
 * Estimates CRUD router (T4+T5, specs/001-estimate-persistence).
 *
 * All routes are protected by jwtMiddleware (set userId/email on context).
 * Every repository call is scoped by userId derived from the verified JWT sub.
 *
 * Endpoints on estimatesRouter (2 MiB body limit):
 *   POST   /estimates          → 201 EstimateFull        (AC-1.1)
 *   GET    /estimates          → 200 EstimateListItem[]  (AC-2.1, AC-2.3)
 *   GET    /estimates/:id      → 200 EstimateFull        (AC-2.2)
 *   PUT    /estimates/:id      → 200 EstimateFull        (AC-1.2)
 *   DELETE /estimates/:id      → 204 (no body)           (AC-3.1)
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
 * Ownership violations (AC-4.1) surface as 404 — the repo filters by userId so
 * "not yours" and "does not exist" are indistinguishable to the caller.
 *
 * All errors are RFC 7807 Problem JSON via the global onError handler, with the
 * NotFoundError/SizeError paths handled inline (404/413 respectively).
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
import { NotFoundError, SizeError } from "@/lib/errors";
import { env } from "@/lib/env";
import {
  EstimateUpsertSchema,
  EstimateFullSchema,
  EstimateListItemSchema,
  EstimateIdParamSchema,
  ImportRequestSchema,
  ImportResponseSchema,
} from "./estimates.schemas";
import {
  createEstimate,
  listEstimates,
  getEstimateById,
  updateEstimate,
  deleteEstimate,
  computeSizeBytes,
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

const ProblemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number(),
  detail: z.string(),
  instance: z.string(),
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

  return c.json(exit.value, 201);
});

// ─── GET /estimates — List ────────────────────────────────────────────────────

const listEstimatesRoute = createRoute({
  method: "get",
  path: "/estimates",
  tags: ["Estimates"],
  summary: "List estimates for the current user",
  description:
    "Returns all estimates owned by the authenticated user, ordered newest-first. " +
    "Returns an empty array for a user with no estimates (AC-2.3) — this is not an error.",
  responses: {
    200: {
      content: {
        "application/json": { schema: z.array(EstimateListItemSchema) },
      },
      description: "List of estimates (AC-2.1, AC-2.3)",
    },
    401: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "Missing or invalid Bearer JWT",
    },
  },
});

estimatesRouter.openapi(listEstimatesRoute, async (c) => {
  const userId = c.get("userId");

  const effect = listEstimates(userId);

  const exit = await Effect.runPromiseExit(effect);

  if (exit._tag === "Failure") {
    throw new Error("Unexpected database failure listing estimates");
  }

  return c.json(exit.value, 200);
});

// ─── GET /estimates/:id — Get full estimate ───────────────────────────────────

const getEstimateRoute = createRoute({
  method: "get",
  path: "/estimates/{id}",
  tags: ["Estimates"],
  summary: "Get a single estimate",
  description:
    "Returns the full estimate including content. Returns 404 if the estimate " +
    "does not exist or is not owned by the caller (AC-4.1 — no existence leak).",
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
      description: "Not found or not owned (AC-4.1)",
    },
  },
});

estimatesRouter.openapi(getEstimateRoute, async (c) => {
  const userId = c.get("userId");
  const { id } = c.req.valid("param");

  const effect = getEstimateById(id, userId);

  const exit = await Effect.runPromiseExit(effect);

  if (exit._tag === "Failure") {
    const cause = exit.cause;
    if (cause._tag === "Fail" && cause.error instanceof NotFoundError) {
      return c.json(problemNotFound(c.req.path, cause.error.message), 404);
    }
    throw new Error("Unexpected database failure fetching estimate");
  }

  return c.json(exit.value, 200);
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

  return c.json(exit.value, 200);
});

// ─── DELETE /estimates/:id — Delete ──────────────────────────────────────────

const deleteEstimateRoute = createRoute({
  method: "delete",
  path: "/estimates/{id}",
  tags: ["Estimates"],
  summary: "Delete an estimate",
  description:
    "Deletes the estimate. Returns 204 on success, 404 if not found or not owned (AC-4.1).",
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
    404: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "Not found or not owned (AC-4.1)",
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
