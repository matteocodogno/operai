/**
 * Candidate preview + compile + read + resend endpoints (T3/T4/T5,
 * specs/008-refund-monthly-processing).
 *
 *   GET  /batches/candidates?cutoff= → 200 CandidatePreview (dry run, US-2, T3)
 *   POST /batches {cutoff?}          → 201 BatchDetail (the atomic-claim core, T3;
 *                                       auto-sends the compilation email post-commit, T5)
 *   GET  /batches                    → 200 BatchSummary[] (history, AC-8.1/8.2, T4)
 *   GET  /batches/:id                → 200 BatchDetail (AC-2.1; 404, T4)
 *   GET  /batches/:id/pdf-url        → 200 {url,expiresAt} (AC-3.4, T4)
 *   POST /batches/:id/email          → 200 {emailStatus,emailDeliveryId} (resend, AC-3.3, T5)
 *
 * Capability gate for candidates/compile: `hasCapability(request, review)` —
 * reused verbatim via `scopeForReviewAction` (review.service.ts) — else 403
 * (AC-1.8). The candidate set (and what compile can claim) is entity-scoped
 * via the SAME predicate the 007 review queue uses (`requestInScope`,
 * ADR-0015); a conditioned grant with no resolved caller entity (`scope ===
 * null`) matches nothing — an empty candidate list for the GET, and the
 * empty-set 422 refusal for the POST (never a 403 — the capability itself
 * IS present).
 *
 * Capability gate for every T4/T5 read/resend route (list/get/pdf-url/email):
 * `hasCapability(request, review)` alone — deliberately NOT entity-scoped
 * (plan.md § Resolved decisions D1: "any user holding the accounting/
 * refund-admin refund capability can list every batch and open every
 * batch's PDF regardless of their own entity scope"). Missing batch id →
 * 404 (never a scope-driven 404 here — there is no scope to fail).
 *
 * Compile is deliberately NOT gated by the request/response body's size in
 * any interesting way (`{cutoff?: ISO string}` only) — a small `bodyLimit`
 * still applies as defense-in-depth, mirroring decide.routes.ts's posture
 * for small-body mutations. The read/resend routes below take no body at
 * all, so none of them need a `bodyLimit`.
 *
 * `GET /batches/:id`'s and `GET /batches/:id/pdf-url`'s PDF link is minted
 * via the shared `resolvePdfLink` (pdfLink.ts) — lazily regenerating the
 * object if a prior `PutObject` never landed (ADR-0019 regenerable-cache
 * posture), so a discarded/paid batch's PDF still resolves.
 *
 * The compilation email (T5, AC-3.1/3.3, ADR-0021) is sent via the SAME
 * `sendCompilationEmailBestEffort` helper (email.ts) at TWO trigger points:
 * post-commit at the end of the compile handler (auto-send) and from the
 * dedicated resend route below — both persist `emailStatus`/
 * `emailLastAttemptAt`/`emailDeliveryId` on the batch identically. Best
 * effort: a notify-api failure NEVER fails or rolls back the triggering
 * compile/resend response (ADR-0011 posture).
 *
 * Mark-paid (T6) and discard (T8) live in a SEPARATE router
 * (`batches/decide.routes.ts`, mirrors `review/decide.routes.ts`'s
 * decision-vs-read split) — terminal, capability-`approve`/`review`-gated
 * state transitions, not reads.
 */

import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { Effect } from "effect";
import { bodyLimit } from "hono/body-limit";
import { authzMiddleware, type AuthzVariables } from "../auth/authz.middleware";
import { jwtMiddleware } from "../auth/jwt.middleware";
import { ValidationError } from "../lib/errors";
import { env } from "../lib/env";
import { mintPresignedGet, putObject } from "../lib/storage";
import { hasCapability } from "../authz/conditions";
import { ProblemSchema } from "../requests/requests.schemas";
import { renderBatchPdf } from "./pdf";
import {
  compileBatch,
  fetchBatchWithRequests,
  fetchCandidateRows,
  listBatchSummaries,
} from "./batches.repo";
import {
  filterCandidatesInScope,
  mapBatchDetail,
  mapBatchSummary,
  mapCandidatePreview,
  scopeForReviewAction,
  toBatchPdfEmployees,
} from "./batches.service";
import { resolvePdfLink } from "./pdfLink";
import { sendCompilationEmailBestEffort } from "./email";
import {
  BatchDetailSchema,
  BatchEmailActionResponseSchema,
  BatchIdParamSchema,
  BatchSummarySchema,
  CandidatePreviewSchema,
  CandidatesQuerySchema,
  CompileBodySchema,
} from "./batches.schemas";
import { GLOBAL_ENTITY_SCOPE } from "../authz/conditions";

