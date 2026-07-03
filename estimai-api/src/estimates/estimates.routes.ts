/**
 * Estimates CRUD router (T4+T5, specs/001-estimate-persistence).
 *
 * All routes are protected by jwtMiddleware (set userId/email on context).
 * Every repository call is scoped by userId derived from the verified JWT sub.
 *
 * Endpoints:
 *   POST   /estimates          → 201 EstimateFull        (AC-1.1)
 *   GET    /estimates          → 200 EstimateListItem[]  (AC-2.1, AC-2.3)
 *   GET    /estimates/:id      → 200 EstimateFull        (AC-2.2)
 *   PUT    /estimates/:id      → 200 EstimateFull        (AC-1.2)
 *   DELETE /estimates/:id      → 204 (no body)           (AC-3.1)
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
 *   - checkContentSize() is a small reusable helper (T6 will call it per element).
 *   - bodyLimit middleware caps raw request body at 2 MiB so the process never
 *     buffers an unbounded body.
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

// ─── Router ───────────────────────────────────────────────────────────────────

export const estimatesRouter = new OpenAPIHono<{
  Variables: JwtVariables;
}>();

// Body-size limit: reject raw request bodies > 2 MiB before any handler logic
// runs, so the process never buffers an unbounded payload (AC-1.4, DoS guard).
// 2 MiB gives headroom for the JSON envelope around a max-size (1 MiB) content.
const BODY_SIZE_LIMIT = 2 * 1024 * 1024; // 2 MiB

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

// Apply jwtMiddleware to ALL routes on this router.
estimatesRouter.use("*", jwtMiddleware);

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
