/**
 * Zod schemas + wire-shape types shared across the request/line/attachment/
 * lifecycle routers (T7-T10, specs/20260716-refund-service).
 *
 * Domain enums mirror `prisma/schema.prisma` verbatim (T5) — kept here as the
 * single source of truth for the HTTP boundary so every router imports the
 * same value/type instead of re-declaring the fourteen expense types etc.
 */

import { z } from "zod";
import { idParam } from "../lib/inputText";

// ─── Domain enums (mirror prisma/schema.prisma) ────────────────────────────

export const ENTITY_VALUES = ["welld_it", "welld_ch"] as const;
export type EntityValue = (typeof ENTITY_VALUES)[number];

export const EXPENSE_TYPE_VALUES = [
  "travel_highway",
  "travel_km",
  "travel_parking",
  "travel_train",
  "travel_other_public_transport",
  "travel_flight",
  "travel_taxi",
  "company_manuals",
  "stationery",
  "representation_meals",
  "representation_gifts",
  "office_material",
  "postal",
  "telephone",
] as const;
export type ExpenseTypeValue = (typeof EXPENSE_TYPE_VALUES)[number];

// specs/20260719-refund-monthly-processing (ADR 20260719-refund-batch-paid-lifecycle-extension) adds the fifth, terminal
// `paid` value — QE fix (verification pass): this list had drifted from the
// Prisma `RefundStatus` enum (which DOES include `paid`, migration
// 20260719220430_add_batches), leaving the OpenAPI-documented contract
// stale (a `paid` request's real `status` field was only reachable via an
// `as RequestDetail["status"]` cast in requests.service.ts, bypassing this
// schema's typing rather than extending it). Functionally harmless — Hono's
// `c.json()` never runtime-validates a response against this schema, only
// `/openapi.json`'s generated docs consumed it — but the docs themselves
// were wrong. See `prisma/schema.prisma`'s `RefundStatus` enum for the
// source of truth this list must always mirror.
export const REFUND_STATUS_VALUES = [
  "draft",
  "submitted",
  "approved",
  "rejected",
  "paid",
] as const;
export type RefundStatusValue = (typeof REFUND_STATUS_VALUES)[number];

// 2026-07-17 amendment (specs/20260716-refund-service): currency is now an
// INDEPENDENTLY-STORED per-line field, decoupled from `entity` — any
// (entity, currency) combination is valid. This reverses the original
// "currency derived from entity, never stored" decision; see plan.md §
// Money handling and prisma/migrations/20260717120000_add_line_currency.
export const CURRENCY_VALUES = ["EUR", "CHF", "USD", "GBP"] as const;
export type CurrencyValue = (typeof CURRENCY_VALUES)[number];

// specs/20260720-mileage-rate: for `travel_km` lines ONLY, currency is no longer
// independently chosen — it is forced server-side from `entity` (a narrow,
// type-scoped reversal of the 2026-07-17 amendment above, which decoupled
// currency from entity for every line suite-wide). Every other expense type
// is unaffected — currency stays an independent, manually-entered field.
// Reused by `rates/service.ts` (an entity's history always declares its
// designated currency, even with zero rate entries) and
// `requests/lines.repo.ts` (server-side currency derivation on write).
export const ENTITY_CURRENCY: Record<EntityValue, CurrencyValue> = {
  welld_ch: "CHF",
  welld_it: "EUR",
};

export const EntitySchema = z.enum(ENTITY_VALUES);
export const ExpenseTypeSchema = z.enum(EXPENSE_TYPE_VALUES);
export const RefundStatusSchema = z.enum(REFUND_STATUS_VALUES);
export const CurrencySchema = z.enum(CURRENCY_VALUES);

// ─── Route param schemas ───────────────────────────────────────────────────

export const RequestIdParamSchema = z.object({
  id: idParam("id"),
});

export const LineIdParamSchema = z.object({
  id: idParam("id"),
  lineId: idParam("lineId"),
});

export const AttachmentIdParamSchema = z.object({
  id: idParam("id"),
  lineId: idParam("lineId"),
  aid: idParam("aid"),
});

// ─── Response shapes ────────────────────────────────────────────────────────

export const AttachmentResponseSchema = z.object({
  id: z.string(),
  fileName: z.string(),
  contentType: z.string(),
  sizeBytes: z.number().int(),
});
export type AttachmentResponse = z.infer<typeof AttachmentResponseSchema>;

// specs/20260720-mileage-rate: the applied-rate breakdown for a travel_km line
// (AC-1.8, AC-2.2, AC-3.x, AC-6.4) — `null` for every non-travel_km line.
// `appliedRate` is the LIVE effective rate while draft (re-resolved on every
// read, Decision 1/ADR 20260714-invitation-lifecycle-derived-expiry-state) or the FROZEN snapshot once the containing
// request has ever been submitted (`snapshotted: true`); `null` when no rate
// is/was in effect (AC-2.2) OR for a legacy pre-feature submitted line
// (R3 — the amount is still shown via `requestedAmountCents`, just without a
// rate breakdown).
export const AppliedRateSchema = z.object({
  ratePerKmMicros: z.number().int(),
  ratePerKm: z.string(), // decimal string, display only
  validFrom: z.string(), // YYYY-MM-DD
  currency: CurrencySchema,
});