// ─── Problem JSON helpers ────────────────────────────────────────────────────

const forbiddenProblem = (path: string, detail: string) => ({
  type: "https://httpstatuses.com/403",
  title: "Forbidden",
  status: 403 as const,
  detail,
  instance: path,
});

const unprocessableProblem = (path: string, detail: string) => ({
  type: "https://httpstatuses.com/422",
  title: "Unprocessable Entity",
  status: 422 as const,
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

const payloadTooLargeProblem = (path: string, limitBytes: number) => ({
  type: "https://httpstatuses.com/413",
  title: "Payload Too Large",
  status: 413 as const,
  detail: `Request body exceeds the maximum allowed size of ${(limitBytes / 1024).toFixed(0)} KB.`,
  instance: path,
});

// The compile body is a single optional ISO datetime string — 4 KiB is generous.
const COMPILE_BODY_SIZE_LIMIT = 4 * 1024; // 4 KiB

// ─── Router ──────────────────────────────────────────────────────────────────
//
// defaultHook returns 422 for a malformed query/body (cutoff not a valid ISO
// datetime) — matches decideRouter's convention for validation failures.

export const batchesRouter = new OpenAPIHono<{ Variables: AuthzVariables }>({
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

batchesRouter.use(
  "/batches",
  bodyLimit({
    maxSize: COMPILE_BODY_SIZE_LIMIT,
    onError: (c) =>
      c.json(payloadTooLargeProblem(c.req.path, COMPILE_BODY_SIZE_LIMIT), 413),
  }),
);

batchesRouter.use("/batches/candidates", jwtMiddleware);
batchesRouter.use("/batches/candidates", authzMiddleware);
batchesRouter.use("/batches", jwtMiddleware);
batchesRouter.use("/batches", authzMiddleware);
batchesRouter.use("/batches/:id", jwtMiddleware);
batchesRouter.use("/batches/:id", authzMiddleware);
batchesRouter.use("/batches/:id/pdf-url", jwtMiddleware);
batchesRouter.use("/batches/:id/pdf-url", authzMiddleware);
batchesRouter.use("/batches/:id/email", jwtMiddleware);
batchesRouter.use("/batches/:id/email", authzMiddleware);

/** `cutoff` defaults to "now" when unspecified (AC-1.1). */
function resolveCutoff(raw: string | undefined): Date {
  return raw ? new Date(raw) : new Date();
}

// ─── GET /batches/candidates ────────────────────────────────────────────────

const candidatesRoute = createRoute({
  method: "get",
  path: "/batches/candidates",
  tags: ["Batches"],
  summary: "Preview the compile candidate set (dry run — writes nothing)",
  description:
    "Every `approved` request not already claimed by a batch, decided at or " +
    "before `cutoff` (defaults to now, AC-1.1), entity-scoped via the same " +
    "predicate the review queue uses (AC-1.2). Grouped per requesting " +
    "employee, per currency (AC-1.6). 403 if the caller holds no " +
    "`request:review` grant at all (AC-1.8).",
  security: [{ Bearer: [] }],
  request: { query: CandidatesQuerySchema },
  responses: {
    200: {
      content: { "application/json": { schema: CandidatePreviewSchema } },
      description: "The candidate set as of `cutoff` (may be empty)",
    },
    401: { description: "Missing or invalid Bearer JWT" },
    403: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "Caller lacks the `request:review` capability",
    },
    422: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "cutoff is not a valid ISO 8601 datetime",
    },
  },
});

batchesRouter.openapi(candidatesRoute, async (c) => {
  const authz = c.get("authz");
  const { cutoff: rawCutoff } = c.req.valid("query");

  const scope = scopeForReviewAction(authz, "review");
  if (scope === undefined) {
    return c.json(
      forbiddenProblem(c.req.path, "You do not have permission to review refund requests"),
      403,
    );
  }

  const cutoff = resolveCutoff(rawCutoff);

  if (scope === null) {
    return c.json(mapCandidatePreview(cutoff, []), 200);
  }

  const exit = await Effect.runPromiseExit(fetchCandidateRows(cutoff));
  if (exit._tag === "Failure") {
    throw new Error("Unexpected database failure listing batch candidates");
  }

  const inScope =
    scope === GLOBAL_ENTITY_SCOPE
      ? exit.value
      : filterCandidatesInScope(exit.value, scope);

  return c.json(mapCandidatePreview(cutoff, inScope), 200);
});

// ─── POST /batches (compile) ────────────────────────────────────────────────

const compileRoute = createRoute({
  method: "post",
  path: "/batches",
  tags: ["Batches"],
  summary: "Compile a batch from the current candidate set (the atomic claim)",
  description:
    "Atomically locks and claims every in-scope eligible request as of " +
    "`cutoff` (defaults to now), creates the RefundBatch + immutable " +
    "RefundBatchItems, writes a batch_compiled audit row per request, then " +
    "(best-effort, post-commit) renders and stores the batch PDF (AC-1.9/1.10; " +
    "T2/ADR-0019). Two concurrent compiles never double-claim the same " +
    "request (AC-1.2/1.5). Refuses with 422 if the locked candidate set is " +
    "empty — nothing is created (AC-1.4). 403 if the caller holds no " +
    "`request:review` grant at all (AC-1.8). The compilation email (T5) is " +
    "NOT sent by this endpoint.",
  security: [{ Bearer: [] }],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: CompileBodySchema } },
    },
  },
  responses: {
    201: {
      content: { "application/json": { schema: BatchDetailSchema } },
      description: "Compiled",
    },
    401: { description: "Missing or invalid Bearer JWT" },
    403: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "Caller lacks the `request:review` capability",
    },
    413: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "Request body too large",
    },
    422: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "cutoff is not a valid ISO 8601 datetime, or the candidate set is empty",
    },
  },
});

