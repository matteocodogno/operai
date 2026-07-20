/**
 * Expense-line endpoints (T8, specs/007-refund-service).
 *
 *   POST   /requests/:id/lines          → 201 line
 *   PUT    /requests/:id/lines/:lineId  → 200 line (whole-object replace)
 *   DELETE /requests/:id/lines/:lineId  → 204
 *
 * All draft-only (409 otherwise) and owner-scoped (404 for not-found /
 * not-owned / missing `request:create` capability — never 403, matching
 * requests.routes.ts's "any /requests/:id subroute → 404" denial rule).
 * Body validation (422, AC-1.2/1.6) lives in lines.schemas.ts.
 *
 * BODY SIZE GUARD (OWASP A04 fix): `motivo` caps at 2000 chars (LineBodySchema)
 * — worst-case ~8 KiB of UTF-8 — so 16 KiB gives headroom for the JSON
 * envelope and the rest of the (small, scalar) line fields. bodyLimit fires
 * BEFORE jwtMiddleware/authzMiddleware/zod validation, mirroring estimai-api's
 * bodyLimit precedent (estimates.routes.ts "OWASP A04 fix").
 */

import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { Effect } from "effect";
import { bodyLimit } from "hono/body-limit";
import { authzMiddleware, type AuthzVariables } from "../auth/authz.middleware";
import { jwtMiddleware } from "../auth/jwt.middleware";
import { hasCapability } from "../authz/conditions";
import { ConflictError, NotFoundError } from "../lib/errors";
import { createLine, deleteLine, updateLine } from "./lines.repo";
import { LineBodySchema } from "./lines.schemas";
import {
  LineIdParamSchema,
  ProblemSchema,
  RefundLineResponseSchema,
  RequestIdParamSchema,
} from "./requests.schemas";
import { mapLine } from "./requests.service";

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

const payloadTooLargeProblem = (path: string, limitBytes: number) => ({
  type: "https://httpstatuses.com/413",
  title: "Payload Too Large",
  status: 413 as const,
  detail: `Request body exceeds the maximum allowed size of ${(limitBytes / 1024).toFixed(0)} KB.`,
  instance: path,
});

const LINES_BODY_SIZE_LIMIT = 16 * 1024; // 16 KiB — see file header

// ─── Router ──────────────────────────────────────────────────────────────────
//
// defaultHook returns 422 (not the framework's default 400) for a malformed
// body — the plan's contract explicitly calls line validation failures 422,
// with the offending field named via the zod issue path (AC-1.2/1.6).

export const linesRouter = new OpenAPIHono<{ Variables: AuthzVariables }>({
  defaultHook: (result, c) => {
    if (!result.success) {
      return c.json(
        {
          type: "https://httpstatuses.com/422",
          title: "Unprocessable Entity",
          status: 422,
          detail: result.error.issues
            .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
            .join("; "),
          instance: c.req.path,
        },
        422,
      );
    }
    return undefined;
  },
});

const linesBodyLimit = bodyLimit({
  maxSize: LINES_BODY_SIZE_LIMIT,
  onError: (c) =>
    c.json(payloadTooLargeProblem(c.req.path, LINES_BODY_SIZE_LIMIT), 413),
});

linesRouter.use("/requests/:id/lines", linesBodyLimit);
linesRouter.use("/requests/:id/lines/*", linesBodyLimit);
linesRouter.use("/requests/:id/lines", jwtMiddleware);
linesRouter.use("/requests/:id/lines", authzMiddleware);
linesRouter.use("/requests/:id/lines/*", jwtMiddleware);
linesRouter.use("/requests/:id/lines/*", authzMiddleware);

/**
 * A caller without `request:create` never owns anything the repo query would
 * match either, so folding this into the same 404 the repo produces for
 * "not found / not owned" is not a misleading response (mirrors
 * requests.routes.ts's DELETE handler).
 */
function requireCreateCapabilityOr404(
  authz: AuthzVariables["authz"],
  path: string,
  requestId: string,
) {
  if (hasCapability(authz.permissions, "request", "create")) return null;
  return notFoundProblem(path, `Refund request ${requestId} not found`);
}

// ─── POST /requests/:id/lines ───────────────────────────────────────────────

