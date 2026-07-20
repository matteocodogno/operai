/**
 * Batch terminal-transition endpoints — mark-paid (T6) and discard (T8),
 * specs/008-refund-monthly-processing.
 *
 *   POST /batches/:id/mark-paid → 200 BatchDetail (AC-4.1-4.4, AC-5.1, AC-7.2)
 *   POST /batches/:id/discard   → 200 BatchDetail (AC-6.1-6.3, AC-7.3)
 *
 * A SEPARATE router from `batches.routes.ts` — mirrors `review/decide.routes.ts`'s
 * decision-vs-read split (T11 review queue vs T12 approve/reject). Both
 * actions are terminal and NOT entity-scoped (plan.md § API contracts:
 * "none (whole-batch)") — a missing batch id is 404, an already-`paid`/
 * `discarded` batch is 409 (the CAS in `decide.repo.ts`). Mark-paid is
 * gated on `request:approve` (AC-4.4 — the SAME accounting decision
 * capability 007's approve/reject already uses, no new permission); discard
 * is gated on `request:review` (the same capability compile/candidates use).
 *
 * Mark-paid additionally fans out a per-owner best-effort `paid` push
 * (`notifyPaid`, lib/notify.ts, ADR-0017/US-5) AFTER its transaction has
 * committed — wrapped in its own try/catch here as defense-in-depth on top
 * of `notifyPaid`'s own never-throws contract (mirrors
 * `review/decide.routes.ts`'s `notifyDecisionBestEffort`), so the mark-paid
 * HTTP response can NEVER fail or roll back because of a notify-side error.
 * Discard has no employee-facing notify (only the release + audit trail).
 *
 * Both handlers re-fetch the batch via `fetchBatchWithRequests`
 * (batches.repo.ts, joins through the append-only `RefundBatchItem`, so
 * discard's now-released requests are still shown) and reuse
 * `mapBatchDetail` / `resolvePdfLink` — the SAME response shape `GET
 * /batches/:id` (T4) and the compile response (T3) already produce.
 */

import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { Effect } from "effect";
import { authzMiddleware, type AuthzVariables } from "../auth/authz.middleware";
import { jwtMiddleware } from "../auth/jwt.middleware";
import { hasCapability } from "../authz/conditions";
import { ConflictError, NotFoundError } from "../lib/errors";
import { notifyPaid } from "../lib/notify";
import { ProblemSchema } from "../requests/requests.schemas";
import { discardBatch, markBatchPaid } from "./decide.repo";
import { fetchBatchWithRequests } from "./batches.repo";
import { mapBatchDetail } from "./batches.service";
import { resolvePdfLink } from "./pdfLink";
import { BatchDetailSchema, BatchIdParamSchema } from "./batches.schemas";

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

// ─── Router ──────────────────────────────────────────────────────────────────

export const batchDecideRouter = new OpenAPIHono<{ Variables: AuthzVariables }>({
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

batchDecideRouter.use("/batches/:id/mark-paid", jwtMiddleware);
batchDecideRouter.use("/batches/:id/mark-paid", authzMiddleware);
batchDecideRouter.use("/batches/:id/discard", jwtMiddleware);
batchDecideRouter.use("/batches/:id/discard", authzMiddleware);

/**
 * Re-fetches + re-maps the batch detail after a successful terminal
 * transition. `resolvePdfLink` never throws (OWASP A04 fix round,
 * pdfLink.ts) — a render/store failure here degrades to `pdf: null` on an
 * otherwise-normal `BatchDetail`, which matters MORE here than anywhere else
 * in this API: by the time this runs, `markBatchPaid`/`discardBatch`'s
 * transaction has ALREADY COMMITTED (money moved / batch voided). This
 * function must never let a PDF-side failure turn that into a misleading
 * 500 on top of a real, already-applied financial action.
 */
async function fetchDetailAfterTransition(batchId: string) {
  const exit = await Effect.runPromiseExit(fetchBatchWithRequests(batchId));
  if (exit._tag === "Failure" || !exit.value) {
    throw new Error(
      `Unexpected database failure re-fetching refund batch ${batchId} after a terminal transition`,
    );
  }
  const batch = exit.value;
  const pdf = await resolvePdfLink(batch);
  return mapBatchDetail(batch, pdf);
}

/**
 * Fires the post-mark-paid per-owner notification (US-5, ADR-0017). Never
 * throws — even though `notifyPaid` already promises never to reject, this
 * extra try/catch is deliberate defense-in-depth.
 */
async function notifyPaidBestEffort(recipientId: string, requestId: string): Promise<void> {
  try {
    await notifyPaid({ recipientId, requestId });
  } catch (error) {
    console.error(
      `[refund-api] notifyPaid threw unexpectedly for request ${requestId} — ` +
        "mark-paid NOT rolled back:",
      error instanceof Error ? error.message : error,
    );
  }
}

// ─── POST /batches/:id/mark-paid ────────────────────────────────────────────

const markPaidRoute = createRoute({
  method: "post",
  path: "/batches/{id}/mark-paid",
  tags: ["Batches"],
  summary: "Mark a compiled batch as paid (terminal)",
  description:
    "Terminal CAS `compiled → paid`: a second mark-paid, or a mark-paid " +
    "racing a concurrent discard, 409s (AC-4.3). Every included request " +
    "flips `approved → paid` atomically with the batch (AC-4.1) — never " +
    "gated on the compilation email's delivery status (AC-4.2). Requires " +
    "`request:approve` (AC-4.4, the SAME capability 007's approve/reject " +
    "already uses — no new permission). Post-commit, best-effort: fans out " +
    "one in-app `paid` push per included request's owner (US-5).",
  security: [{ Bearer: [] }],
  request: { params: BatchIdParamSchema },
  responses: {
    200: {
      content: { "application/json": { schema: BatchDetailSchema } },
      description: "Paid",
    },
    401: { description: "Missing or invalid Bearer JWT" },
    403: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "Caller lacks the `request:approve` capability",
    },
    404: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "No batch with that id",
    },
    409: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "Batch is not `compiled` (already paid or discarded)",
    },
  },
});

