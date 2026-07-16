/**
 * Employee request-level endpoints (T7, specs/007-refund-service).
 *
 *   POST   /requests       → 201 draft, owner = JWT sub (NEVER the body)
 *   GET    /requests       → 200 [{id,status,updatedAt,subtotals}] (own only)
 *   GET    /requests/:id   → 200 full detail (owner OR in-scope accounting)
 *   DELETE /requests/:id   → 204 (draft-only); 409 otherwise
 *
 * Denial semantics (plan.md § API contracts):
 *   - POST/GET (no target record) — missing `request:create`/`request:read`
 *     capability → 403 (nothing record-level to hide).
 *   - GET/DELETE by :id — EVERY denial (not found, not owned, missing
 *     capability, out-of-scope) → 404, never 403 (ADR-0005 "not yours = not
 *     found"; AC-2.5 "non-owner non-accounting denied").
 *
 * GET /requests/:id is the SAME route accounting uses (plan.md lists it under
 * both the employee and accounting contract tables) — `canReadRequest`
 * (requests.service.ts) evaluates the owner-OR-in-scope-accounting predicate.
 *
 * BODY SIZE GUARD (OWASP A04 fix): POST /requests takes no request body at
 * all (the owner is always the JWT `sub`, never anything from the payload —
 * see the handler below) but an unbounded body would still be buffered by
 * the runtime before any handler logic runs. bodyLimit fails closed on an
 * oversized/malicious body BEFORE jwtMiddleware/authzMiddleware, mirroring
 * estimai-api's bodyLimit precedent (estimates.routes.ts "OWASP A04 fix").
 */

import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { Effect } from "effect";
import { bodyLimit } from "hono/body-limit";
import { authzMiddleware, type AuthzVariables } from "../auth/authz.middleware";
import { jwtMiddleware } from "../auth/jwt.middleware";
import { hasCapability } from "../authz/conditions";
import { ConflictError, NotFoundError } from "../lib/errors";
import {
  createDraftRequest,
  deleteDraftRequest,
  findRequestWithLines,
  listOwnRequests,
} from "./requests.repo";
import {
  ProblemSchema,
  RequestDetailSchema,
  RequestIdParamSchema,
  RequestListItemSchema,
} from "./requests.schemas";
import { canReadRequest, mapRequestDetail, mapRequestListItem } from "./requests.service";

// ─── Problem JSON helpers ────────────────────────────────────────────────────

const notFoundProblem = (path: string, detail: string) => ({
  type: "https://httpstatuses.com/404",
  title: "Not Found",
  status: 404 as const,
  detail,
  instance: path,
});

const forbiddenProblem = (path: string, detail: string) => ({
  type: "https://httpstatuses.com/403",
  title: "Forbidden",
  status: 403 as const,
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

const payloadTooLargeProblem = (path: string, limitBytes: number) => ({
  type: "https://httpstatuses.com/413",
  title: "Payload Too Large",
  status: 413 as const,
  detail: `Request body exceeds the maximum allowed size of ${(limitBytes / 1024).toFixed(0)} KB.`,
  instance: path,
});

// No route on this router accepts a meaningful JSON body (see file header) —
// a small cap is defense-in-depth against an oversized payload, not headroom
// for a real request shape.
const REQUESTS_BODY_SIZE_LIMIT = 4 * 1024; // 4 KiB

// ─── Router ──────────────────────────────────────────────────────────────────

export const requestsRouter = new OpenAPIHono<{ Variables: AuthzVariables }>({
  defaultHook: (result, c) => {
    if (!result.success) {
      return c.json(
        {
          type: "https://httpstatuses.com/400",
          title: "Bad Request",
          status: 400,
          detail: result.error.issues
            .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
            .join("; "),
          instance: c.req.path,
        },
        400,
      );
    }
    return undefined;
  },
});

const requestsBodyLimit = bodyLimit({
  maxSize: REQUESTS_BODY_SIZE_LIMIT,
  onError: (c) =>
    c.json(payloadTooLargeProblem(c.req.path, REQUESTS_BODY_SIZE_LIMIT), 413),
});

requestsRouter.use("/requests", requestsBodyLimit);
requestsRouter.use("/requests/*", requestsBodyLimit);
requestsRouter.use("/requests", jwtMiddleware);
requestsRouter.use("/requests", authzMiddleware);
requestsRouter.use("/requests/*", jwtMiddleware);
requestsRouter.use("/requests/*", authzMiddleware);

// ─── POST /requests — create a draft ───────────────────────────────────────

const createRequestRoute = createRoute({
  method: "post",
  path: "/requests",
  tags: ["Requests"],
  summary: "Create a new refund request (draft)",
  description:
    "Creates a new refund request owned by the caller, in `draft` status — " +
    "private, not yet in accounting's queue (AC-1.1).",
  security: [{ Bearer: [] }],
  responses: {
    201: {
      content: { "application/json": { schema: RequestDetailSchema } },
      description: "Draft request created (AC-1.1)",
    },
    401: { description: "Missing or invalid Bearer JWT" },
    403: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "Caller lacks the `request:create` capability",
    },
  },
});

requestsRouter.openapi(createRequestRoute, async (c) => {
  const sub = c.get("userId");
  const email = c.get("email");
  const authz = c.get("authz");

  if (!hasCapability(authz.permissions, "request", "create")) {
    return c.json(
      forbiddenProblem(c.req.path, "You do not have permission to create refund requests"),
      403,
    );
  }

  const exit = await Effect.runPromiseExit(createDraftRequest(sub, email, null));
  if (exit._tag === "Failure") {
    throw new Error("Unexpected database failure creating refund request");
  }

  return c.json(mapRequestDetail(exit.value), 201);
});

// ─── GET /requests — list own requests ─────────────────────────────────────

const listRequestsRoute = createRoute({
  method: "get",
  path: "/requests",
  tags: ["Requests"],
  summary: "List the caller's own refund requests",
  description:
    "Returns the caller's own requests only (AC-3.1) — id, status, updatedAt, " +
    "and per-currency subtotals. Never includes another user's requests.",
  security: [{ Bearer: [] }],
  responses: {
    200: {
      content: { "application/json": { schema: z.array(RequestListItemSchema) } },
      description: "Own requests (may be empty)",
    },
    401: { description: "Missing or invalid Bearer JWT" },
    403: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "Caller lacks the `request:read` capability",
    },
  },
});

