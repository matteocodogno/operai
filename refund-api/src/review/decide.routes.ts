/**
 * Accounting decision endpoints (T12, specs/007-refund-service).
 *
 *   PUT  /review/requests/:id/lines/:lineId/approved-total → 200 line
 *   POST /review/requests/:id/approve                      → 200 request
 *   POST /review/requests/:id/reject                       → 200 request
 *
 * Entity-scoped (404 out of scope, mirroring GET /requests/:id — ADR-0015),
 * capability-gated per action (403 absent — `request:set-approved-total`/
 * `approve`/`reject`), submitted-only (409 otherwise, AC-7.4). Both approve
 * and reject are WHOLE-REQUEST decisions, including out-of-scope lines
 * (AC-7.6) — `decide.repo.ts` never filters lines by the deciding user's own
 * scope, only gates ACCESS to the request via the same "at least one line
 * matches" predicate.
 *
 * T13 adds the post-commit notify trigger (AC-3.6, ADR-0017): after an
 * approve/reject decision COMMITS, `notifyDecision` (lib/notify.ts) pushes
 * an in-app notification to the request owner. Best-effort — wrapped in its
 * own try/catch here as a second line of defense on top of `notify.ts`'s own
 * internal catch-everything contract, so a decision's HTTP response can
 * NEVER fail or roll back because of a notify-side error (ADR-0017 §4).
 *
 * BODY SIZE GUARD (OWASP A04 fix): only approved-total (a single integer
 * field) and reject (a free-text `motivation` with NO schema-level max
 * length — RejectBodySchema) accept a body; approve takes none. bodyLimit is
 * scoped per-path accordingly, fires BEFORE jwtMiddleware/authzMiddleware.
 */

import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { Effect } from "effect";
import { bodyLimit } from "hono/body-limit";
import { authzMiddleware, type AuthzVariables } from "../auth/authz.middleware";
import { jwtMiddleware } from "../auth/jwt.middleware";
import { ConflictError, NotFoundError } from "../lib/errors";
import { notifyDecision } from "../lib/notify";
import { findRequestWithLines } from "../requests/requests.repo";
import { mapLine, mapRequestDetail } from "../requests/requests.service";
import {
  LineIdParamSchema,
  ProblemSchema,
  RefundLineResponseSchema,
  RequestDetailSchema,
  RequestIdParamSchema,
} from "../requests/requests.schemas";
import { approveRequest, rejectRequest, setApprovedTotal } from "./decide.repo";
import { ApprovedTotalBodySchema, RejectBodySchema } from "./decide.schemas";
import { scopeForReviewAction } from "./review.service";

/**
 * Fires the post-decision notification (T13, AC-3.6). Never throws — even
 * though `notifyDecision` already promises never to reject, this extra
 * try/catch is deliberate defense-in-depth (ADR-0017 §4: a notify failure
 * must NEVER fail or roll back the decision response).
 */
async function notifyDecisionBestEffort(
  recipientId: string,
  requestId: string,
  outcome: "approved" | "rejected",
): Promise<void> {
  try {
    await notifyDecision({ recipientId, requestId, outcome });
  } catch (error) {
    console.error(
      `[refund-api] notifyDecision threw unexpectedly for request ${requestId} ` +
        `(${outcome}) — decision NOT rolled back:`,
      error instanceof Error ? error.message : error,
    );
  }
}

// ─── Problem JSON helpers ────────────────────────────────────────────────────

const forbiddenProblem = (path: string, detail: string) => ({
  type: "https://httpstatuses.com/403",
  title: "Forbidden",
  status: 403 as const,
  detail,
  instance: path,
});

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

// approved-total's body is a single integer field — 4 KiB is generous.
const APPROVED_TOTAL_BODY_SIZE_LIMIT = 4 * 1024; // 4 KiB
// reject's `motivation` has no schema-level max length (RejectBodySchema) —
// bodyLimit is the ONLY cap on that field; 16 KiB mirrors lines.routes.ts's
// motivo cap as a sensible bound for accounting free-text.
const REJECT_BODY_SIZE_LIMIT = 16 * 1024; // 16 KiB

// ─── Router ──────────────────────────────────────────────────────────────────
//
// defaultHook returns 422 for a malformed body (approvedTotalCents/motivation
// validation) — matches lines.routes.ts's convention for validation failures.

