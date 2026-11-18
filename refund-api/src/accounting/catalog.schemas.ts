/**
 * Zod schemas for the accounting catalog management surface (T6,
 * specs/20261118-refund-accounting-export, plan § API contracts "Catalog:
 * management"; AC-1.1, AC-1.2, AC-1.4, AC-1.5, AC-1.8).
 *
 * Input shapes only check FORM. The normalisation that turns an accepted
 * string into a stored value (upper-casing a VAT code, the exact
 * percent -> basis-points conversion) lives in `catalog.repo.ts`'s pure
 * helpers, so a transform never ends up inside a schema that has to be
 * rendered into the OpenAPI document.
 */

import { z } from "zod";

// ─── Input ───────────────────────────────────────────────────────────────────

/** `5905`, `2620.1`: three to six digits, optionally followed by a dot and one to three digits. */
export const LEDGER_ACCOUNT_NUMBER_RE = /^[0-9]{3,6}(\.[0-9]{1,3})?$/;

/** Upper-cased on input, so the pattern accepts both cases here. */
export const VAT_CODE_RE = /^[A-Za-z0-9_-]{1,16}$/;

/** `8`, `8.1`, `8.10`, `100`: up to three integer digits and two decimals; the range 0..100 is checked after. */
export const VAT_RATE_PERCENT_RE = /^\d{1,3}(\.\d{1,2})?$/;

export const AddLedgerAccountBodySchema = z.object({
  number: z
    .string()
    .trim()
    .regex(LEDGER_ACCOUNT_NUMBER_RE, "number must be 3 to 6 digits, optionally followed by .1 to .999"),
  name: z.string().trim().min(1, "name is required").max(120, "name must be at most 120 characters"),
});
export type AddLedgerAccountBody = z.infer<typeof AddLedgerAccountBodySchema>;

export const AddVatCodeBodySchema = z.object({
  code: z
    .string()
    .trim()
    .regex(VAT_CODE_RE, "code must be 1 to 16 letters, digits, underscores or hyphens"),
  label: z.string().trim().min(1, "label is required").max(80, "label must be at most 80 characters"),
  ratePercent: z
    .string()
    .trim()
    .regex(VAT_RATE_PERCENT_RE, "ratePercent must be a decimal with at most two decimals, for example 8.1")
    .refine((value) => Number(value) <= 100, "ratePercent must be between 0 and 100"),
});
export type AddVatCodeBody = z.infer<typeof AddVatCodeBodySchema>;

export const CatalogIdParamSchema = z.object({
  id: z.string().min(1, "id is required"),
});

// ─── Output ──────────────────────────────────────────────────────────────────

/** One step of an entry's own history: its creation (always `active: true`), then each deactivation or reactivation. Oldest first. */
export const CatalogHistoryEntrySchema = z.object({
  active: z.boolean(),
  at: z.string().datetime(),
  byEmail: z.string(),
});
export type CatalogHistoryEntry = z.infer<typeof CatalogHistoryEntrySchema>;

export const LedgerAccountItemSchema = z.object({
  id: z.string(),
  number: z.string(),
  name: z.string(),
  active: z.boolean(),
  createdAt: z.string().datetime(),
  createdByEmail: z.string(),
  history: z.array(CatalogHistoryEntrySchema),
});
export type LedgerAccountItem = z.infer<typeof LedgerAccountItemSchema>;

export const VatCodeItemSchema = z.object({
  id: z.string(),
  code: z.string(),
  label: z.string(),
  rateBasisPoints: z.number().int(),
  ratePercent: z.string(),
  active: z.boolean(),
  createdAt: z.string().datetime(),
  createdByEmail: z.string(),
  history: z.array(CatalogHistoryEntrySchema),
});
export type VatCodeItem = z.infer<typeof VatCodeItemSchema>;

export const LedgerAccountListSchema = z.object({ items: z.array(LedgerAccountItemSchema) });
export const VatCodeListSchema = z.object({ items: z.array(VatCodeItemSchema) });

/** RFC 7807 problem with the stable `code` member this surface adds to its 409 and 422 answers. */
export const CatalogProblemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number(),
  detail: z.string(),
  instance: z.string(),
  code: z.string().optional(),
});
