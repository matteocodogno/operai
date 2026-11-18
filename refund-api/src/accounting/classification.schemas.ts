/**
 * Zod schemas of the line-classification surface (T13, specs/20261118-refund-
 * accounting-export, plan § API contracts "Accounting (classification)"; AC-1.3,
 * AC-1.6, AC-2.7, AC-3.1, AC-3.2, AC-3.8, AC-3.9, AC-3.10, AC-4.6).
 *
 * The line object is the ONE shape of an accounting line: the view returns an
 * array of it and the classification PUT (T14) returns a single one. Amounts are
 * integer cents, rates both as `rateMicros` and as a display string, and none of
 * it is ever computed by the browser.
 */

import { z } from "@hono/zod-openapi";

const CURRENCIES = ["CHF", "EUR", "USD", "GBP"] as const;
const ENTITIES = ["welld_it", "welld_ch"] as const;

export const AccountRefSchema = z.object({
  id: z.string(),
  number: z.string(),
  name: z.string(),
  /** `false` for a stored value whose entry was deactivated since (AC-1.3, AC-1.6). */
  active: z.boolean(),
});

export const VatCodeRefSchema = z.object({
  id: z.string(),
  code: z.string(),
  label: z.string(),
  ratePercent: z.string(),
  active: z.boolean(),
});

export const LineClassificationSchema = z.object({
  account: AccountRefSchema.nullable(),
  accountIsDefault: z.boolean(),
  vatCode: VatCodeRefSchema.nullable(),
  vatCodeIsDefault: z.boolean(),
});

export const LineChfSchema = z.object({
  /** CHF cents: the line's own amount for CHF, converted at the rate in effect otherwise, `null` without a rate. */
  amountCents: z.number().int().nullable(),
  rateMicros: z.number().int().nullable(),
  /** `"0.9246"` */
  rate: z.string().nullable(),
  /** The month of the line's date, `"2026-03"`, set for a foreign-currency line of WellD CH. */
  rateMonth: z.string().nullable(),
  rateMissing: z.boolean(),
});

export const AccountingLineSchema = z.object({
  lineId: z.string(),
  entity: z.enum(ENTITIES),
  date: z.string(),
  type: z.string(),
  currency: z.enum(CURRENCIES),
  /** `approvedTotalCents ?? requestedAmountCents`: provisional before approval (D11). */
  amountCents: z.number().int(),
  receiptNumber: z.string().nullable(),
  employee: z.object({ name: z.string().nullable(), email: z.string() }),
  rejected: z.boolean(),
  /** `null` for a WellD Italia line (AC-3.9), a rejected line, and a request that is not classifiable (draft, rejected). */
  classification: LineClassificationSchema.nullable(),
  chf: LineChfSchema,
  /** `null` when the CHF amount is unknown or there is no VAT code (AC-3.8): unknown is never 0. */
  vatAmountCents: z.number().int().nullable(),
});
export type AccountingLine = z.infer<typeof AccountingLineSchema>;

export const CLASSIFICATION_STATES = ["review", "post_approval", "locked", "none"] as const;
export type ClassificationState = (typeof CLASSIFICATION_STATES)[number];

export const RequestAccountingSchema = z.object({
  requestId: z.string(),
  status: z.enum(["draft", "submitted", "approved", "rejected", "paid"]),
  batch: z.object({ id: z.string(), status: z.string() }).nullable(),
  /**
   * `review`: submitted, `request:set-approved-total` may change a line. `post_approval`: approved, not paid,
   * `request:reclassify` may. `locked`: paid. `none`: draft or rejected, nothing to classify.
   */
  classificationState: z.enum(CLASSIFICATION_STATES),
  lines: z.array(AccountingLineSchema),
});
export type RequestAccounting = z.infer<typeof RequestAccountingSchema>;

export const AccountingOptionsSchema = z.object({
  ledgerAccounts: z.array(z.object({ id: z.string(), number: z.string(), name: z.string() })),
  vatCodes: z.array(z.object({ id: z.string(), code: z.string(), label: z.string(), ratePercent: z.string() })),
});
export type AccountingOptions = z.infer<typeof AccountingOptionsSchema>;

/** RFC 7807 problem with the stable `code` member of this surface's 409 and 422 answers. */
export const ClassificationProblemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number(),
  detail: z.string(),
  instance: z.string(),
  code: z.string().optional(),
});

// ─── PUT …/lines/{lineId}/classification ─────────────────────────────────────

const IdSchema = z.string().min(1).max(64);

/**
 * At least one of the two ids, and ids ONLY: there is no `null` and so no "back to the default" (G8). A line
 * that follows a default keeps following it until accounting picks a value, and a picked value stays picked.
 * Unknown keys are refused rather than ignored, so a typo cannot read as success.
 */
export const ClassifyBodySchema = z
  .object({ ledgerAccountId: IdSchema.optional(), vatCodeId: IdSchema.optional() })
  .strict()
  .refine((body) => body.ledgerAccountId !== undefined || body.vatCodeId !== undefined, {
    message: "give ledgerAccountId, vatCodeId, or both",
  });
export type ClassifyBody = z.infer<typeof ClassifyBodySchema>;
