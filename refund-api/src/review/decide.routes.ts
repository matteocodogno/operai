/**
 * Accounting decision endpoints (T12, specs/20260716-refund-service).
 *
 *   PUT  /review/requests/:id/lines/:lineId/approved-total → 200 line
 *   POST /review/requests/:id/approve                      → 200 request
 *   POST /review/requests/:id/reject                       → 200 request
 *
 * Entity-scoped (404 out of scope, mirroring GET /requests/:id — ADR 20260716-entity-scoped-abac-refund-api),
 * capability-gated per action (403 absent — `request:set-approved-total`/
 * `approve`/`reject`), submitted-only (409 otherwise, AC-7.4). Both approve
 * and reject are WHOLE-REQUEST decisions, including out-of-scope lines
 * (AC-7.6) — `decide.repo.ts` never filters lines by the deciding user's own
 * scope, only gates ACCESS to the request via the same "at least one line
 * matches" predicate.
 *
 * T13 adds the post-commit notify trigger (AC-3.6, ADR 20260716-system-notifications-cross-user-trigger): after an
 * approve/reject decision COMMITS, `notifyDecision` (lib/notify.ts) pushes
 * an in-app notification to the request owner. Best-effort — wrapped in its
 * own try/catch here as a second line of defense on top of `notify.ts`'s own
 * internal catch-everything contract, so a decision's HTTP response can
 * NEVER fail or roll back because of a notify-side error (ADR 20260716-system-notifications-cross-user-trigger §4).
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
import { ConflictError, NotFoundError, SelfApprovalDeniedError } from "../lib/errors";
import { notifyDecision } from "../lib/notify";
import { notifyDecisionEmail } from "../lib/notifyEmail";
import { findRequestWithLines } from "../requests/requests.repo";
import { mapLine, mapRequestDetail } from "../requests/requests.service";
import {
  LineIdParamSchema,
  ProblemSchema,
  RefundLineResponseSchema,
  RequestDetailSchema,
  RequestIdParamSchema,
} from "../requests/requests.schemas";
import type { RequestDetail } from "../requests/requests.schemas";
import {
  approveRequest,
  ClassificationMissingError,
  rejectLine,
  rejectRequest,
  restoreLine,
  setApprovedTotal,
} from "./decide.repo";
import {
  ApprovedTotalBodySchema,
  RejectBodySchema,
  RejectLineBodySchema,
} from "./decide.schemas";
import { approveRestrictedForCaller, scopeForReviewAction } from "./review.service";
import {
  ACCOUNTING_RETRY_AFTER_SECONDS,
  accountingUnavailableProblem,
  AccountingUnavailableError,
} from "../accounting/accountingClient";

/**
 * Fires the post-decision notification (T13, AC-3.6). Never throws — even
 * though `notifyDecision` already promises never to reject, this extra
 * try/catch is deliberate defense-in-depth (ADR 20260716-system-notifications-cross-user-trigger §4: a notify failure
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

/**
 * Fires the post-decision EMAIL (specs/20260716-refund-service AC-3.6, email
 * channel) — a second, independent channel alongside the in-app push above.
 *
 * Independent in both directions, which is why this is its own function and
 * its own try/catch rather than a branch inside `notifyDecisionBestEffort`:
 * an email outage must not suppress the in-app notification, and an in-app
 * failure must not suppress the email. Both are awaited AFTER the decision
 * has committed and neither can fail the response (ADR 20260716-system-notifications-cross-user-trigger §4).
 *
 * `approvedTotals` is derived from the decision's own re-fetched detail, so
 * the figure in the email is the one the employee sees in-app — never a
 * separately-recomputed number that could drift from it.
 */