const createLineRoute = createRoute({
  method: "post",
  path: "/requests/{id}/lines",
  tags: ["Requests"],
  summary: "Add an expense line to a draft request",
  description:
    "Draft-only (409 otherwise). Validates date/type/motivo/" +
    "requestedAmountCents/entity as required, and the km-iff-travel_km rule " +
    "(422, AC-1.2/1.6).",
  security: [{ Bearer: [] }],
  request: {
    params: RequestIdParamSchema,
    body: { required: true, content: { "application/json": { schema: LineBodySchema } } },
  },
  responses: {
    201: {
      content: { "application/json": { schema: RefundLineResponseSchema } },
      description: "Line created",
    },
    401: { description: "Missing or invalid Bearer JWT" },
    404: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "Request not found, not owned, or capability missing",
    },
    409: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "Request is not a draft",
    },
    422: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "Validation failure — offending field(s) named",
    },
  },
});

linesRouter.openapi(createLineRoute, async (c) => {
  const sub = c.get("userId");
  const authz = c.get("authz");
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");

  const denial = requireCreateCapabilityOr404(authz, c.req.path, id);
  if (denial) return c.json(denial, 404);

  const exit = await Effect.runPromiseExit(createLine(id, sub, body));
  if (exit._tag === "Success") {
    // ensureOwnedDraftRequest guarantees the request is `draft` — a travel_km
    // line here is always LIVE (Decision 1), never frozen.
    return c.json(mapLine(exit.value, "draft"), 201);
  }

  const cause = exit.cause;
  if (cause._tag === "Fail" && cause.error instanceof NotFoundError) {
    return c.json(notFoundProblem(c.req.path, cause.error.message), 404);
  }
  if (cause._tag === "Fail" && cause.error instanceof ConflictError) {
    return c.json(conflictProblem(c.req.path, cause.error.message), 409);
  }
  throw new Error("Unexpected database failure creating refund line");
});

// ─── PUT /requests/:id/lines/:lineId ────────────────────────────────────────

const updateLineRoute = createRoute({
  method: "put",
  path: "/requests/{id}/lines/{lineId}",
  tags: ["Requests"],
  summary: "Replace an expense line (whole-object update)",
  description:
    "Draft-only (409 otherwise). Same validation as POST — the PUT body " +
    "commits the whole line object.",
  security: [{ Bearer: [] }],
  request: {
    params: LineIdParamSchema,
    body: { required: true, content: { "application/json": { schema: LineBodySchema } } },
  },
  responses: {
    200: {
      content: { "application/json": { schema: RefundLineResponseSchema } },
      description: "Line updated",
    },
    401: { description: "Missing or invalid Bearer JWT" },
    404: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "Request/line not found, not owned, or capability missing",
    },
    409: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "Request is not a draft",
    },
    422: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "Validation failure — offending field(s) named",
    },
  },
});

linesRouter.openapi(updateLineRoute, async (c) => {
  const sub = c.get("userId");
  const authz = c.get("authz");
  const { id, lineId } = c.req.valid("param");
  const body = c.req.valid("json");

  const denial = requireCreateCapabilityOr404(authz, c.req.path, id);
  if (denial) return c.json(denial, 404);

  const exit = await Effect.runPromiseExit(updateLine(id, lineId, sub, body));
  if (exit._tag === "Success") {
    return c.json(mapLine(exit.value, "draft"), 200);
  }

  const cause = exit.cause;
  if (cause._tag === "Fail" && cause.error instanceof NotFoundError) {
    return c.json(notFoundProblem(c.req.path, cause.error.message), 404);
  }
  if (cause._tag === "Fail" && cause.error instanceof ConflictError) {
    return c.json(conflictProblem(c.req.path, cause.error.message), 409);
  }
  throw new Error("Unexpected database failure updating refund line");
});

// ─── DELETE /requests/:id/lines/:lineId ────────────────────────────────────

const deleteLineRoute = createRoute({
  method: "delete",
  path: "/requests/{id}/lines/{lineId}",
  tags: ["Requests"],
  summary: "Delete an expense line",
  description: "Draft-only (409 otherwise).",
  security: [{ Bearer: [] }],
  request: { params: LineIdParamSchema },
  responses: {
    204: { description: "Deleted" },
    401: { description: "Missing or invalid Bearer JWT" },
    404: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "Request/line not found, not owned, or capability missing",
    },
    409: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "Request is not a draft",
    },
  },
});

linesRouter.openapi(deleteLineRoute, async (c) => {
  const sub = c.get("userId");
  const authz = c.get("authz");
  const { id, lineId } = c.req.valid("param");

  const denial = requireCreateCapabilityOr404(authz, c.req.path, id);
  if (denial) return c.json(denial, 404);

  const exit = await Effect.runPromiseExit(deleteLine(id, lineId, sub));
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
  throw new Error("Unexpected database failure deleting refund line");
});
