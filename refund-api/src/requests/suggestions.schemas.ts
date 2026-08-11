/**
 * Zod/OpenAPI schemas for `GET /line-suggestions` (T2, specs/014-motivo-autocomplete,
 * plan.md § API contracts).
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ THE QUERY SCHEMA IS THE FEATURE'S ACCESS-CONTROL SURFACE (AC-4.3).       │
 * │                                                                          │
 * │ This endpoint's entire security model is that it has NO caller-           │
 * │ controlled selector. The owner scope comes from the verified JWT `sub`    │
 * │ and from nothing else (suggestions.repo.ts), so there is no `q`, no       │
 * │ `userId`/`ownerUserId`, no `id`, no cursor, and no request body — no      │
 * │ IDOR surface and no injection surface EXISTS to attack. `type` is a       │
 * │ single-member enum, deliberately not the full `ExpenseType` set.          │
 * │                                                                          │
 * │ Adding ANY further parameter here re-opens AC-4.3 and must go back        │
 * │ through the spec, not through this file.                                  │
 * └──────────────────────────────────────────────────────────────────────────┘
 */

import { z } from "zod";
import { EntitySchema } from "./requests.schemas";

// ─── Query ──────────────────────────────────────────────────────────────────

/**
 * The only expense type this feature serves (AC-1.1, spec Non-goals).
 *
 * A single-member enum rather than a bare literal, and rather than reusing
 * `ExpenseTypeSchema`: the parameter EXISTS so that widening to a second type
 * later is a filtering change rather than a redesign (spec Non-goals), but
 * accepting a type whose fill set has not been designed (an amount-bearing
 * type, where a picked suggestion could not fill `requestedAmountCents`)
 * would ship an untested surface today.
 */
export const SUGGESTION_TYPE_VALUES = ["travel_km"] as const;
export type SuggestionTypeValue = (typeof SUGGESTION_TYPE_VALUES)[number];

/**
 * `.strict()` is load-bearing, not stylistic. Zod's default is to SILENTLY
 * STRIP unknown keys; strict REJECTS them (→ the router's `defaultHook` 400).
 * Both are safe — neither can widen the owner scope — but rejecting makes the
 * "no other parameter may exist" property observable from the outside and
 * regression-testable, instead of a property that only holds because nothing
 * downstream happens to read the stripped keys. A future author who adds
 * `?userId=…` support gets a failing test, not a silent success.
 */
export const SuggestionsQuerySchema = z
  .object({
    type: z.enum(SUGGESTION_TYPE_VALUES),
  })
  .strict();
export type SuggestionsQuery = z.infer<typeof SuggestionsQuerySchema>;

// ─── Response ───────────────────────────────────────────────────────────────

/**
 * One trip signature — a DERIVED view over the caller's own past
 * `travel_km` lines, never a stored record (spec Domain language, ADR-0013
 * lineage).
 */
export const TripSuggestionSchema = z.object({
  /**
   * The group's MOST RECENT line's motivo, VERBATIM as the employee typed it
   * — never the fold (AC-2.5). This is the only field a human ever reads as
   * text.
   */
  motivo: z.string(),
  /**
   * The server's fold of `motivo` (`normaliseMotivo`, plan D3). The client
   * folds only the QUERY and substring-matches it against this, so the
   * candidate side of the comparison has exactly ONE implementation and
   * cannot drift (plan Risk R2). Never displayed.
   */
  normalisedMotivo: z.string(),
  km: z.number().int().positive(),
  entity: EntitySchema,
  /** Lines sharing this trip signature within the 24-month window (AC-1.7/2.3). */
  count: z.number().int().positive(),
  /** The group's most recent expense date, ISO date-only `YYYY-MM-DD` (AC-1.7/2.3). */
  lastUsedOn: z.string(),
});
export type TripSuggestionResponse = z.infer<typeof TripSuggestionSchema>;

/**
 * `suggestions` is 0..200 (plan D5's cap) and arrives PRE-RANKED by the
 * server's total order (count desc → lastUsedOn desc → normalisedMotivo asc →
 * km asc → entity asc, plan D8). The client filters order-preservingly, which
 * is what makes AC-1.7's "never shows a lower count than a suggestion listed
 * below it" hold by construction rather than by a client-side re-sort.
 */
export const SuggestionsResponseSchema = z.object({
  type: z.literal("travel_km"),
  suggestions: z.array(TripSuggestionSchema),
});
export type SuggestionsResponse = z.infer<typeof SuggestionsResponseSchema>;
