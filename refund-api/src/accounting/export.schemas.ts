/**
 * Zod schemas of the accounting export (T18, specs/20261118-refund-accounting-
 * export, plan § API contracts "Export"; AC-6.1, AC-6.5, AC-6.6, AC-6.7, AC-6.9,
 * AC-7.2, G10, G11; extended by T21, specs/20261119-accounting: `missingRates[].reason`
 * (G7), `blockers.accountingUnavailable` (AC-6.6), `ratePendingLineCount`, `viewer`
 * (AC-7.3, D17)).
 *
 * G10: the 409 `accounting_export_blocked` answer of the CSV route carries the
 * SAME summary as the 200 of the summary route, as ONE schema, so the page can
 * switch to its Blocked state from the refusal alone and never needs a second
 * request. {@link ExportBlockedSchema} is {@link ExportSummarySchema} plus the
 * problem members, so they cannot drift apart.
 *
 * G11: an `unclassifiedLines` item names the line by `date` and `type` as well
 * as by `lineId`, so a line that has no receipt number yet can still be found.
 * `type` is the expense type enum value (the page labels it); `employee` is the
 * name, or the email when the account has none.
 */

import { z } from "@hono/zod-openapi";

export const ExportBatchParamSchema = z.object({
  id: z.string().min(1, "id is required"),
});

/** Why Accounting has no rate in effect (G7): not published yet, its source failed, or the entity has no source. */
export const MissingRateReasonSchema = z.enum(["not_published", "fetch_failed", "no_source"]);

export const MissingRateSchema = z.object({
  currency: z.enum(["EUR", "USD", "GBP"]),
  /** `YYYY-MM`, the month of the line's expense date. */
  month: z.string(),
  reason: MissingRateReasonSchema,
});

export const UnclassifiedLineSchema = z.object({
  lineId: z.string(),
  requestId: z.string(),
  /** `YYYY-MM-DD` */
  date: z.string(),
  type: z.string(),
  employee: z.string(),
  receiptNumber: z.string().nullable(),
  /** What the line lacks, `account` before `vatCode` (AC-7.2). */
  missing: z.array(z.enum(["account", "vatCode"])),
});

export const UnnumberedLineSchema = z.object({
  lineId: z.string(),
  requestId: z.string(),
  employee: z.string(),
});

export const ExportBlockersSchema = z.object({
  missingRates: z.array(MissingRateSchema),
  unclassifiedLines: z.array(UnclassifiedLineSchema),
  unnumberedLines: z.array(UnnumberedLineSchema),
  /**
   * Accounting could not be read while lines still wait for their rate (AC-6.6, D14). It is NOT a missing rate:
   * `missingRates` is then empty. The batch can still be compiled, paid and discarded.
   */
  accountingUnavailable: z.boolean(),
});
export type ExportBlockers = z.infer<typeof ExportBlockersSchema>;

export const ExportSummarySchema = z.object({
  batchId: z.string(),
  batchStatus: z.enum(["compiled", "paid"]),
  /** `true` when there is no blocker: the CSV route will produce a file. */
  exportable: z.boolean(),
  /** Rows the file has (or will have once nothing blocks it): the approved, not rejected WellD CH lines of the batch (AC-6.1). */
  rowCount: z.number().int(),
  /** Approved, not rejected WellD Italia lines left out of the file (AC-6.6). */
  excludedLineCount: z.number().int(),
  /** Rows of a foreign currency that hold no rate copy yet: the first export that succeeds copies it (AC-5.6). */
  ratePendingLineCount: z.number().int(),
  blockers: ExportBlockersSchema,
  /** `true` when Accounting reports having asked its official source for a pending rate in this call (G10). */
  fetchAttempted: z.boolean(),
  /** AC-7.3, D17: may the caller open Accounting's exchange rates of WellD CH (a link), or is told to ask a manager. */
  viewer: z.object({ canOpenAccountingRates: z.boolean() }),
});
export type ExportSummary = z.infer<typeof ExportSummarySchema>;

/** The RFC 7807 members every answer of these routes shares; `code` is the discriminator the page branches on. */
export const ExportProblemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  detail: z.string().optional(),
  instance: z.string().optional(),
  code: z.string().optional(),
});

/** 409 `accounting_export_blocked` (AC-6.5, AC-7.2): a Problem that IS the summary (G10). */
export const ExportBlockedSchema = ExportSummarySchema.extend({
  type: z.string(),
  title: z.string(),
  status: z.literal(409),
  detail: z.string(),
  instance: z.string(),
  code: z.literal("accounting_export_blocked"),
});
export type ExportBlocked = z.infer<typeof ExportBlockedSchema>;
