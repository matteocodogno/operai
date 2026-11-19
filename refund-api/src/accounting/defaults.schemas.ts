/**
 * Zod schemas for the default-classification surface (T7, specs/20261118-refund-accounting-export, plan § API contracts
 * "Defaults"; reworked by T18, specs/20261119-accounting: natural keys, copies, Accounting states; AC-4.4, AC-4.5,
 * AC-4.7, AC-6.9, AC-6.10; and by T61 for the 2026-11-19 sign-off, 20261118 SO-16: default ACCOUNTS only, there is no VAT
 * default and no foreign-currency designation).
 */

import { z } from "zod";
import { EXPENSE_TYPE_VALUES } from "../requests/requests.schemas";

export { EXPENSE_TYPE_VALUES };

/** The state of an entry in Accounting, in the one vocabulary Refund shows everywhere (design UX-18). */
export const ReferenceStateSchema = z.enum(["active", "deactivated", "not_found", "unverified"]);

/**
 * An account number, or `null` for "no default". The key must be present: leaving it out is not the same as clearing it.
 * Accounting's natural keys are short (20 characters); a longer value cannot exist there, so the cap only bounds what is
 * looked up.
 */
const nullableKey = z.string().trim().min(1).max(32).nullable();

/**
 * Unknown keys are refused, so the old `ledgerAccountId` / `vatCodeId` body cannot read as a successful "clear", and a body
 * that still carries `vatCode` is a 422 rather than a silently ignored field (20261118 SO-16).
 */
export const PutExpenseTypeDefaultBodySchema = z.strictObject({
  accountNumber: nullableKey,
});

export const ExpenseTypeParamSchema = z.object({ type: z.string().min(1) });

const AccountSchema = z.object({ number: z.string(), name: z.string(), state: ReferenceStateSchema });

/** The history shows the entry as it was copied, so it reads the same whatever happens in Accounting (AC-4.7): no state. */
const HistoryAccountSchema = z.object({ number: z.string(), name: z.string() });

export const TypeDefaultRowSchema = z.object({
  type: z.enum(EXPENSE_TYPE_VALUES),
  account: AccountSchema.nullable(),
  updatedAt: z.string().datetime().nullable(),
  updatedByEmail: z.string().nullable(),
  /** Oldest first. */
  history: z.array(
    z.object({
      account: HistoryAccountSchema.nullable(),
      at: z.string().datetime(),
      byEmail: z.string(),
    }),
  ),
});

export const DefaultsResponseSchema = z.object({
  entity: z.literal("welld_ch"),
  /** `unavailable`: Accounting could not be read; every state is `unverified` and the values are as recorded (AC-6.9). */
  accounting: z.enum(["available", "unavailable"]),
  /** Always the fourteen expense types, in enum order (AC-2.2 of 20261118). */
  types: z.array(TypeDefaultRowSchema),
});

export type DefaultsResponse = z.infer<typeof DefaultsResponseSchema>;
export type TypeDefaultRow = z.infer<typeof TypeDefaultRowSchema>;

export const DefaultsProblemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number(),
  detail: z.string(),
  instance: z.string(),
  code: z.string().optional(),
});
