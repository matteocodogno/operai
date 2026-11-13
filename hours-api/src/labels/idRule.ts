/**
 * The id rule (specs/029 plan § Entries, "The id rule and a NUL-free note", amended 2026-11-13): an id
 * hours-api receives or sends to an owner is 1..64 characters with no NUL (`\u0000`), no comma and no
 * whitespace at either end (`id.trim() === id`).
 *
 * Characters are counted as UTF-16 code units (`id.length`), the unit of every owner's bound (zod
 * `.max(64)`, meetings-api's `id.length`), so hours-api's bound is exactly theirs. A note and a list
 * name count code points instead; that is not this file's business.
 *
 * Every id an entry carries passed this rule when it was written (a 400 otherwise), so a read does not
 * re-check them. The ONE id a read did not see pass is the deal a meeting is linked to, which
 * meetings-api answers as stored (plan § Views): the labels layer asks this before such an id joins a
 * crm-api batch, because crm-api refuses a whole batch with a 422 when one id is outside its bound, and
 * hours-api reads that 422 as `unavailable` — one stored value would make every deal of a page so.
 */

export const ID_MAX_LENGTH = 64;

export function satisfiesIdRule(id: string): boolean {
  return id.length >= 1 && id.length <= ID_MAX_LENGTH && !id.includes("\u0000") && !id.includes(",") && id.trim() === id;
}