requestsRouter.openapi(listRequestsRoute, async (c) => {
  const sub = c.get("userId");
  const authz = c.get("authz");

  if (!hasCapability(authz.permissions, "request", "read")) {
    return c.json(
      forbiddenProblem(c.req.path, "You do not have permission to read refund requests"),
      403,
    );
  }

  const exit = await Effect.runPromiseExit(listOwnRequests(sub));
  if (exit._tag === "Failure") {
    throw new Error("Unexpected database failure listing refund requests");
  }

  return c.json(exit.value.map(mapRequestListItem), 200);
});

// ─── GET /requests/:id — full detail (owner OR in-scope accounting) ────────

const getRequestRoute = createRoute({
  method: "get",
  path: "/requests/{id}",
  tags: ["Requests"],
  summary: "Get a single refund request",
  description:
    "Full detail including per-currency subtotals, never blended (AC-3.5/6.6). " +
    "Returns 404 if the caller is neither the owner nor an in-scope accounting " +
    "reviewer (AC-2.5/6.4) — never 403, so existence is never leaked.",
  security: [{ Bearer: [] }],
  request: { params: RequestIdParamSchema },
  responses: {
    200: {
      content: { "application/json": { schema: RequestDetailSchema } },
      description: "Full request detail",
    },
    401: { description: "Missing or invalid Bearer JWT" },
    404: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "Not found, not owned, and not in the caller's review scope",
    },
  },
});

requestsRouter.openapi(getRequestRoute, async (c) => {
  const sub = c.get("userId");
  const authz = c.get("authz");
  const { id } = c.req.valid("param");

  const exit = await Effect.runPromiseExit(findRequestWithLines(id));
  if (exit._tag === "Failure") {
    throw new Error("Unexpected database failure fetching refund request");
  }

  const request = exit.value;
  if (!request || !canReadRequest(request, authz, sub)) {
    return c.json(notFoundProblem(c.req.path, `Refund request ${id} not found`), 404);
  }

  return c.json(mapRequestDetail(request), 200);
});

// ─── DELETE /requests/:id — draft-only ─────────────────────────────────────

const deleteRequestRoute = createRoute({
  method: "delete",
  path: "/requests/{id}",
  tags: ["Requests"],
  summary: "Delete a draft refund request",
  description:
    "Deletes the request. 204 only when `status == draft` (AC-1.4); 409 " +
    "otherwise (AC-2.3/8.3). 404 if not found, not owned, or the caller " +
    "lacks the `request:create` capability.",
  security: [{ Bearer: [] }],
  request: { params: RequestIdParamSchema },
  responses: {
    204: { description: "Deleted (AC-1.4)" },
    401: { description: "Missing or invalid Bearer JWT" },
    404: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "Not found, not owned, or capability missing",
    },
    409: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "Request is not a draft (AC-2.3) or has prior audit history",
    },
  },
});

requestsRouter.openapi(deleteRequestRoute, async (c) => {
  const sub = c.get("userId");
  const authz = c.get("authz");
  const { id } = c.req.valid("param");

  // Ownership+capability denial and "does not exist" are both 404 — this
  // wholesale capability check (rather than a per-record one) is safe here
  // because deleteDraftRequest ALSO scopes its query by ownerUserId; a
  // caller without `request:create` simply never owns anything it would
  // match, so the 404 message is not misleading.
  if (!hasCapability(authz.permissions, "request", "create")) {
    return c.json(notFoundProblem(c.req.path, `Refund request ${id} not found`), 404);
  }

  const exit = await Effect.runPromiseExit(deleteDraftRequest(id, sub));
  if (exit._tag === "Success") {
    return new Response(null, { status: 204 });
  }

  const cause = exit.cause;
  if (cause._tag === "Fail" && cause.error instanceof NotFoundError) {
    return c.json(notFoundProblem(c.req.path, cause.error.message), 404);
  }
  if (cause._tag === "Fail" && cause.error instanceof ConflictError) {
    return c.json(conflictProblem(c.req.path, cause.error.message), 409);
  }
  throw new Error("Unexpected database failure deleting refund request");
});
