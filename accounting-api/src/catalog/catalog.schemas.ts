/**
 * Zod schemas of the catalog surface (T8, specs/20261119-accounting, plan § API contracts, AC-1.1 to AC-1.4, AC-1.9,
 * AC-1.11 to AC-1.13; T9: the VAT codes, AC-1.5 to AC-1.8, AC-1.10).
 *
 * Input shapes check only that a field is a string: WHAT the string may be (digits, lengths) is `limits.ts`, because a
 * refused value is answered as `fields[{ field, reason }]` and a zod message cannot carry the reason word. A field that
 * is missing (or null) reads as `empty`, one that is not a string as `format`: the `error` callbacks below return exactly those
 * words, and the router's `defaultHook` turns them into `fields`.
 *
 * The output is the minimal projection of D18: no id, no who-added, no history. It is the same one the reader gets
 * on `/system/v1`, so a consumer and the app cannot see different things.
 */

import { z } from "zod";
import { ENTITIES } from "../entities";

/** A field of a body: `empty` when it is missing or null, `format` when it is not a string. The words `fields[].reason` carries. */
const bodyString = (description: string) =>
  z.string({ error: (issue) => (issue.input === undefined || issue.input === null ? "empty" : "format") }).describe(description);

// ─── Input ───────────────────────────────────────────────────────────────────

export const EntityParamSchema = z.enum(ENTITIES).describe("The legal entity: `welld_ch` or `welld_it`");

export const EntityParamsSchema = z.object({ entity: EntityParamSchema });

export const AddLedgerAccountBodySchema = z.object({
  number: bodyString("Digits separated by single dots, 1 to 20 characters, for example `5905` or `2620.1`"),
  name: bodyString("1 to 120 characters"),
});

export const AddVatCodeBodySchema = z.object({
  code: bodyString("1 to 16 capital letters, digits, `_` or `-`; lower case is converted to capital letters"),
  label: bodyString("1 to 80 characters"),
  ratePercent: bodyString("The rate in percent with a dot and at most two decimals, 0 to 100, for example `8.1`"),
});

export const LedgerAccountParamsSchema = EntityParamsSchema.extend({
  number: z.string().describe("The account number, as listed"),
});

// ─── Output ──────────────────────────────────────────────────────────────────

export const LedgerAccountItemSchema = z.object({
  number: z.string(),
  name: z.string(),
  active: z.boolean(),
});
export type LedgerAccountItem = z.infer<typeof LedgerAccountItemSchema>;

export const LedgerAccountListSchema = z.object({
  entity: EntityParamSchema,
  items: z.array(LedgerAccountItemSchema),
});

export const VatCodeParamsSchema = EntityParamsSchema.extend({
  code: z.string().describe("The VAT code; lower case is converted to capital letters before the lookup"),
});

export const VatCodeItemSchema = z.object({
  code: z.string(),
  label: z.string(),
  ratePercent: z.string().describe("The rate as displayed, for example `8.1`"),
  rateBasisPoints: z.number().int().describe("The same rate in basis points, for example `810`"),
  active: z.boolean(),
});
export type VatCodeItem = z.infer<typeof VatCodeItemSchema>;

export const VatCodeListSchema = z.object({
  entity: EntityParamSchema,
  items: z.array(VatCodeItemSchema),
});

/**
 * RFC 7807 problem with the stable `code` this surface adds, and the top-level extension members of its 409 and 422
 * answers (`number`, `reactivate`, `fields`).
 */
export const CatalogProblemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number(),
  detail: z.string(),
  instance: z.string(),
  code: z.string().optional(),
  number: z.string().optional(),
  vatCode: z.string().optional(),
  reactivate: z.boolean().optional(),
  fields: z.array(z.object({ field: z.string(), reason: z.string() })).optional(),
});
