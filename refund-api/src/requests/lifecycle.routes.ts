/**
 * Submit / withdraw lifecycle endpoints (T10, specs/007-refund-service).
 *
 *   POST /requests/:id/submit   → 200 request (submitted)
 *   POST /requests/:id/withdraw → 200 request (draft)
 *
 * Owner-scoped only (404 for not found/not owned/missing `request:create`
 * capability — no accounting alternative, same as DELETE/lines). Submit
 * refuses 0-line (422, AC-1.5) and incomplete-line (422, body lists
 * `offendingLineIds`, AC-1.6) requests; withdraw requires `submitted` (409
 * otherwise, AC-2.3). Each transition writes an append-only audit row
 * (audit.ts, AC-8.1).
 */

import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { Effect } from "effect";
import { authzMiddleware, type AuthzVariables } from "../auth/authz.middleware";
import { jwtMiddleware } from "../auth/jwt.middleware";
import { hasCapability } from "../authz/conditions";
import { ConflictError, NotFoundError, ValidationError } from "../lib/errors";
import { findRequestWithLines } from "./requests.repo";
import { RequestDetailSchema, RequestIdParamSchema } from "./requests.schemas";
import { mapRequestDetail } from "./requests.service";
import { submitRequest, withdrawRequest } from "./lifecycle.repo";
import { hydrateDraftMileageLines } from "./mileageHydration";
import { SubmitValidationProblemSchema } from "./lifecycle.schemas";

// ─── Problem JSON helpers ────────────────────────────────────────────────────

const notFoundProblem = (path: string, detail: string) => ({
  type: "https://httpstatuses.com/404",
  title: "Not Found",
  status: 404 as const,
  detail,
  instance: path,
});

const conflictProblem = (path: string, detail: string) => ({
  type: "https://httpstatuses.com/409",
  title: "Conflict",
  status: 409 as const,
  detail,
  instance: path,
});

/** offendingLineIds carried via ValidationError.fields, per audit.ts's shape. */
const unprocessableProblem = (path: string, error: ValidationError) => {
  const offendingLineIds = error.fields?.["offendingLineIds"];
  return {
    type: "https://httpstatuses.com/422",
    title: "Unprocessable Entity",
    status: 422 as const,
    detail: error.message,
    instance: path,
    ...(offendingLineIds ? { offendingLineIds } : {}),
  };
};

// ─── Router ──────────────────────────────────────────────────────────────────

export const lifecycleRouter = new OpenAPIHono<{ Variables: AuthzVariables }>();

lifecycleRouter.use("/requests/:id/submit", jwtMiddleware);
lifecycleRouter.use("/requests/:id/submit", authzMiddleware);
lifecycleRouter.use("/requests/:id/withdraw", jwtMiddleware);
lifecycleRouter.use("/requests/:id/withdraw", authzMiddleware);

function requireCreateCapabilityOr404(
  authz: AuthzVariables["authz"],
  path: string,
  requestId: string,
) {
  if (hasCapability(authz.permissions, "request", "create")) return null;
  return notFoundProblem(path, `Refund request ${requestId} not found`);
}

/**
 * Re-fetches the full detail after a successful transition. Returns the
 * mapped `RequestDetail` (never `null` — the caller just proved the request
 * exists and is owned by re-writing its status a moment ago); throws on an
 * unexpected DB failure so the global 500 handler takes over.
 *
 * specs/009-mileage-rate (AC-3.2): after a WITHDRAW, the request is back to
 * `draft` — its travel_km lines must reflect the CURRENT rate config
 * immediately in this very response, not a stale snapshot. Hydration is a
 * no-op after a successful SUBMIT (status is already `submitted` there), so
 * this is safe to run unconditionally for both transitions (mirrors GET
 * /requests/:id's own hydrate-then-map sequence, requests.routes.ts).
 */
async function fetchDetailAfterTransition(requestId: string) {
  const exit = await Effect.runPromiseExit(findRequestWithLines(requestId));
  if (exit._tag === "Failure" || !exit.value) {
    throw new Error("Unexpected database failure re-fetching refund request");
  }
  const request = exit.value;
  const hydrationExit = await Effect.runPromiseExit(
    hydrateDraftMileageLines(request.lines, request.status),
  );
  if (hydrationExit._tag === "Failure") {
    throw new Error("Unexpected database failure resolving mileage rates");
  }
  return mapRequestDetail({ ...request, lines: hydrationExit.value });
}

