/**
 * Zod schemas for the default-classification surface (T7, specs/20261118-
 * refund-accounting-export, plan § API contracts "Defaults"; AC-2.1, AC-2.2,
 * AC-2.4 to AC-2.8).
 */

import { z } from "zod";

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

/** An id, or `null` for "no default" / "no designation". The key must be present: leaving a half out is not the same as clearing it. */
const nullableId = z.string().trim().min(1).max(64).nullable();

export const PutExpenseTypeDefaultBodySchema = z.object({
  ledgerAccountId: nullableId,
  vatCodeId: nullableId,
});

export const PutForeignCurrencyVatCodeBodySchema = z.object({
  vatCodeId: nullableId,
});

export const ExpenseTypeParamSchema = z.object({ type: z.string().min(1) });

const AccountSchema = z.object({ id: z.string(), number: z.string(), name: z.string(), active: z.boolean() });
const VatCodeSchema = z.object({
  id: z.string(),
  code: z.string(),
  label: z.string(),
  ratePercent: z.string(),
  active: z.boolean(),
});

const HistoryAccountSchema = z.object({ id: z.string(), number: z.string(), name: z.string() });
const HistoryVatCodeSchema = z.object({ id: z.string(), code: z.string(), label: z.string(), ratePercent: z.string() });

export const TypeDefaultRowSchema = z.object({
  type: z.enum(EXPENSE_TYPE_VALUES),
  account: AccountSchema.nullable(),
  vatCode: VatCodeSchema.nullable(),
  updatedAt: z.string().datetime().nullable(),
  updatedByEmail: z.string().nullable(),
  /** Oldest first. */
  history: z.array(
    z.object({
      account: HistoryAccountSchema.nullable(),
      vatCode: HistoryVatCodeSchema.nullable(),
      at: z.string().datetime(),
      byEmail: z.string(),
    }),
  ),
});

export const ForeignCurrencyVatCodeStateSchema = z.object({
  /** The designation, even when the code is inactive (AC-2.7); `null` when none. */
  foreignCurrencyVatCode: VatCodeSchema.nullable(),
  /** `false` when none is designated or the designated code is inactive. */
  foreignCurrencyVatCodeUsable: z.boolean(),
  /** Oldest first (AC-2.5). `vatCode: null` is a cleared designation. */
  foreignCurrencyVatCodeHistory: z.array(
    z.object({ vatCode: z.object({ id: z.string(), code: z.string().nullable() }).nullable(), at: z.string().datetime(), byEmail: z.string() }),
  ),
});

export const DefaultsResponseSchema = ForeignCurrencyVatCodeStateSchema.extend({
  entity: z.literal("welld_ch"),
  /** Always the twelve expense types, in enum order (AC-2.2). */
  types: z.array(TypeDefaultRowSchema),
});

export type DefaultsResponse = z.infer<typeof DefaultsResponseSchema>;
export type ForeignCurrencyVatCodeState = z.infer<typeof ForeignCurrencyVatCodeStateSchema>;
export type TypeDefaultRow = z.infer<typeof TypeDefaultRowSchema>;

export const DefaultsProblemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number(),
  detail: z.string(),
  instance: z.string(),
  code: z.string().optional(),
});