export const MileageInfoSchema = z.object({
  km: z.number().int(),
  rateInEffect: z.boolean(), // false => "no rate configured", submit blocked (AC-2.2)
  appliedRate: AppliedRateSchema.nullable(),
  computedAmountCents: z.number().int().nullable(), // = requestedAmountCents when rateInEffect
  snapshotted: z.boolean(), // true once ever-submitted (frozen); false while draft (live)
});
export type MileageInfo = z.infer<typeof MileageInfoSchema>;

// specs/20260716-refund-service amendment (2026-11-10) — a reviewer refused THIS line (with a
// mandatory reason) instead of the whole request. `null` for a line that was
// not rejected. A rejected line's `approvedTotalCents` is 0.
export const LineRejectionSchema = z.object({
  reason: z.string(),
  rejectedAt: z.string().datetime(),
  rejectedBy: z.object({ email: z.string() }),
});
export type LineRejection = z.infer<typeof LineRejectionSchema>;

export const RefundLineResponseSchema = z.object({
  id: z.string(),
  date: z.string(), // YYYY-MM-DD
  type: ExpenseTypeSchema,
  motivo: z.string(),
  entity: EntitySchema,
  currency: CurrencySchema,
  requestedAmountCents: z.number().int(),
  km: z.number().int().nullable(),
  // A mileage line's trip is there and back (informative: `km` is the whole distance). Always false for other types.
  roundTrip: z.boolean(),
  // A mileage trip's start and end; null for any other type and for a mileage line recorded before they existed.
  fromAddress: z.string().nullable(),
  toAddress: z.string().nullable(),
  approvedTotalCents: z.number().int().nullable(),
  rejection: LineRejectionSchema.nullable(),
  attachments: z.array(AttachmentResponseSchema),
  mileage: MileageInfoSchema.nullable(),
  // specs/20261118-refund-accounting-export (T15, AC-4.9): the line's receipt number, `null` until the request
  // is approved and for a rejected line. The ONLY accounting field this response carries: no account, VAT code or
  // CHF amount is ever added here (AC-3.10), they live behind `GET /review/requests/{id}/accounting`.
  receiptNumber: z.string().nullable(),
});
export type RefundLineResponse = z.infer<typeof RefundLineResponseSchema>;

// 2026-07-17 amendment: grouped PURELY by the stored `currency`, never by
// `entity` — a currency group may now span both entities, so `entity` is no
// longer a per-subtotal field (see plan.md § Money handling amendment).
export const SubtotalSchema = z.object({
  currency: CurrencySchema,
  requestedCents: z.number().int(),
  approvedCents: z.number().int().nullable(),
});
export type Subtotal = z.infer<typeof SubtotalSchema>;

export const OwnerSchema = z.object({
  userId: z.string(),
  email: z.string(),
  name: z.string().nullable(),
});

export const DecidedBySchema = z.object({
  email: z.string(),
});

export const RequestListItemSchema = z.object({
  id: z.string(),
  status: RefundStatusSchema,
  updatedAt: z.string().datetime(),
  subtotals: z.array(SubtotalSchema),
});
export type RequestListItem = z.infer<typeof RequestListItemSchema>;

export const RequestDetailSchema = z.object({
  id: z.string(),
  status: RefundStatusSchema,
  owner: OwnerSchema,
  submittedAt: z.string().datetime().nullable(),
  decidedAt: z.string().datetime().nullable(),
  decidedBy: DecidedBySchema.nullable(),
  rejectionMotivation: z.string().nullable(),
  // AC-5.2 (specs/20260719-refund-monthly-processing): derived from the request's
  // claimed RefundBatch (RefundRequest.batchId → RefundBatch.paidAt/
  // paidByEmail) — null unless status === 'paid' (i.e. the batch has itself
  // been marked paid). The SAME GET /requests/:id route both the employee
  // (paidAt only, RequestDetailPage) and accounting (paidAt + paidBy,
  // ReviewDetailPage) sides consume — see refund-ui's requestsApi.ts.
  paidAt: z.string().datetime().nullable(),
  paidBy: z.string().nullable(),
  lines: z.array(RefundLineResponseSchema),
  subtotals: z.array(SubtotalSchema),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type RequestDetail = z.infer<typeof RequestDetailSchema>;

// ─── Problem JSON (RFC 7807) ────────────────────────────────────────────────

export const ProblemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number(),
  detail: z.string(),
  instance: z.string(),
});