// ─── POST /requests/:id/submit ──────────────────────────────────────────────

const submitRoute = createRoute({
  method: "post",
  path: "/requests/{id}/submit",
  tags: ["Requests"],
  summary: "Submit a draft refund request for review",
  description:
    "Transitions draft → submitted (becomes read-only, enters accounting's " +
    "queue). 422 if the request has zero lines (AC-1.5) or any line is " +
    "incomplete for its type (AC-1.6, offendingLineIds names them). Writes " +
    "an append-only 'submitted' audit row (AC-8.1).",
  security: [{ Bearer: [] }],
  request: { params: RequestIdParamSchema },
  responses: {
    200: {
      content: { "application/json": { schema: RequestDetailSchema } },
      description: "Submitted",
    },
    401: { description: "Missing or invalid Bearer JWT" },
    404: { description: "Not found, not owned, or capability missing" },
    409: { description: "Request is not a draft" },
    422: {
      content: { "application/json": { schema: SubmitValidationProblemSchema } },
      description: "Zero lines, or one or more incomplete lines (offendingLineIds)",
    },
  },
});

lifecycleRouter.openapi(submitRoute, async (c) => {
  const sub = c.get("userId");
  const email = c.get("email");
  const authz = c.get("authz");
  const { id } = c.req.valid("param");

  const capDenial = requireCreateCapabilityOr404(authz, c.req.path, id);
  if (capDenial) return c.json(capDenial, 404);

  const exit = await Effect.runPromiseExit(submitRequest(id, sub, email));
  if (exit._tag === "Success") {
    return c.json(await fetchDetailAfterTransition(id), 200);
  }

  const cause = exit.cause;
  if (cause._tag === "Fail") {
    if (cause.error instanceof NotFoundError) {
      return c.json(notFoundProblem(c.req.path, cause.error.message), 404);
    }
    if (cause.error instanceof ConflictError) {
      return c.json(conflictProblem(c.req.path, cause.error.message), 409);
    }
    if (cause.error instanceof ValidationError) {
      return c.json(unprocessableProblem(c.req.path, cause.error), 422);
    }
  }
  throw new Error("Unexpected database failure submitting refund request");
});

// ─── POST /requests/:id/withdraw ────────────────────────────────────────────

const withdrawRoute = createRoute({
  method: "post",
  path: "/requests/{id}/withdraw",
  tags: ["Requests"],
  summary: "Withdraw a submitted refund request back to draft",
  description:
    "Transitions submitted → draft (leaves accounting's queue immediately, " +
    "editable again). 409 if the request is not currently submitted " +
    "(AC-2.3 — e.g. already decided). Writes an append-only 'withdrawn' " +
    "audit row (AC-8.1); withdraw is an ACTION, not a persisted status.",
  security: [{ Bearer: [] }],
  request: { params: RequestIdParamSchema },
  responses: {
    200: {
      content: { "application/json": { schema: RequestDetailSchema } },
      description: "Withdrawn (back to draft)",
    },
    401: { description: "Missing or invalid Bearer JWT" },
    404: { description: "Not found, not owned, or capability missing" },
    409: { description: "Request is not currently submitted" },
  },
});

lifecycleRouter.openapi(withdrawRoute, async (c) => {
  const sub = c.get("userId");
  const email = c.get("email");
  const authz = c.get("authz");
  const { id } = c.req.valid("param");

  const capDenial = requireCreateCapabilityOr404(authz, c.req.path, id);
  if (capDenial) return c.json(capDenial, 404);

  const exit = await Effect.runPromiseExit(withdrawRequest(id, sub, email));
  if (exit._tag === "Success") {
    return c.json(await fetchDetailAfterTransition(id), 200);
  }

  const cause = exit.cause;
  if (cause._tag === "Fail") {
    if (cause.error instanceof NotFoundError) {
      return c.json(notFoundProblem(c.req.path, cause.error.message), 404);
    }
    if (cause.error instanceof ConflictError) {
      return c.json(conflictProblem(c.req.path, cause.error.message), 409);
    }
  }
  throw new Error("Unexpected database failure withdrawing refund request");
});