batchesRouter.openapi(compileRoute, async (c) => {
  const sub = c.get("userId");
  const email = c.get("email");
  const authz = c.get("authz");
  const { cutoff: rawCutoff } = c.req.valid("json");

  const scope = scopeForReviewAction(authz, "review");
  if (scope === undefined) {
    return c.json(
      forbiddenProblem(c.req.path, "You do not have permission to compile refund batches"),
      403,
    );
  }

  const cutoff = resolveCutoff(rawCutoff);

  if (scope === null) {
    return c.json(
      unprocessableProblem(c.req.path, "No eligible requests to compile for the given cutoff"),
      422,
    );
  }

  const exit = await Effect.runPromiseExit(
    compileBatch(cutoff, scope, sub, email, env.REFUND_ACCOUNTING_DISTRIBUTION_EMAIL),
  );

  if (exit._tag === "Failure") {
    const cause = exit.cause;
    if (cause._tag === "Fail" && cause.error instanceof ValidationError) {
      return c.json(unprocessableProblem(c.req.path, cause.error.message), 422);
    }
    throw new Error("Unexpected database failure compiling refund batch");
  }

  const batch = exit.value;

  // Post-commit, best-effort (ADR-0019 regenerable-cache posture): a failed
  // PutObject does NOT lose the committed batch — pdfObjectKey is already
  // persisted deterministically; a later read (T4) lazily re-renders on miss.
  try {
    const pdfInput = {
      batchId: batch.id,
      cutoff: batch.cutoff,
      generatedAt: batch.createdAt,
      generatedByEmail: batch.createdByEmail,
      employees: toBatchPdfEmployees(batch.requests),
    };
    const pdfBuffer = await renderBatchPdf(pdfInput);
    await putObject(batch.pdfObjectKey, pdfBuffer, "application/pdf");
  } catch (error) {
    console.error(
      `[batches] failed to render/store the compiled PDF for batch ${batch.id} — ` +
        "batch NOT rolled back, object will be lazily regenerated on next read:",
      error instanceof Error ? error.message : error,
    );
  }

  // Auto-send the compilation email (T5, AC-3.1) — best-effort, post-commit,
  // NEVER blocks or fails this response (ADR-0011 posture). The outcome is
  // persisted on the batch row by sendCompilationEmailBestEffort itself;
  // reflect it in THIS response by folding it into the local `batch` object
  // rather than re-fetching.
  const emailOutcome = await sendCompilationEmailBestEffort(
    {
      id: batch.id,
      cutoff: batch.cutoff,
      createdAt: batch.createdAt,
      recipientEmailSnapshot: batch.recipientEmailSnapshot,
    },
    batch.requests.length,
  );

  const pdfUrl = await mintPresignedGet(batch.pdfObjectKey);
  const expiresAt = new Date(Date.now() + 60_000).toISOString();

  return c.json(
    mapBatchDetail(
      {
        ...batch,
        emailStatus: emailOutcome.status,
        emailLastAttemptAt: new Date(),
        emailDeliveryId: emailOutcome.deliveryId,
      },
      { url: pdfUrl, expiresAt },
    ),
    201,
  );
});

