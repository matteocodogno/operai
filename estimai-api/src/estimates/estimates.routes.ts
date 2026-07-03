/**
 * Estimates CRUD router (T4, specs/001-estimate-persistence).
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
 * NotFoundError path handled inline to return 404 (not 500).
 *
 * T5 seam: sizeBytes is already stored by the repo; T5 will add a guard that
 * checks it before the write. To add the guard: wrap createEstimate/updateEstimate
 * calls with a size check before calling the repo function, and surface 413 here.
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { Effect } from "effect";
import { jwtMiddleware, type JwtVariables } from "@/auth/jwt.middleware";
import { NotFoundError } from "@/lib/errors";
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

const ProblemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number(),
  detail: z.string(),
  instance: z.string(),
});

// ─── Router ───────────────────────────────────────────────────────────────────

export const estimatesRouter = new OpenAPIHono<{
  Variables: JwtVariables;
}>();

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
  },
});

estimatesRouter.openapi(createEstimateRoute, async (c) => {
  const userId = c.get("userId");
  const body = c.req.valid("json");

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
  },
});

estimatesRouter.openapi(updateEstimateRoute, async (c) => {
  const userId = c.get("userId");
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");

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