async function emailDecisionBestEffort(
  detail: RequestDetail,
  outcome: "approved" | "rejected",
): Promise<void> {
  try {
    await notifyDecisionEmail(outcome, {
      requestId: detail.id,
      recipientEmail: detail.owner.email,
      decidedAt: detail.decidedAt ? new Date(detail.decidedAt) : new Date(),
      // `approvedCents` is null for any currency whose lines were all left
      // untouched during review; approving defaults those to the requested
      // amount (requests.service.ts), so falling back to `requestedCents`
      // here reports what was actually approved rather than dropping the
      // currency from the mail entirely.
      approvedTotals: detail.subtotals.map((s) => ({
        currency: s.currency,
        amountCents: s.approvedCents ?? s.requestedCents,
      })),
    });
  } catch (error) {
    console.error(
      `[refund-api] notifyDecisionEmail threw unexpectedly for request ${detail.id} ` +
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

/**
 * specs/20260721-self-approval-control, ADR 20260721-self-approval-condition-and-403-exception point 6 — the distinguishable
 * self-approval 403: same RFC 7807 shape as `forbiddenProblem`, plus a
 * stable extension member `code: "self_approval_forbidden"` (AC-6.1's
 * i18n-safe discriminator). The pre-existing capability-absent 403
 * (`forbiddenProblem`) intentionally carries NO `code`.
 */
const selfApprovalForbiddenProblem = (path: string) => ({
  type: "https://httpstatuses.com/403",
  title: "Forbidden",
  status: 403 as const,
  detail: "You cannot approve a refund request you submitted yourself.",
  instance: path,
  code: "self_approval_forbidden" as const,
});

/**
 * specs/20260721-self-approval-control, ADR 20260721-self-approval-condition-and-403-exception point 5 (plan.md D4) — a
 * structured, parseable log event on every self-approval denial (AC-6.2:
 * distinct, attempted-but-denied, never "nothing happened"; AC-6.3: who /
 * which request / when). Deliberately NOT a new `RefundAuditEntry` row (see
 * ADR 20260721-self-approval-condition-and-403-exception for the rejected alternative) — this is a security/operational
 * event, not a financial state transition.
 */
function logSelfApprovalDenied(actorUserId: string, requestId: string): void {
  console.log(
    JSON.stringify({
      event: "refund.self_approval_denied",
      actorUserId,
      requestId,
      timestamp: new Date().toISOString(),
    }),
  );
}

const notFoundProblem = (path: string, detail: string) => ({
  type: "https://httpstatuses.com/404",
  title: "Not Found",
  status: 404 as const,
  detail,
  instance: path,
});

const conflictProblem = (path: string, detail: string, code?: string) => ({
  type: "https://httpstatuses.com/409",
  title: "Conflict",
  status: 409 as const,
  detail,
  instance: path,
  ...(code ? { code } : {}),
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

decideRouter.use(
  "/review/requests/:id/lines/:lineId/reject",
  bodyLimit({
    maxSize: REJECT_BODY_SIZE_LIMIT,
    onError: (c) =>
      c.json(payloadTooLargeProblem(c.req.path, REJECT_BODY_SIZE_LIMIT), 413),
  }),
);

decideRouter.use("/review/requests/:id/lines/:lineId/reject", jwtMiddleware);
decideRouter.use("/review/requests/:id/lines/:lineId/reject", authzMiddleware);
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
    "scope, ADR 20260716-entity-scoped-abac-refund-api). Writes an approved_total_set audit row (AC-8.1).",
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
    // setApprovedTotal only ever succeeds while the request is `submitted`
    // (ensureInScopeSubmittedRequest's guard) — a travel_km line here is
    // always FROZEN (Decision 1), never live.
    return c.json(mapLine(exit.value, "submitted"), 200);
  }

  const cause = exit.cause;
  if (cause._tag === "Fail" && cause.error instanceof NotFoundError) {
    return c.json(notFoundProblem(c.req.path, cause.error.message), 404);
  }
  if (cause._tag === "Fail" && cause.error instanceof ConflictError) {
    return c.json(conflictProblem(c.req.path, cause.error.message, cause.error.code), 409);
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
    "'approved' audit row (AC-8.1). specs/20261119-accounting: a request with at least one " +
    "non-rejected WellD CH line first reads Accounting live (reference data, and the rates of its " +
    "foreign-currency lines), outside any transaction; if that fails the approval is refused with 503 " +
    "`accounting_unavailable` (Retry-After) and nothing changes (AC-6.1, AC-6.2). Then, in one " +
    "transaction, every non-rejected WellD CH line is classified and COPIED (account, VAT code, and the " +
    "exchange rate in effect, or left \"rate pending\", AC-5.1, AC-5.6) and every non-rejected line, of " +
    "either entity, gets its receipt number (20261118 AC-4.1). A request with no non-rejected WellD CH " +
    "line never calls Accounting (AC-6.4). specs/20260721-self-approval-control: if the " +
    "caller's `request:approve` grant carries the self-approval restriction " +
    "and the caller owns the request, denied with 403 " +
    "`code: self_approval_forbidden` BEFORE the entity-scope 404 and the " +
    "status 409 (ADR 20260721-self-approval-condition-and-403-exception).",
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
      description:
        "Caller lacks the `request:approve` capability, OR (specs/20260721-self-approval-control, " +
        "ADR 20260721-self-approval-condition-and-403-exception) the caller owns the request and their approve grant " +
        "carries the self-approval restriction — distinguished by the " +
        "extension member `code: \"self_approval_forbidden\"`, absent on " +
        "the capability-absent case.",
    },
    404: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "Not found or out of the caller's entity scope",
    },
    409: {
      content: { "application/json": { schema: ProblemSchema } },
      description:
        "Request is not submitted (already decided), or every line is " +
        "rejected (`code: all_lines_rejected`), or (specs/20261118-refund-accounting-export) " +
        "`code: accounting_release_pending` (the release script has not run yet), or " +
        "`code: classification_missing` with `lines: [{ lineId, date, type, missing: " +
        "(\"account\" | \"vatCode\")[] }]` (a non-rejected WellD CH line has no hand copy and no usable " +
        "default: none set, or its entry deactivated or no longer found; nothing was changed and no receipt " +
        "number consumed)",
    },
    503: {
      content: { "application/json": { schema: ProblemSchema } },
      description:
        "`code: accounting_unavailable`, with `Retry-After`: Accounting could not be read, so nothing was approved " +
        "(AC-6.1, AC-6.2, AC-6.8)",
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

  const selfApprovalRestricted = approveRestrictedForCaller(authz);

  const exit = await Effect.runPromiseExit(
    approveRequest(id, scope, sub, email, selfApprovalRestricted, c.get("userName")),
  );
  if (exit._tag === "Failure") {
    const cause = exit.cause;
    if (cause._tag === "Fail" && cause.error instanceof SelfApprovalDeniedError) {
      logSelfApprovalDenied(sub, id);
      return c.json(selfApprovalForbiddenProblem(c.req.path), 403);
    }
    if (cause._tag === "Fail" && cause.error instanceof NotFoundError) {
      return c.json(notFoundProblem(c.req.path, cause.error.message), 404);
    }
    if (cause._tag === "Fail" && cause.error instanceof AccountingUnavailableError) {
      // AC-6.1, D15: a dependency outage, not a conflict. Nothing was written (AC-6.2); the UI branches on `code`.
      c.header("Retry-After", String(ACCOUNTING_RETRY_AFTER_SECONDS));
      return c.json(accountingUnavailableProblem(c.req.routePath), 503);
    }
    if (cause._tag === "Fail" && cause.error instanceof ClassificationMissingError) {
      return c.json(
        {
          ...conflictProblem(c.req.path, cause.error.message, "classification_missing"),
          lines: cause.error.lines.map((l) => ({
            lineId: l.lineId,
            date: l.date,
            type: l.type,
            missing: [...l.missing],
          })),
        },
        409,
      );
    }
    if (cause._tag === "Fail" && cause.error instanceof ConflictError) {
      return c.json(conflictProblem(c.req.path, cause.error.message, cause.error.code), 409);
    }
    throw new Error("Unexpected database failure approving refund request");
  }

  const detail = await fetchDetailAfterDecision(id);
  // Post-commit, best-effort (AC-3.6/ADR 20260716-system-notifications-cross-user-trigger) — never blocks or fails this response.
  await notifyDecisionBestEffort(detail.owner.userId, id, "approved");
  await emailDecisionBestEffort(detail, "approved");
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
    rejectRequest(id, scope, sub, email, motivation, c.get("userName")),
  );
  if (exit._tag === "Failure") {
    const cause = exit.cause;
    if (cause._tag === "Fail" && cause.error instanceof NotFoundError) {
      return c.json(notFoundProblem(c.req.path, cause.error.message), 404);
    }
    if (cause._tag === "Fail" && cause.error instanceof ConflictError) {
      return c.json(conflictProblem(c.req.path, cause.error.message, cause.error.code), 409);
    }
    throw new Error("Unexpected database failure rejecting refund request");
  }

  const detail = await fetchDetailAfterDecision(id);
  // Post-commit, best-effort (AC-3.6/ADR 20260716-system-notifications-cross-user-trigger) — never blocks or fails this response.
  await notifyDecisionBestEffort(detail.owner.userId, id, "rejected");
  await emailDecisionBestEffort(detail, "rejected");
  return c.json(detail, 200);
});

// ─── POST/DELETE /review/requests/:id/lines/:lineId/reject ────────────────
//
// specs/20260716-refund-service amendment (2026-11-10): reject ONE line, with a mandatory
// reason, instead of the whole request — and take it back while the
// request is still `submitted`. Gated on `request:reject`: refusing a line
// is a rejection, and the reason is what the employee is told.

const lineRejectionResponses = {
  401: { description: "Missing or invalid Bearer JWT" },
  403: {
    content: { "application/json": { schema: ProblemSchema } },
    description: "Caller lacks the `request:reject` capability",
  },
  404: {
    content: { "application/json": { schema: ProblemSchema } },
    description:
      "Not found, out of the caller's entity scope, or the line does not belong to the request",
  },
  409: {
    content: { "application/json": { schema: ProblemSchema } },
    description:
      "Request is not submitted, or the line is already in the requested state " +
      "(`code: line_rejected` / `line_not_rejected`)",
  },
} as const;

const rejectLineRoute = createRoute({
  method: "post",
  path: "/review/requests/{id}/lines/{lineId}/reject",
  tags: ["Review"],
  summary: "Reject one line of a submitted request (accounting review)",
  description:
    "Requires a non-empty `reason` (422 otherwise). Sets the line's approved " +
    "total to 0 and records who rejected it and why. Submitted-only (409 " +
    "otherwise), entity-scoped (404 if out of scope). Writes a " +
    "'line_rejected' audit row. Approving a request whose every line is " +
    "rejected is refused with 409 `code: all_lines_rejected`.",
  security: [{ Bearer: [] }],
  request: {
    params: LineIdParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: RejectLineBodySchema } },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: RefundLineResponseSchema } },
      description: "Line rejected",
    },
    ...lineRejectionResponses,
    422: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "Empty (or whitespace-only) or over-long reason",
    },
  },
});