// ─── POST /batches/:id/email (resend — AC-3.3, T5) ─────────────────────────

const resendEmailRoute = createRoute({
  method: "post",
  path: "/batches/{id}/email",
  tags: ["Batches"],
  summary: "Resend the compilation email for an already-compiled batch",
  description:
    "Mints a fresh `/system/emails` call to the SAME configured " +
    "distribution address the batch was compiled with " +
    "(`recipientEmailSnapshot`, AC-3.4) — never a live re-read of the env " +
    "var. Works regardless of the batch's status (`compiled`, `paid`, or " +
    "`discarded`, AC-3.3) and never recompiles or re-renders the PDF. " +
    "Always 200 with the resulting `emailStatus`, even on a notify-api " +
    "failure (AC-3.3).",
  security: [{ Bearer: [] }],
  request: { params: BatchIdParamSchema },
  responses: {
    200: {
      content: { "application/json": { schema: BatchEmailActionResponseSchema } },
      description: "Resend attempted — status reflects the outcome",
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
  },
});

batchesRouter.openapi(resendEmailRoute, async (c) => {
  const authz = c.get("authz");
  const { id } = c.req.valid("param");

  if (!hasCapability(authz.permissions, "request", "review")) {
    return c.json(
      forbiddenProblem(c.req.path, "You do not have permission to resend refund batch emails"),
      403,
    );
  }

  const exit = await Effect.runPromiseExit(fetchBatchWithRequests(id));
  if (exit._tag === "Failure") {
    throw new Error("Unexpected database failure fetching refund batch");
  }
  const batch = exit.value;
  if (!batch) {
    return c.json(notFoundProblem(c.req.path, `Refund batch ${id} not found`), 404);
  }

  const outcome = await sendCompilationEmailBestEffort(batch, batch.requests.length);
  return c.json({ emailStatus: outcome.status, emailDeliveryId: outcome.deliveryId }, 200);
});

// ─── GET /batches (history — AC-8.1/8.2, T4) ────────────────────────────────

const batchListRoute = createRoute({
  method: "get",
  path: "/batches",
  tags: ["Batches"],
  summary: "List every compiled batch, every status (history)",
  description:
    "Every RefundBatch, newest first, regardless of status (AC-8.2). " +
    "Capability-gated (`request:review`) but deliberately NOT entity-scoped " +
    "(plan.md § Resolved decisions D1) — any accounting/refund-admin " +
    "reviewer sees every batch. 403 if the caller holds no `request:review` " +
    "grant at all (AC-8.3).",
  security: [{ Bearer: [] }],
  responses: {
    200: {
      content: { "application/json": { schema: BatchSummarySchema.array() } },
      description: "Every batch, newest first",
    },
    401: { description: "Missing or invalid Bearer JWT" },
    403: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "Caller lacks the `request:review` capability",
    },
  },
});

