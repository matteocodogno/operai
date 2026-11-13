/**
 * The id rule (specs/029 plan § Entries, "The id rule and a NUL-free note", amended 2026-11-13).
 *
 * `Id` is every id hours-api receives, in a body, a path or a query: 1..64 characters, no NUL
 * (`\u0000`), no comma, no whitespace at either end. The characters count as UTF-16 code units
 * (`id.length`), the unit of every owner's bound, so hours-api's limit is exactly theirs. A string
 * outside the rule is a 400 `invalid_request` naming the field, decided from the string alone, before
 * any `auth`, owner or database call: a NUL would reach Postgres `text` (a 500), and a comma or a blank
 * would reach an owner whose 422 hours-api's clients read as "unavailable" (a 503 for a malformed
 * request). No id any service holds falls outside the rule, so the 400 says nothing about whether a
 * record exists; a WELL-FORMED unknown id keeps the answer of an unknown one (404, 422, an empty list).
 *
 * Lives with the lists, the first routes to need it (T12). Every later route that takes an id —
 * entries (T14-T16), the list and totals filters (T17, T18), the oversight `userId` (T19) — imports it
 * from here, so body, path and query share one rule and one answer.
 */

import { z } from "@hono/zod-openapi";

export const ID_MAX_LENGTH = 64;

export function isWellFormedId(value: string): boolean {
  return (
    value.length >= 1 &&
    value.length <= ID_MAX_LENGTH &&
    !value.includes("\u0000") &&
    !value.includes(",") &&
    value.trim() === value
  );
}

/** Never carries the value: a message names the rule, not what was sent. */
export const ID_RULE_MESSAGE = `must be 1 to ${ID_MAX_LENGTH} characters, with no NUL, no comma and no space at either end`;

export const IdSchema = z
  .string()
  .refine(isWellFormedId, { message: ID_RULE_MESSAGE })
  .openapi({ minLength: 1, maxLength: ID_MAX_LENGTH, description: "An id: 1..64 characters, no NUL, no comma, no space at either end" });
