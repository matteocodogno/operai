/**
 * tripSuggestions — the pure client half of motivo autocomplete (T8,
 * specs/014-motivo-autocomplete/tasks.md; plan.md "## Pure client matching
 * contract", D2/D3). No React, no network, no storage: three total functions
 * over plain data, re-run synchronously on every keystroke (plan D2 —
 * matching is deliberately NOT debounced, only the one corpus fetch is).
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ MIRRORED RULE — DO NOT CHANGE ONE SIDE ALONE.                            │
 * │                                                                          │
 * │ `normaliseMotivo` below is a BYTE-IDENTICAL copy of the canonical fold   │
 * │ shipped in `refund-api/src/requests/normaliseMotivo.ts` (T1), and        │
 * │ `tripSuggestions.test.ts` asserts that module's exported                 │
 * │ `MOTIVO_FOLD_VECTORS` table (28 vectors) verbatim. The monorepo is       │
 * │ deliberately mixed pnpm/Bun with no shared workspace package, so a       │
 * │ single shared module is not available — this is the ADR-0025             │
 * │ mirrored-rule-with-shared-test-vectors pattern, exactly as               │
 * │ `computeMileageAmountCents` + its shared vectors already do it.          │
 * │                                                                          │
 * │ Editing the fold OR the vector table in one app without making the       │
 * │ identical edit in the other IS plan.md's risk R2 (silent fold            │
 * │ divergence): the server would group under one key while the client       │
 * │ matched against another, and suggestions would simply stop appearing     │
 * │ for accented or mixed-case queries — with no error anywhere.             │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * Why the client folds only the QUERY: every suggestion arrives from
 * `GET /line-suggestions` already carrying the SERVER's fold of its own
 * motivo, as `normalisedMotivo` (plan.md "## API contracts"). So the
 * candidate side has exactly one implementation and cannot drift; only the
 * typed query passes through the copy below. That asymmetry is half of R2's
 * mitigation — the shared vector table is the other half.
 *
 * The fold is NEVER display text. AC-2.5 requires a suggestion to show its
 * group's most recent line's motivo VERBATIM; `normaliseMotivo`'s output
 * exists only to compare, and is deliberately lossy.
 */

import type { TripSuggestion } from './suggestionsApi'

/**
 * Combining Diacritical Marks (U+0300–U+036F) — and ONLY that block.
 *
 * Do NOT "simplify" this to `\p{Diacritic}` or `\p{Mn}` (plan D3, verified
 * empirically on both runtimes and pinned as vectors in the shared table):
 *
 *  1. `\p{Diacritic}` also matches SPACING characters that are ordinary text —
 *     `^` (U+005E), `` ` `` (U+0060), `´` (U+00B4), `¨` (U+00A8), `·`
 *     (U+00B7). `"Koln · Bonn"` would fold to `"koln  bonn"`: a real character
 *     deleted and a double space left behind.
 *  2. `\p{Diacritic}` and `\p{Mn}` also match marks that are SEMANTIC in
 *     non-Latin scripts. NFD splits the Japanese dakuten off as U+3099, so
 *     stripping it turns `ガ` (ga) into `カ` (ka) — a different word. Hebrew
 *     niqqud, Arabic harakat and Indic nukta break the same way.
 */
const COMBINING_DIACRITICAL_MARKS = /[̀-ͯ]/g

const WHITESPACE_RUN = /\s+/g

/** Any single whitespace character — used to count a query's non-whitespace length. */
const WHITESPACE_CHAR = /\s/

/** AC-1.2/AC-1.3: the query threshold, in non-whitespace characters. */
const MIN_QUERY_CHARS = 2

/** AC-1.5: at most 8 suggestions are ever shown at once. */
export const MAX_SUGGESTIONS = 8

/**
 * Fold a motivo onto its comparison key.
 *
 * Step order is deliberate and load-bearing — see the mirrored module's own
 * header for the full reasoning:
 *
 *  1. `NFD`      — split precomposed letters into base + combining mark.
 *  2. strip      — drop only the Latin/Greek/Cyrillic combining accents.
 *  3. lowercase  — locale-INDEPENDENT `toLowerCase`, never `toLocaleLowerCase`
 *                  (a Turkish locale would fold `I` to `ı` and the two mirrored
 *                  implementations would disagree by the user's device locale).
 *  4. collapse   — whitespace runs to one space. AFTER the strip, so that a
 *                  stripped mark can never leave two spaces adjacent.
 *  5. trim       — after the collapse, so a stripped edge mark cannot leave an
 *                  edge space behind.
 *  6. `NFC`      — re-compose, so the key is canonical and byte-stable against
 *                  the `normalisedMotivo` the server put on the wire.
 *
 * The result is idempotent: `normaliseMotivo(normaliseMotivo(x))` always
 * equals `normaliseMotivo(x)`.
 */
export const normaliseMotivo = (raw: string): string =>
  raw
    .normalize('NFD')
    .replace(COMBINING_DIACRITICAL_MARKS, '')
    .toLowerCase()
    .replace(WHITESPACE_RUN, ' ')
    .trim()
    .normalize('NFC')

/**
 * AC-1.2/AC-1.3: true once the employee has typed at least 2 NON-WHITESPACE
 * characters. `''` and `'   '` are both below the threshold, which is what
 * makes "clearing it entirely, or leaving only whitespace" close the list
 * (AC-1.3) without any dedicated branch.
 *
 * Counted in code points (`[...raw]`), not UTF-16 units, so one astral
 * character is one character.
 */
export const queryQualifies = (raw: string): boolean =>
  [...raw].filter((char) => !WHITESPACE_CHAR.test(char)).length >= MIN_QUERY_CHARS

/**
 * AC-1.4/AC-1.5: order-preserving substring filter of a pre-ranked corpus.
 *
 * The query is folded here; each candidate's `normalisedMotivo` was folded by
 * the SERVER and is used as-is (plan D3). The match is `includes`, so the
 * typed text matches ANYWHERE inside a past motivo, not only at its start
 * (AC-1.4: typing `lug` matches `"Milano → Lugano client visit"`).
 *
 * The corpus arrives already ranked (count desc → lastUsedOn desc → …, plan
 * D8) and this function NEVER re-sorts, only filters and truncates — which is
 * what makes AC-1.7's "a suggestion never shows a lower count than a
 * suggestion listed below it" hold by construction.
 *
 * Note the deliberate non-guard: a query below the 2-character threshold is
 * NOT special-cased here (a folded empty query is a substring of everything,
 * so it would return the corpus head). `queryQualifies` is the gate, and
 * `MotivoSuggestField` ANDs it into the single derived `open` boolean —
 * design.md's spine, which keeps "no list" from ever becoming an error branch.
 */
export const matchTripSuggestions = (
  corpus: readonly TripSuggestion[],
  rawQuery: string,
  limit: number = MAX_SUGGESTIONS,
): TripSuggestion[] => {
  const query = normaliseMotivo(rawQuery)
  const matched: TripSuggestion[] = []
  for (const suggestion of corpus) {
    if (matched.length >= limit) break
    if (suggestion.normalisedMotivo.includes(query)) matched.push(suggestion)
  }
  return matched
}