const restoreLineRoute = createRoute({
  method: "delete",
  path: "/review/requests/{id}/lines/{lineId}/reject",
  tags: ["Review"],
  summary: "Withdraw a line rejection (accounting review)",
  description:
    "Clears the line's rejection and returns its approved total to untouched " +
    "(approve defaults it to the requested amount). Submitted-only (409 " +
    "otherwise), entity-scoped (404 if out of scope). Writes a " +
    "'line_restored' audit row.",
  security: [{ Bearer: [] }],
  request: { params: LineIdParamSchema },
  responses: {
    200: {
      content: { "application/json": { schema: RefundLineResponseSchema } },
      description: "Line restored",
    },
    ...lineRejectionResponses,
  },
});

decideRouter.openapi(rejectLineRoute, async (c) => {
  const sub = c.get("userId");
  const email = c.get("email");
  const { id, lineId } = c.req.valid("param");
  const { reason } = c.req.valid("json");

  const scope = scopeForReviewAction(c.get("authz"), "reject");
  if (scope === undefined) {
    return c.json(
      forbiddenProblem(c.req.path, "You do not have permission to reject refund lines"),
      403,
    );
  }

  const exit = await Effect.runPromiseExit(rejectLine(id, lineId, reason, scope, sub, email));
  if (exit._tag === "Success") return c.json(mapLine(exit.value, "submitted"), 200);

  const cause = exit.cause;
  if (cause._tag === "Fail" && cause.error instanceof NotFoundError) {
    return c.json(notFoundProblem(c.req.path, cause.error.message), 404);
  }
  if (cause._tag === "Fail" && cause.error instanceof ConflictError) {
    return c.json(conflictProblem(c.req.path, cause.error.message, cause.error.code), 409);
  }
  throw new Error("Unexpected database failure rejecting the refund line");
});

decideRouter.openapi(restoreLineRoute, async (c) => {
  const sub = c.get("userId");
  const email = c.get("email");
  const { id, lineId } = c.req.valid("param");

  const scope = scopeForReviewAction(c.get("authz"), "reject");
  if (scope === undefined) {
    return c.json(
      forbiddenProblem(c.req.path, "You do not have permission to reject refund lines"),
      403,
    );
  }

  const exit = await Effect.runPromiseExit(restoreLine(id, lineId, scope, sub, email));
  if (exit._tag === "Success") return c.json(mapLine(exit.value, "submitted"), 200);

  const cause = exit.cause;
  if (cause._tag === "Fail" && cause.error instanceof NotFoundError) {
    return c.json(notFoundProblem(c.req.path, cause.error.message), 404);
  }
  if (cause._tag === "Fail" && cause.error instanceof ConflictError) {
    return c.json(conflictProblem(c.req.path, cause.error.message, cause.error.code), 409);
  }
  throw new Error("Unexpected database failure restoring the refund line");
});