export const decideRouter = new OpenAPIHono<{ Variables: AuthzVariables }>({
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

decideRouter.use(
  "/review/requests/:id/lines/:lineId/approved-total",
  bodyLimit({
    maxSize: APPROVED_TOTAL_BODY_SIZE_LIMIT,
    onError: (c) =>
      c.json(
        payloadTooLargeProblem(c.req.path, APPROVED_TOTAL_BODY_SIZE_LIMIT),
        413,
      ),
  }),
);
decideRouter.use(
  "/review/requests/:id/reject",
  bodyLimit({
    maxSize: REJECT_BODY_SIZE_LIMIT,
    onError: (c) =>
      c.json(payloadTooLargeProblem(c.req.path, REJECT_BODY_SIZE_LIMIT), 413),
  }),
);

decideRouter.use("/review/requests/:id/lines/:lineId/approved-total", jwtMiddleware);
decideRouter.use("/review/requests/:id/lines/:lineId/approved-total", authzMiddleware);
decideRouter.use("/review/requests/:id/approve", jwtMiddleware);
decideRouter.use("/review/requests/:id/approve", authzMiddleware);
decideRouter.use("/review/requests/:id/reject", jwtMiddleware);
decideRouter.use("/review/requests/:id/reject", authzMiddleware);

/** Re-fetches the full detail after a successful decision. */
async function fetchDetailAfterDecision(requestId: string) {
  const exit = await Effect.runPromiseExit(findRequestWithLines(requestId));
  if (exit._tag === "Failure" || !exit.value) {
    throw new Error("Unexpected database failure re-fetching refund request");
  }
  return mapRequestDetail(exit.value);
}

// ─── PUT /review/requests/:id/lines/:lineId/approved-total ────────────────

const setApprovedTotalRoute = createRoute({
  method: "put",
  path: "/review/requests/{id}/lines/{lineId}/approved-total",
  tags: ["Review"],
  summary: "Set a line's approved total (accounting review)",
  description:
    "Submitted-only (409 otherwise, AC-7.4), entity-scoped (404 if out of " +
    "scope, ADR-0015). Writes an approved_total_set audit row (AC-8.1).",
  security: [{ Bearer: [] }],
  request: {
    params: LineIdParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: ApprovedTotalBodySchema } },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: RefundLineResponseSchema } },
      description: "Line updated",
    },
    401: { description: "Missing or invalid Bearer JWT" },
    403: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "Caller lacks the `request:set-approved-total` capability",
    },
    404: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "Not found, out of the caller's entity scope, or the line does not belong to the request",
    },
    409: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "Request is not submitted",
    },
    422: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "approvedTotalCents missing, non-integer, or negative",
    },
  },
});

decideRouter.openapi(setApprovedTotalRoute, async (c) => {
  const sub = c.get("userId");
  const email = c.get("email");
  const authz = c.get("authz");
  const { id, lineId } = c.req.valid("param");
  const { approvedTotalCents } = c.req.valid("json");

  const scope = scopeForReviewAction(authz, "set-approved-total");
  if (scope === undefined) {
    return c.json(
      forbiddenProblem(
        c.req.path,
        "You do not have permission to set an approved total on refund requests",
      ),
      403,
    );
  }

  const exit = await Effect.runPromiseExit(
    setApprovedTotal(id, lineId, approvedTotalCents, scope, sub, email),
  );
  if (exit._tag === "Success") {
    return c.json(mapLine(exit.value), 200);
  }

  const cause = exit.cause;
  if (cause._tag === "Fail" && cause.error instanceof NotFoundError) {
    return c.json(notFoundProblem(c.req.path, cause.error.message), 404);
  }
  if (cause._tag === "Fail" && cause.error instanceof ConflictError) {
    return c.json(conflictProblem(c.req.path, cause.error.message), 409);
  }
  throw new Error("Unexpected database failure setting the approved total");
});

// ─── POST /review/requests/:id/approve ─────────────────────────────────────

