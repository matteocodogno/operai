/**
 * The id rule (specs/029 plan § Entries, "The id rule"; amended 2026-11-13): 1..64 UTF-16 code units,
 * no NUL, no comma, no whitespace at either end.
 *
 * ONE implementation, in `src/lists/idRule.ts` (T12 wrote it first; T13 wrote a second copy here, and T14
 * left one): this module only gives the labels layer its own name for it. Body, path, query and the one
 * id read back from meetings-api therefore cannot drift apart.
 *
 * Every id an entry carries passed the rule when it was written (a 400 otherwise), so a read does not
 * re-check them. The ONE id a read did not see pass is the deal a meeting is linked to, which
 * meetings-api answers as stored (plan § Views): the labels layer asks this before such an id joins a
 * crm-api batch, because crm-api refuses a whole batch with a 422 when one id is outside its bound, and
 * hours-api reads that 422 as `unavailable` — one stored value would make every deal of a page so.
 *
 * Characters are counted as UTF-16 code units (`id.length`), the unit of every owner's bound; a note and a
 * list name count code points instead.
 */

export { ID_MAX_LENGTH, isWellFormedId as satisfiesIdRule } from "../lists/idRule";
