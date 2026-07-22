/**
 * Zod schemas for the compiled-batch surfaces (T3, specs/008-refund-monthly-processing,
 * plan.md § API contracts / § Data model).
 *
 * `BatchSubtotalSchema` (currency + approvedCents only, non-nullable) is the
 * REDUCED subtotal shape used for every batch-level aggregate (candidate
 * preview overall/per-employee, and BatchDetail's overall/per-employee
 * totals) — plan.md's worked examples use exactly this shape
 * (`{"currency":"CHF","approvedCents":120000}`), distinct from the full
 * per-request `SubtotalSchema` (requestedCents + nullable approvedCents)
 * requests.schemas.ts already defines, which this module reuses verbatim for
 * BatchDetail's PER-REQUEST rows (`employees[].requests[].subtotals`).
 * `approvedCents` is never null here because every line in an `approved`
 * request has its `approvedTotalCents` finalized by 007's approve handler
 * (AC-7.2) — a batch only ever contains `approved` requests.
 */

import { z } from "zod";
import { OwnerSchema, SubtotalSchema } from "../requests/requests.schemas";

// specs/011-refund-settings, ADR-0029 — widened with "blocked_unconfigured"
// (a send/resend attempt that never reached notify-api because the
// accounting-distribution-email setting was unconfigured, AC-2.2),
// distinguishable from an ordinary "failed" notify-api/Resend outage. ONE
// constant reused across every boundary this status crosses (R2, plan.md §
// Risks) — the `BatchEmailStatusSchema`/`BatchEmailActionResponseSchema`/
// `BatchSummarySchema` enums below, and the two `as` casts in
// batches.service.ts.
export const EMAIL_STATUS_VALUES = ["sent", "failed", "blocked_unconfigured"] as const;
export type EmailStatusValue = (typeof EMAIL_STATUS_VALUES)[number];

export const BATCH_STATUS_VALUES = ["compiled", "paid", "discarded"] as const;
export type BatchStatusValue = (typeof BATCH_STATUS_VALUES)[number];
export const BatchStatusSchema = z.enum(BATCH_STATUS_VALUES);

export const BatchSubtotalSchema = z.object({
  currency: z.string(),
  approvedCents: z.number().int(),
});
export type BatchSubtotal = z.infer<typeof BatchSubtotalSchema>;

// ─── GET /batches/candidates (dry run — writes nothing, US-2) ──────────────

export const CandidatesQuerySchema = z.object({
  cutoff: z
    .string()
    .datetime({ message: "cutoff must be an ISO 8601 datetime" })
    .optional(),
});

export const CandidateEmployeeSchema = z.object({
  owner: OwnerSchema,
  requestIds: z.array(z.string()),
  subtotals: z.array(BatchSubtotalSchema),
});
export type CandidateEmployee = z.infer<typeof CandidateEmployeeSchema>;

export const CandidatePreviewSchema = z.object({
  cutoff: z.string().datetime(),
  requestCount: z.number().int(),
  subtotals: z.array(BatchSubtotalSchema),
  employees: z.array(CandidateEmployeeSchema),
});
export type CandidatePreview = z.infer<typeof CandidatePreviewSchema>;

// ─── POST /batches (compile) ────────────────────────────────────────────────

export const CompileBodySchema = z.object({
  cutoff: z
    .string()
    .datetime({ message: "cutoff must be an ISO 8601 datetime" })
    .optional(),
});
export type CompileBody = z.infer<typeof CompileBodySchema>;

// ─── Shared :id param (GET/POST /batches/:id, .../pdf-url, .../email, .../mark-paid, .../discard, T4) ──

export const BatchIdParamSchema = z.object({
  id: z.string().min(1, "id is required"),
});

// ─── BatchDetail (AC-2.1; also POST /batches' 201 body, T3) ────────────────

export const BatchActorSchema = z.object({
  userId: z.string(),
  email: z.string(),
});

export const BatchTerminalActorSchema = z.object({
  email: z.string(),
});

export const BatchEmailStatusSchema = z.object({
  status: z.enum(EMAIL_STATUS_VALUES).nullable(),
  lastAttemptAt: z.string().datetime().nullable(),
});
export type BatchEmailStatus = z.infer<typeof BatchEmailStatusSchema>;

export const BatchPdfLinkSchema = z.object({
  url: z.string(),
  expiresAt: z.string().datetime(),
});
export type BatchPdfLink = z.infer<typeof BatchPdfLinkSchema>;

/**
 * `null` means the PDF is temporarily unavailable (a render/store failure —
 * OWASP A04 fix round, `pdfLink.ts`'s fail-soft posture) — NEVER treat this
 * as an error case; every route that surfaces `BatchDetail` returns 200 with
 * `pdf: null` rather than failing the whole response.
 */
export const NullableBatchPdfLinkSchema = BatchPdfLinkSchema.nullable();

export const BatchRequestSummarySchema = z.object({
  id: z.string(),
  status: z.string(),
  subtotals: z.array(SubtotalSchema),
});
export type BatchRequestSummary = z.infer<typeof BatchRequestSummarySchema>;

export const BatchEmployeeDetailSchema = z.object({
  owner: OwnerSchema,
  requests: z.array(BatchRequestSummarySchema),
  subtotals: z.array(BatchSubtotalSchema),
});
export type BatchEmployeeDetail = z.infer<typeof BatchEmployeeDetailSchema>;

export const BatchDetailSchema = z.object({
  id: z.string(),
  cutoff: z.string().datetime(),
  status: BatchStatusSchema,
  requestCount: z.number().int(),
  createdBy: BatchActorSchema,
  createdAt: z.string().datetime(),
  subtotals: z.array(BatchSubtotalSchema),
  employees: z.array(BatchEmployeeDetailSchema),
  email: BatchEmailStatusSchema,
  paidAt: z.string().datetime().nullable(),
  paidBy: BatchTerminalActorSchema.nullable(),
  discardedAt: z.string().datetime().nullable(),
  discardedBy: BatchTerminalActorSchema.nullable(),
  pdf: NullableBatchPdfLinkSchema,
});
export type BatchDetail = z.infer<typeof BatchDetailSchema>;

// ─── GET /batches (history — AC-8.1/8.2, T4) ───────────────────────────────

export const BatchSummarySchema = z.object({
  id: z.string(),
  cutoff: z.string().datetime(),
  status: BatchStatusSchema,
  requestCount: z.number().int(),
  subtotals: z.array(BatchSubtotalSchema),
  emailStatus: z.enum(EMAIL_STATUS_VALUES).nullable(),
  createdAt: z.string().datetime(),
});
export type BatchSummary = z.infer<typeof BatchSummarySchema>;

// ─── POST /batches/:id/email (resend — AC-3.3, T5; 422 on unconfigured, T4 specs/011) ──

export const BatchEmailActionResponseSchema = z.object({
  emailStatus: z.enum(EMAIL_STATUS_VALUES),
  emailDeliveryId: z.string().nullable(),
});
export type BatchEmailActionResponse = z.infer<typeof BatchEmailActionResponseSchema>;
