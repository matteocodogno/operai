/**
 * Zod schemas for the default-classification surface (T7, specs/20261118-refund-accounting-export, plan § API contracts
 * "Defaults"; reworked by T18, specs/20261119-accounting: natural keys, copies, Accounting states; AC-4.4, AC-4.5,
 * AC-4.7, AC-6.9, AC-6.10).
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

/** The state of an entry in Accounting, in the one vocabulary Refund shows everywhere (design UX-18). */
export const ReferenceStateSchema = z.enum(["active", "deactivated", "not_found", "unverified"]);

/**
 * An account number or VAT code, or `null` for "no default" / "no designation". The key must be present: leaving a half
 * out is not the same as clearing it. Accounting's natural keys are short (20 and 16 characters); a longer value cannot
 * exist there, so the cap only bounds what is looked up.
 */
const nullableKey = z.string().trim().min(1).max(32).nullable();

/** Unknown keys are refused, so the old `ledgerAccountId` / `vatCodeId` body cannot read as a successful "clear". */
export const PutExpenseTypeDefaultBodySchema = z.strictObject({
  accountNumber: nullableKey,
  vatCode: nullableKey,
});

export const PutForeignCurrencyVatCodeBodySchema = z.strictObject({
  vatCode: nullableKey,
});

export const ExpenseTypeParamSchema = z.object({ type: z.string().min(1) });

const AccountSchema = z.object({ number: z.string(), name: z.string(), state: ReferenceStateSchema });
const VatCodeSchema = z.object({
  code: z.string(),
  label: z.string(),
  ratePercent: z.string(),
  state: ReferenceStateSchema,
});

/** The history shows the entry as it was copied, so it reads the same whatever happens in Accounting (AC-4.7): no state. */
const HistoryAccountSchema = z.object({ number: z.string(), name: z.string() });
const HistoryVatCodeSchema = z.object({ code: z.string(), label: z.string(), ratePercent: z.string() });

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
  /** The designation as recorded, with Accounting's present state of the entry; `null` when none (AC-4.5). */
  foreignCurrencyVatCode: VatCodeSchema.nullable(),
  /** `true` only when a code is designated and `active` now: `false` for none, deactivated, not found, unverified (AC-4.5). */
  foreignCurrencyVatCodeUsable: z.boolean(),
  /** Oldest first (AC-4.7). `vatCode: null` is a cleared designation. */
  foreignCurrencyVatCodeHistory: z.array(
    z.object({ vatCode: HistoryVatCodeSchema.nullable(), at: z.string().datetime(), byEmail: z.string() }),
  ),
});

export const DefaultsResponseSchema = ForeignCurrencyVatCodeStateSchema.extend({
  entity: z.literal("welld_ch"),
  /** `unavailable`: Accounting could not be read; every state is `unverified` and the values are as recorded (AC-6.9). */
  accounting: z.enum(["available", "unavailable"]),
  /** Always the twelve expense types, in enum order (AC-2.2 of 20261118). */
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
