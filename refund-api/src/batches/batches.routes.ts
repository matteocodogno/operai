/**
 * Candidate preview + compile endpoints (T3, specs/008-refund-monthly-processing).
 *
 *   GET  /batches/candidates?cutoff= → 200 CandidatePreview (dry run, US-2)
 *   POST /batches {cutoff?}          → 201 BatchDetail (the atomic-claim core)
 *
 * Capability gate for BOTH: `hasCapability(request, review)` — reused
 * verbatim via `scopeForReviewAction` (review.service.ts) — else 403
 * (AC-1.8). The candidate set (and what compile can claim) is entity-scoped
 * via the SAME predicate the 007 review queue uses (`requestInScope`,
 * ADR-0015); a conditioned grant with no resolved caller entity (`scope ===
 * null`) matches nothing — an empty candidate list for the GET, and the
 * empty-set 422 refusal for the POST (never a 403 — the capability itself
 * IS present).
 *
 * Compile is deliberately NOT gated by the request/response body's size in
 * any interesting way (`{cutoff?: ISO string}` only) — a small `bodyLimit`
 * still applies as defense-in-depth, mirroring decide.routes.ts's posture
 * for small-body mutations.
 *
 * T3 does NOT send the compilation email (T5) or mint anything beyond the
 * compile response's own presigned PDF GET — `notifyEmail` wiring and
 * `GET /batches/:id` / `GET /batches/:id/pdf-url` / `GET /batches` land in
 * T4/T5. `mapBatchDetail` (batches.service.ts) is written to be reused by
 * those once they land.
 */

import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { Effect } from "effect";
import { bodyLimit } from "hono/body-limit";
import { authzMiddleware, type AuthzVariables } from "../auth/authz.middleware";
import { jwtMiddleware } from "../auth/jwt.middleware";
import { ValidationError } from "../lib/errors";
import { env } from "../lib/env";
import { mintPresignedGet, putObject } from "../lib/storage";
import { ProblemSchema } from "../requests/requests.schemas";
import { renderBatchPdf } from "./pdf";
import { compileBatch, fetchCandidateRows } from "./batches.repo";
import {
  filterCandidatesInScope,
  mapBatchDetail,
  mapCandidatePreview,
  scopeForReviewAction,
  toBatchPdfEmployees,
} from "./batches.service";
import {
  BatchDetailSchema,
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

  const pdfUrl = await mintPresignedGet(batch.pdfObjectKey);
  const expiresAt = new Date(Date.now() + 60_000).toISOString();

  return c.json(mapBatchDetail(batch, { url: pdfUrl, expiresAt }), 201);
});