batchDecideRouter.openapi(markPaidRoute, async (c) => {
  const sub = c.get("userId");
  const email = c.get("email");
  const authz = c.get("authz");
  const { id } = c.req.valid("param");

  if (!hasCapability(authz.permissions, "request", "approve")) {
    return c.json(
      forbiddenProblem(c.req.path, "You do not have permission to mark refund batches as paid"),
      403,
    );
  }

  const exit = await Effect.runPromiseExit(markBatchPaid(id, sub, email));
  if (exit._tag === "Failure") {
    const cause = exit.cause;
    if (cause._tag === "Fail" && cause.error instanceof NotFoundError) {
      return c.json(notFoundProblem(c.req.path, cause.error.message), 404);
    }
    if (cause._tag === "Fail" && cause.error instanceof ConflictError) {
      return c.json(conflictProblem(c.req.path, cause.error.message), 409);
    }
    throw new Error("Unexpected database failure marking refund batch paid");
  }

  const { paidRequestOwners } = exit.value;
  for (const { requestId, ownerUserId } of paidRequestOwners) {
    // Post-commit, best-effort (US-5/ADR-0017) — never blocks or fails this response.
    await notifyPaidBestEffort(ownerUserId, requestId);
  }

  const detail = await fetchDetailAfterTransition(id);
  return c.json(detail, 200);
});

// ─── POST /batches/:id/discard ──────────────────────────────────────────────

const discardRoute = createRoute({
  method: "post",
  path: "/batches/{id}/discard",
  tags: ["Batches"],
  summary: "Discard a compiled batch (terminal, void)",
  description:
    "Terminal CAS `compiled → discarded`: a second discard, or a discard " +
    "racing a concurrent mark-paid, 409s (AC-6.2). Every included request " +
    "is released back to the candidate pool (`batchId` nulled, status " +
    "stays `approved` — AC-6.1) and becomes eligible for a future compile " +
    "again. `RefundBatchItem` membership rows are KEPT forever (AC-6.3/7.3) " +
    "— the batch, and its PDF, remain fully inspectable after discard. " +
    "Requires `request:review`.",
  security: [{ Bearer: [] }],
  request: { params: BatchIdParamSchema },
  responses: {
    200: {
      content: { "application/json": { schema: BatchDetailSchema } },
      description: "Discarded",
    },
    401: { description: "Missing or invalid Bearer JWT" },
    403: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "Caller lacks the `request:review` capability",
    },
    404: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "No batch with that id",
    },
    409: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "Batch is not `compiled` (already paid or discarded)",
    },
  },
});

batchDecideRouter.openapi(discardRoute, async (c) => {
  const sub = c.get("userId");
  const email = c.get("email");
  const authz = c.get("authz");
  const { id } = c.req.valid("param");

  if (!hasCapability(authz.permissions, "request", "review")) {
    return c.json(
      forbiddenProblem(c.req.path, "You do not have permission to discard refund batches"),
      403,
    );
  }

  const exit = await Effect.runPromiseExit(discardBatch(id, sub, email));
  if (exit._tag === "Failure") {
    const cause = exit.cause;
    if (cause._tag === "Fail" && cause.error instanceof NotFoundError) {
      return c.json(notFoundProblem(c.req.path, cause.error.message), 404);
    }
    if (cause._tag === "Fail" && cause.error instanceof ConflictError) {
      return c.json(conflictProblem(c.req.path, cause.error.message), 409);
    }
    throw new Error("Unexpected database failure discarding refund batch");
  }

  const detail = await fetchDetailAfterTransition(id);
  return c.json(detail, 200);
});