batchesRouter.openapi(batchListRoute, async (c) => {
  const authz = c.get("authz");

  if (!hasCapability(authz.permissions, "request", "review")) {
    return c.json(
      forbiddenProblem(c.req.path, "You do not have permission to view refund batches"),
      403,
    );
  }

  const exit = await Effect.runPromiseExit(listBatchSummaries());
  if (exit._tag === "Failure") {
    throw new Error("Unexpected database failure listing refund batches");
  }

  return c.json(exit.value.map(mapBatchSummary), 200);
});

// ─── GET /batches/:id (detail — AC-2.1, T4) ─────────────────────────────────

const getBatchRoute = createRoute({
  method: "get",
  path: "/batches/{id}",
  tags: ["Batches"],
  summary: "Get one batch's full detail (metadata + per-employee requests + PDF link)",
  description:
    "Regardless of status — `compiled`, `paid`, or `discarded` all resolve " +
    "here (AC-2.1/6.3). Capability-gated (`request:review`), NOT " +
    "entity-scoped (D1). The `pdf` link is minted (and, if the object is " +
    "missing, lazily regenerated — ADR-0019) only AFTER the capability " +
    "check passes.",
  security: [{ Bearer: [] }],
  request: { params: BatchIdParamSchema },
  responses: {
    200: {
      content: { "application/json": { schema: BatchDetailSchema } },
      description: "The batch",
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
  },
});

batchesRouter.openapi(getBatchRoute, async (c) => {
  const authz = c.get("authz");
  const { id } = c.req.valid("param");

  if (!hasCapability(authz.permissions, "request", "review")) {
    return c.json(
      forbiddenProblem(c.req.path, "You do not have permission to view refund batches"),
      403,
    );
  }

  const exit = await Effect.runPromiseExit(fetchBatchWithRequests(id));
  if (exit._tag === "Failure") {
    throw new Error("Unexpected database failure fetching refund batch");
  }
  const batch = exit.value;
  if (!batch) {
    return c.json(notFoundProblem(c.req.path, `Refund batch ${id} not found`), 404);
  }

  const pdf = await resolvePdfLink(batch);
  return c.json(mapBatchDetail(batch, pdf), 200);
});

// ─── GET /batches/:id/pdf-url (download link — AC-3.4, T4) ─────────────────

const pdfUrlRoute = createRoute({
  method: "get",
  path: "/batches/{id}/pdf-url",
  tags: ["Batches"],
  summary: "Mint a short-lived presigned GET for the batch's compiled PDF",
  description:
    "Accounting-only, never employee-reachable (AC-3.4) — minted only AFTER " +
    "the `request:review` capability check passes. Lazily regenerates the " +
    "PDF object if it is missing (ADR-0019 regenerable-cache posture), so a " +
    "discarded/paid batch's PDF still resolves (AC-1.10/6.3).",
  security: [{ Bearer: [] }],
  request: { params: BatchIdParamSchema },
  responses: {
    200: {
      content: { "application/json": { schema: BatchDetailSchema.shape.pdf } },
      description: "A short-lived (~60s) presigned GET",
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
  },
});

batchesRouter.openapi(pdfUrlRoute, async (c) => {
  const authz = c.get("authz");
  const { id } = c.req.valid("param");

  if (!hasCapability(authz.permissions, "request", "review")) {
    return c.json(
      forbiddenProblem(c.req.path, "You do not have permission to view refund batches"),
      403,
    );
  }

  const exit = await Effect.runPromiseExit(fetchBatchWithRequests(id));
  if (exit._tag === "Failure") {
    throw new Error("Unexpected database failure fetching refund batch");
  }
  const batch = exit.value;
  if (!batch) {
    return c.json(notFoundProblem(c.req.path, `Refund batch ${id} not found`), 404);
  }

  const pdf = await resolvePdfLink(batch);
  return c.json(pdf, 200);
});
