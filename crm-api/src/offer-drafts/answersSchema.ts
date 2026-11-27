/**
 * The shape and caps of a wizard draft's answers (specs/20261115-crm-offer-wizard § Offer draft, DD-8, DD-31, DD-38,
 * DD-42; ADR 20261115-offer-draft-server-held-generated-from-stored-state): what `PUT …/offer-draft` accepts, and what
 * the read path re-validates before the stored answers reach the engine.
 *
 * Strict everywhere: an unknown member is refused. The caps bound the work the engine does for one draft (fields ≤ 400,
 * text ≤ 20 000 characters, lists ≤ 50 × 2 000, tables ≤ 50 rows, cost lines ≤ 10 extra…). What this schema checks is
 * SHAPE: whether a value is complete, in range, within its field's options (a stale template version) or inside the
 * ±90-day date window is the resolver's business and never refuses an autosave (DD-8, DD-42). Reserved characters and
 * options are the engine's `checkAnswers`, called by the route — never re-implemented here.
 */

import { z } from "@hono/zod-openapi";
import type { WizardAnswers } from "../offers/engine/answers";
import { isCalendarDate } from "../lib/http";

/** The whole body of a save, answers included, is refused above this (413 `draft_too_large`). */
export const MAX_DRAFT_BYTES = 512 * 1024;

const TEXT = 20_000;
const MAX_ENTRIES = 400;

/**
 * Every string of the draft is stored as JSONB, and Postgres refuses U+0000 in it: a NUL that reached the database was a
 * 500 and a raw driver error in the log (QE D2). It is refused here, as a shape error with its path, like the template
 * route's `noNul` — the one place that sees every string, so a new member cannot forget it. A name or an id with a NUL is
 * as wrong as a value with one.
 */
const NO_NUL = "Not text: contains a NUL character";
const noNul = (value: string): boolean => !value.includes("\u0000");
const str = (max: number, min = 0) => z.string().min(min).max(max).refine(noNul, NO_NUL);

const key = str(200, 1).refine((name) => name !== "__proto__", "Not a name");
const text = str(TEXT);
/**
 * A finite number inside the safe-integer range, decimals allowed (a quantity of 1.5, a rate). zod 4's `.safe()` is
 * `.int()` in disguise, so the range is stated outright: same bounds, same OpenAPI `minimum`/`maximum`.
 */
const safeNumber = z.number().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
const scalar = z.union([text, safeNumber]);
const id = str(64, 1);

/** A template id in a request: bounded, and never a NUL (QE D7). */
export const TemplateIdSchema = str(64, 1);

/** A record with a key cap: `__proto__` is refused as a name, and the number of entries is bounded. */
const recordOf = <T extends z.ZodTypeAny>(value: T, max: number) =>
  z.record(key, value).refine((entries) => Object.keys(entries).length <= max, `At most ${max} entries`);

const realDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
  .refine(isCalendarDate, "Not a calendar date");

const costKind = z.enum(["one_off", "yearly", "discount", "option"]);

const CostLineAnswerSchema = z
  .object({
    unitCents: safeNumber.nullable().optional(),
    percentBp: safeNumber.nullable().optional(),
    quantity: safeNumber.nullable().optional(),
    releases: z
      .array(z.object({ description: str(500), unitCents: safeNumber.nullable() }).strict())
      .max(50)
      .optional(),
  })
  .strict();

/**
 * A hand edit's text is bounded by the draft's own 512 KiB, NOT by the 120 / 20 000 characters of AC-5.4: those are the
 * RESOLVER's limits (`heading_too_long`, `section_too_long`), which the dialog enforces and generation reports inside
 * 422 `offer_incomplete` (DD-32). A cap equal to the limit here would make a draft that exceeds it unreadable
 * (409 `draft_invalid`) instead of listed, and the report could never be reached.
 */
const HandEditSchema = z.object({ heading: str(1_000), body: str(100_000) }).strict();

export const AnswersSchema = z
  .object({
    v: z.literal(1),
    client: z
      .object({
        lines: z.array(str(200)).min(1).max(8),
        contactIds: z.array(id).max(5),
        place: str(200),
        date: realDate.nullable(),
      })
      .strict(),
    fields: recordOf(scalar, MAX_ENTRIES),
    prefilled: recordOf(scalar, MAX_ENTRIES),
    blocks: recordOf(z.boolean(), MAX_ENTRIES),
    lists: recordOf(z.array(str(2_000)).max(50), MAX_ENTRIES),
    tables: recordOf(z.array(z.object({ id, cells: recordOf(scalar, 50) }).strict()).max(50), MAX_ENTRIES),
    costs: z
      .object({
        lines: recordOf(CostLineAnswerSchema, 100),
        extra: z
          .array(
            z
              .object({
                id,
                description: str(500),
                kind: costKind,
                unitCents: safeNumber.nullable(),
                percentBp: safeNumber.nullable(),
                quantity: safeNumber,
              })
              .strict(),
          )
          .max(10),
        columns: z.object({ position: z.boolean(), unit: z.boolean() }).strict(),
        showTotals: z.boolean(),
      })
      .strict(),
    handEdits: recordOf(HandEditSchema.extend({ sourceHeading: str(200) }).strict(), 200),
    orphanedEdits: z.array(HandEditSchema).max(200),
    validityDays: z.number().int().min(1).max(365),
    aiAssisted: z.boolean(),
    effortAnnex: z.boolean(),
    attachmentIds: z.array(id).max(5),
    lastStep: z.enum(["client", "scope", "conditions", "costs", "annexes", "template", "preview"]),
  })
  .strict();

/** Where a save may point: the draft's own target (it cannot change here). */
export const PutTargetSchema = z.union([
  z.object({ kind: z.literal("new") }).strict(),
  z.object({ kind: z.enum(["edit", "revision"]), offerId: id }).strict(),
]);

export const PutDraftSchema = z
  .object({
    templateVersion: z.number().int().min(1).max(1_000_000_000),
    target: PutTargetSchema,
    answers: AnswersSchema,
  })
  .strict();

/** `fields.NAME`, `tables.TAB[0].cells.COL`, `fields["a b"]`: the JSON path the engine's `checkAnswers` reports too. */
const IDENTIFIER = /^[A-Za-zÀ-ÿ_][A-Za-z0-9À-ÿ_]*$/;
export function jsonPath(path: readonly PropertyKey[]): string {
  let out = "";
  for (const part of path) {
    if (typeof part === "number") out += `[${part}]`;
    else if (typeof part === "symbol") out += `[${JSON.stringify(String(part))}]`;
    else if (IDENTIFIER.test(part)) out += out === "" ? part : `.${part}`;
    else out += `[${JSON.stringify(part)}]`;
  }
  return out;
}

/** The stored answers, re-validated before they reach the engine (ADR § Decision 4): null when they do not fit. */
export function parseStoredAnswers(value: unknown): WizardAnswers | null {
  const parsed = AnswersSchema.safeParse(value);
  return parsed.success ? (parsed.data as unknown as WizardAnswers) : null;
}
