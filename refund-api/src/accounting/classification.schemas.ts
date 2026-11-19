/**
 * Zod schemas of the line-classification surface (T13, specs/20261118-refund-accounting-export, plan § API contracts
 * "Accounting (classification)"; reworked by T19, specs/20261119-accounting: copies by natural key, Accounting states,
 * `rateStatus`; AC-4.1, AC-4.3, AC-4.9, AC-5.2, AC-5.6, AC-6.5, AC-7.3).
 *
 * The line object is the ONE shape of an accounting line: the view returns an array of it and the classification PUT
 * returns a single one. Amounts are integer cents, rates both as `rateMicros` and as a display string, and none of it is
 * ever computed by the browser.
 */

import { z } from "@hono/zod-openapi";
import { ReferenceStateSchema } from "./defaults.schemas";

const CURRENCIES = ["CHF", "EUR", "USD", "GBP"] as const;
const ENTITIES = ["welld_it", "welld_ch"] as const;

/** An account as a line shows it: the copy (or the default) and Accounting's present state of the entry (UX-18). */
export const AccountShownSchema = z.object({
  number: z.string(),
  name: z.string(),
  state: ReferenceStateSchema,
});

/** `label` is Accounting's, or the recorded one of a default; `null` when neither is known (a copy on an entry that is gone). */
export const VatCodeShownSchema = z.object({
  code: z.string(),
  label: z.string().nullable(),
  ratePercent: z.string(),
  state: ReferenceStateSchema,
});

/**
 * An unusable default account (deactivated, not found, unverified) is returned WITH its state and `accountIsDefault: true`,
 * never as `null` (G8a): `null` means "no default set". Approval still refuses it server-side (AC-6.3). The VAT code is
 * the line's stored copy or `null` (no VAT code): it has no default, so there is no `vatCodeIsDefault` (20261118 SO-2).
 */
export const LineClassificationSchema = z.object({
  account: AccountShownSchema.nullable(),
  accountIsDefault: z.boolean(),
  vatCode: VatCodeShownSchema.nullable(),
});

export const RATE_STATUSES = ["copied", "in_effect", "missing", "pending", "unavailable", "not_applicable"] as const;

export const LineChfSchema = z.object({
  /** CHF cents: the line's own amount for CHF, converted at the copied or in-effect rate otherwise, `null` without one. */
  amountCents: z.number().int().nullable(),
  rateMicros: z.number().int().nullable(),
  /** `"0.9246"` */
  rate: z.string().nullable(),
  /** The month of the rate, `"2026-03"`: the expense month, set for a foreign-currency line of WellD CH. */
  rateMonth: z.string().nullable(),
  /**
   * `copied`: the line holds its own copy of the rate (AC-5.3). `in_effect`: a line under review, the rate in
   * Accounting now (it is copied at approval). `missing`: Accounting has none for the month yet. `pending`: approved
   * with no rate to copy; copied at the first export (AC-5.6): no CHF and no VAT amount. `unavailable`: Accounting could
   * not be read (AC-6.5). `not_applicable`: a CHF line, or a line with no classification.
   */
  rateStatus: z.enum(RATE_STATUSES),
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
  /**
   * Line-level entity scope (SR-1, S-01): `false` when the caller's `request:review` scope (for a PUT's answer: the scope
   * of the grant that gated the change) is neither global nor the line's own entity. Such a line keeps the fields above,
   * which `GET /requests/{id}` shows a reviewer anyway, and carries NO accounting data: `classification`, `chf` and
   * `vatAmountCents` are `null`.
   */
  inScope: z.boolean(),
  /** `null` for a WellD Italia line (AC-4.9), a rejected line, a line out of scope, and a request that is not classifiable (draft, rejected). */
  classification: LineClassificationSchema.nullable(),
  /** `null` for a line out of scope (SR-1); otherwise an object, with null members when no CHF figure applies. */
  chf: LineChfSchema.nullable(),
  /** `null` when the line has no VAT code (AC-3.8) or its CHF amount is unknown (AC-5.6): unknown is never 0. Also `null` out of scope. */
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
  /**
   * SR-2, S-02: the caller owns this request and holds a grant carrying `self-approval: deny` for the action that would
   * change it (`approve` while submitted, `reclassify` or `approve` once approved). The panel is then read-only, and a
   * PUT answers 403 `self_approval_forbidden`. Always `false` for a paid, draft or rejected request: nothing can change there.
   */
  selfRestricted: z.boolean(),
  /**
   * `unavailable`: Accounting could not be read for this view (AC-6.5). The view is still 200: each line shows what it
   * holds, a default shows Refund's recorded copy with state `unverified`, and no rate is shown. `available` also when
   * the view needed no Accounting at all (no line to classify, a paid request).
   */
  accounting: z.enum(["available", "unavailable"]),
  /** AC-7.3, D17: may the caller open Accounting's exchange rates of WellD CH (link), decided server-side from their permissions. */
  viewer: z.object({ canOpenAccountingRates: z.boolean() }),
  lines: z.array(AccountingLineSchema),
});
export type RequestAccounting = z.infer<typeof RequestAccountingSchema>;

/**
 * The active WellD CH entries of Accounting, by natural key, and nothing else of Accounting: no `active` flag, no history,
 * no who-added, no rates (AC-4.1).
 */
export const AccountingOptionsSchema = z.object({
  ledgerAccounts: z.array(z.object({ number: z.string(), name: z.string() })),
  vatCodes: z.array(z.object({ code: z.string(), label: z.string(), ratePercent: z.string(), rateBasisPoints: z.number().int() })),
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

/** Accounting's natural keys are short (20 and 16 characters, AC-1.2, AC-1.5); the cap only bounds what is looked up. */
const KeySchema = z.string().trim().min(1).max(32);

/**
 * At least one of the two keys. `accountNumber` is a natural key and never null: the account is required and there is no
 * "back to the default" (G8). `vatCode` is a natural key, or `null` to CLEAR the line's VAT code (20261118 SO-3, AC-3.3):
 * the code is optional, so "none" is a value a person can choose. Unknown keys are refused rather than ignored, so a typo,
 * or the old `ledgerAccountId` body, cannot read as success.
 */
export const ClassifyBodySchema = z
  .object({ accountNumber: KeySchema.optional(), vatCode: KeySchema.nullable().optional() })
  .strict()
  .refine((body) => body.accountNumber !== undefined || body.vatCode !== undefined, {
    message: "give accountNumber, vatCode, or both",
  });
export type ClassifyBody = z.infer<typeof ClassifyBodySchema>;
