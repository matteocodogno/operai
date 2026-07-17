/**
 * Zod schemas + wire-shape types shared across the request/line/attachment/
 * lifecycle routers (T7-T10, specs/007-refund-service).
 *
 * Domain enums mirror `prisma/schema.prisma` verbatim (T5) — kept here as the
 * single source of truth for the HTTP boundary so every router imports the
 * same value/type instead of re-declaring the twelve expense types etc.
 */

import { z } from "zod";

// ─── Domain enums (mirror prisma/schema.prisma) ────────────────────────────

export const ENTITY_VALUES = ["welld_it", "welld_ch"] as const;
export type EntityValue = (typeof ENTITY_VALUES)[number];

export const EXPENSE_TYPE_VALUES = [
  "travel_highway",
  "travel_km",
  "travel_parking",
  "travel_train",
  "travel_other_public_transport",
  "company_manuals",
  "stationery",
  "representation_meals",
  "representation_gifts",
  "office_material",
  "postal",
  "telephone",
] as const;
export type ExpenseTypeValue = (typeof EXPENSE_TYPE_VALUES)[number];

export const REFUND_STATUS_VALUES = [
  "draft",
  "submitted",
  "approved",
  "rejected",
] as const;
export type RefundStatusValue = (typeof REFUND_STATUS_VALUES)[number];

// 2026-07-17 amendment (specs/007-refund-service): currency is now an
// INDEPENDENTLY-STORED per-line field, decoupled from `entity` — any
// (entity, currency) combination is valid. This reverses the original
// "currency derived from entity, never stored" decision; see plan.md §
// Money handling and prisma/migrations/20260717120000_add_line_currency.
export const CURRENCY_VALUES = ["EUR", "CHF", "USD", "GBP"] as const;
export type CurrencyValue = (typeof CURRENCY_VALUES)[number];

export const EntitySchema = z.enum(ENTITY_VALUES);
export const ExpenseTypeSchema = z.enum(EXPENSE_TYPE_VALUES);
export const RefundStatusSchema = z.enum(REFUND_STATUS_VALUES);
export const CurrencySchema = z.enum(CURRENCY_VALUES);

// ─── Route param schemas ───────────────────────────────────────────────────

export const RequestIdParamSchema = z.object({
  id: z.string().min(1, "id is required"),
});

export const LineIdParamSchema = z.object({
  id: z.string().min(1, "id is required"),
  lineId: z.string().min(1, "lineId is required"),
});

export const AttachmentIdParamSchema = z.object({
  id: z.string().min(1, "id is required"),
  lineId: z.string().min(1, "lineId is required"),
  aid: z.string().min(1, "aid is required"),
});

// ─── Response shapes ────────────────────────────────────────────────────────

export const AttachmentResponseSchema = z.object({
  id: z.string(),
  fileName: z.string(),
  contentType: z.string(),
  sizeBytes: z.number().int(),
});
export type AttachmentResponse = z.infer<typeof AttachmentResponseSchema>;

export const RefundLineResponseSchema = z.object({
  id: z.string(),
  date: z.string(), // YYYY-MM-DD
  type: ExpenseTypeSchema,
  motivo: z.string(),
  entity: EntitySchema,
  currency: CurrencySchema,
  requestedAmountCents: z.number().int(),
  km: z.number().int().nullable(),
  approvedTotalCents: z.number().int().nullable(),
  attachments: z.array(AttachmentResponseSchema),
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