const approveRoute = createRoute({
  method: "post",
  path: "/review/requests/{id}/approve",
  tags: ["Review"],
  summary: "Approve a submitted refund request",
  description:
    "Transitions submitted → approved. Each line's approved total is " +
    "finalized to its set value, defaulting to the requested amount for " +
    "any line left untouched (AC-7.2). Whole-request, including lines for " +
    "an entity outside the caller's own scope (AC-7.6). Writes an " +
    "'approved' audit row (AC-8.1).",
  security: [{ Bearer: [] }],
  request: { params: RequestIdParamSchema },
  responses: {
    200: {
      content: { "application/json": { schema: RequestDetailSchema } },
      description: "Approved",
    },
    401: { description: "Missing or invalid Bearer JWT" },
    403: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "Caller lacks the `request:approve` capability",
    },
    404: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "Not found or out of the caller's entity scope",
    },
    409: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "Request is not submitted (already decided)",
    },
  },
});

decideRouter.openapi(approveRoute, async (c) => {
  const sub = c.get("userId");
  const email = c.get("email");
  const authz = c.get("authz");
  const { id } = c.req.valid("param");

  const scope = scopeForReviewAction(authz, "approve");
  if (scope === undefined) {
    return c.json(
      forbiddenProblem(c.req.path, "You do not have permission to approve refund requests"),
      403,
    );
  }

  const exit = await Effect.runPromiseExit(approveRequest(id, scope, sub, email));
  if (exit._tag === "Failure") {
    const cause = exit.cause;
    if (cause._tag === "Fail" && cause.error instanceof NotFoundError) {
      return c.json(notFoundProblem(c.req.path, cause.error.message), 404);
    }
    if (cause._tag === "Fail" && cause.error instanceof ConflictError) {
      return c.json(conflictProblem(c.req.path, cause.error.message), 409);
    }
    throw new Error("Unexpected database failure approving refund request");
  }

  const detail = await fetchDetailAfterDecision(id);
  // Post-commit, best-effort (AC-3.6/ADR-0017) — never blocks or fails this response.
  await notifyDecisionBestEffort(detail.owner.userId, id, "approved");
  return c.json(detail, 200);
});

// ─── POST /review/requests/:id/reject ──────────────────────────────────────

const rejectRoute = createRoute({
  method: "post",
  path: "/review/requests/{id}/reject",
  tags: ["Review"],
  summary: "Reject a submitted refund request",
  description:
    "Requires a non-empty `motivation` (422 otherwise, AC-7.3). Transitions " +
    "submitted → rejected; per-line approved totals are left untouched " +
    "(not applicable to a rejected request). Whole-request, including " +
    "lines for an entity outside the caller's own scope (AC-7.6). Writes a " +
    "'rejected' audit row (AC-8.1).",
  security: [{ Bearer: [] }],
  request: {
    params: RequestIdParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: RejectBodySchema } },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: RequestDetailSchema } },
      description: "Rejected",
    },
    401: { description: "Missing or invalid Bearer JWT" },
    403: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "Caller lacks the `request:reject` capability",
    },
    404: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "Not found or out of the caller's entity scope",
    },
    409: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "Request is not submitted (already decided)",
    },
    422: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "Empty (or whitespace-only) motivation",
    },
  },
});

decideRouter.openapi(rejectRoute, async (c) => {
  const sub = c.get("userId");
  const email = c.get("email");
  const authz = c.get("authz");
  const { id } = c.req.valid("param");
  const { motivation } = c.req.valid("json");

  const scope = scopeForReviewAction(authz, "reject");
  if (scope === undefined) {
    return c.json(
      forbiddenProblem(c.req.path, "You do not have permission to reject refund requests"),
      403,
    );
  }

  const exit = await Effect.runPromiseExit(
    rejectRequest(id, scope, sub, email, motivation),
  );
  if (exit._tag === "Failure") {
    const cause = exit.cause;
    if (cause._tag === "Fail" && cause.error instanceof NotFoundError) {
      return c.json(notFoundProblem(c.req.path, cause.error.message), 404);
    }
    if (cause._tag === "Fail" && cause.error instanceof ConflictError) {
      return c.json(conflictProblem(c.req.path, cause.error.message), 409);
    }
    throw new Error("Unexpected database failure rejecting refund request");
  }

  const detail = await fetchDetailAfterDecision(id);
  // Post-commit, best-effort (AC-3.6/ADR-0017) — never blocks or fails this response.
  await notifyDecisionBestEffort(detail.owner.userId, id, "rejected");
  return c.json(detail, 200);
});
