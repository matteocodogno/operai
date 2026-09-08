/**
 * Zod schemas for POST /system/emails (T3, specs/006-user-invitations,
 * plan.md §API contracts, ADR-0011; extended by T7,
 * specs/008-refund-monthly-processing, ADR-0021 for `refund_batch_compiled`).
 *
 * `template` is a closed enum (EMAIL_TEMPLATES, src/channels/email.channel.ts)
 * — an unrecognised template name is a 400, never silently accepted. `data`
 * is **per-template**: a discriminated union keyed on the sibling `template`
 * field, so each template only accepts its own fixed field set (an
 * `invitation` body can't smuggle `refund_batch_compiled` fields or vice
 * versa). Every `data.*` field is the ONLY variable input a template
 * renders; all are escaped at render time (system/emailTemplates.ts), not
 * here — this file only bounds their shape.
 */

import { z } from "zod";
import { EMAIL_TEMPLATES } from "@/channels/email.channel";

export const SendEmailTemplateSchema = z.enum(EMAIL_TEMPLATES);

export const SendEmailDataSchema = z.object({
  inviteUrl: z.string().min(1, "data.inviteUrl is required").max(2000),
  inviterName: z.string().min(1, "data.inviterName is required").max(200),
  // Accepts both a bare-Z and an offset ISO 8601 datetime (auth may format
  // either way) — see plan.md's `expiresAt: "2026-07-16T10:00:00Z"` example.
  expiresAt: z
    .string()
    .datetime({ offset: true, message: "data.expiresAt must be ISO 8601" }),
});

// specs/008-refund-monthly-processing T7 (plan.md §Email, ADR-0021) —
// `refund_batch_compiled`'s `data` shape. `batchUrl` is an in-app deep link
// (`<REFUND_APP_BASE_URL>/refund/batches/<id>`), never a storage/presigned
// URL (ADR-0021) — validated only as a well-formed URL string here, its
// origin is refund-api's concern, not this channel's.
export const RefundBatchCompiledDataSchema = z.object({
  batchUrl: z
    .string()
    .min(1, "data.batchUrl is required")
    .max(2000)
    .url("data.batchUrl must be a valid URL"),
  batchReference: z.string().min(1, "data.batchReference is required").max(200),
  cutoff: z
    .string()
    .datetime({ offset: true, message: "data.cutoff must be ISO 8601" }),
  generatedAt: z
    .string()
    .datetime({ offset: true, message: "data.generatedAt must be ISO 8601" }),
  requestCount: z
    .number()
    .int("data.requestCount must be an integer")
    .nonnegative("data.requestCount must be >= 0"),
});

// specs/007-refund-service AC-3.6 (email channel extension) — the decision
// emails' `data` shapes. `requestUrl` is an in-app deep link
// (`<REFUND_APP_BASE_URL>/refund/requests/<id>`), the same posture as
// `batchUrl` above: the employee signs in and passes the ordinary ownership
// check before seeing anything, so the mail itself carries no attachment and
// no standalone access.
//
// The two shapes are deliberately NOT unified. `approvedTotals` exists only
// on the approved variant — a rejected request has nothing approved — so
// merging them would make the money field optional and let a "rejected"
// payload carry totals. Splitting keeps each template's field set closed,
// which is this file's whole point.
const ApprovedTotalSchema = z.object({
  currency: z.enum(["EUR", "CHF", "USD", "GBP"]),
  // Integer minor units, never a formatted string (CLAUDE.md money handling,
  // ADR-0025) — rendering to "CHF 2156,00" happens at template render time.
  // Signed: an approved total is never negative today, but bounding it here
  // rather than assuming is cheaper than a corrupted email.
  amountCents: z
    .number()
    .int("data.approvedTotals[].amountCents must be an integer")
    .nonnegative("data.approvedTotals[].amountCents must be >= 0"),
});

const RequestUrlSchema = z
  .string()
  .min(1, "data.requestUrl is required")
  .max(2000)
  .url("data.requestUrl must be a valid URL");

const DecidedAtSchema = z
  .string()
  .datetime({ offset: true, message: "data.decidedAt must be ISO 8601" });

export const RefundDecisionApprovedDataSchema = z.object({
  requestUrl: RequestUrlSchema,
  decidedAt: DecidedAtSchema,
  // One entry per currency on the request (a request's lines may straddle
  // currencies — specs/007's 2026-07-17 amendment). Capped at the four
  // supported currencies so a malformed caller cannot inflate the body.
  approvedTotals: z.array(ApprovedTotalSchema).min(1).max(4),
});

export const RefundDecisionRejectedDataSchema = z.object({
  requestUrl: RequestUrlSchema,
  decidedAt: DecidedAtSchema,
  // Deliberately NO `rejectionMotivation`: the motivation stays in the app,
  // behind sign-in, rather than being copied into an inbox. The email's job
  // is to make the decision impossible to miss and link to the detail.
});

const ToSchema = z.string().email("to must be a valid email address").max(320);

export const SendEmailRequestSchema = z.discriminatedUnion("template", [
  z.object({
    to: ToSchema,
    template: z.literal("invitation"),
    data: SendEmailDataSchema,
  }),
  z.object({
    to: ToSchema,
    template: z.literal("invitation_resend"),
    data: SendEmailDataSchema,
  }),
  z.object({
    to: ToSchema,
    template: z.literal("refund_batch_compiled"),
    data: RefundBatchCompiledDataSchema,
  }),
  z.object({
    to: ToSchema,
    template: z.literal("refund_decision_approved"),
    data: RefundDecisionApprovedDataSchema,
  }),
  z.object({
    to: ToSchema,
    template: z.literal("refund_decision_rejected"),
    data: RefundDecisionRejectedDataSchema,
  }),
]);

export type SendEmailRequest = z.infer<typeof SendEmailRequestSchema>;

export const SendEmailResponseSchema = z.object({
  deliveryId: z.string(),
  status: z.enum(["sent", "failed"]),
  error: z.string().optional(),
});
