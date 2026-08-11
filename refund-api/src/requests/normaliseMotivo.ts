/**
 * The canonical motivo fold (T1, specs/014-motivo-autocomplete, plan D3).
 *
 * Pure, DB-free, I/O-free. Collapses the cosmetic variations an employee
 * introduces when re-typing the same trip — casing, accents, stray whitespace —
 * onto ONE key, so `"Milano  →  LUGANO "`, `"milano → lugano"` and
 * `"Milano → Lugàno"` all group into a single suggestion (AC-2.1), and so a
 * typed query matches accent- and case-insensitively anywhere inside a past
 * motivo (AC-1.4).
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ MIRRORED RULE — DO NOT CHANGE ONE SIDE ALONE.                            │
 * │                                                                          │
 * │ `refund-ui/src/lib/tripSuggestions.ts` implements a BYTE-IDENTICAL copy  │
 * │ of `normaliseMotivo` below, and its test suite asserts the SAME          │
 * │ `MOTIVO_FOLD_VECTORS` table exported from this file. The monorepo is     │
 * │ deliberately mixed pnpm/Bun with no shared workspace package, so a       │
 * │ single shared module is not available — this is the ADR-0025             │
 * │ mirrored-rule-with-shared-test-vectors pattern, exactly as              │
 * │ `computeMileageAmountCents` + `mileage-vectors.json` already do it.      │
 * │                                                                          │
 * │ Editing the fold OR the vector table in one app without making the       │
 * │ identical edit in the other IS the plan's risk R2 (silent fold           │
 * │ divergence): the server would group under one key while the client       │
 * │ matched against another, and suggestions would simply stop appearing     │
 * │ for accented or mixed-case queries — with no error anywhere. The vector  │
 * │ table below is therefore a PUBLIC CONTRACT ARTIFACT, not a test fixture. │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * The fold is NEVER display text. AC-2.5 requires a suggestion to show the
 * group's most recent line's motivo VERBATIM; this function's output exists
 * only to key/compare groups and is deliberately lossy.
 *
 * ## Why the accent strip is `[̀-ͯ]` and not `\p{Diacritic}`
 *
 * plan D3 says "strip `\p{Diacritic}`". Taken literally that is wrong twice,
 * both verified empirically against this Bun/V8 runtime:
 *
 *  1. `\p{Diacritic}` also matches SPACING (non-combining) characters that are
 *     ordinary text, not accents: `^` (U+005E), `` ` `` (U+0060), `´` (U+00B4),
 *     `¨` (U+00A8), `·` (U+00B7). Stripping them DELETES real characters and
 *     leaves a hole — `"Koln · Bonn"` folds to `"koln  bonn"` with a double
 *     space, so it would no longer equal `"Koln Bonn"`. (This is also why the
 *     whitespace collapse below runs AFTER the strip, not before it as D3's
 *     step order implies — see the ordering note on the steps.)
 *  2. `\p{Diacritic}` (and `\p{Mn}`) also match marks that are SEMANTIC in
 *     non-Latin scripts. Japanese dakuten is the sharpest case: NFD turns
 *     `ガ` into `カ` + U+3099, and stripping that combining mark yields `カ` —
 *     "ga" silently becomes "ka", a different word. Hebrew niqqud, Arabic
 *     harakat and Indic nukta/virama break the same way.
 *
 * `[̀-ͯ]` is the Combining Diacritical Marks block — precisely the
 * marks that NFD produces when decomposing Latin, Greek and Cyrillic
 * precomposed letters. It strips every accent an Italian or Swiss employee can
 * plausibly type (à è é ì ò ù, ä ö ü, ç, ñ, å, ș ț) while leaving every other
 * script's meaning intact. Both properties are pinned as vectors below.
 *
 * ## Known, deliberate limitations (each pinned as a vector)
 *
 *  - Letters with no canonical decomposition are NOT folded to their base:
 *    `ß`, `ø`, `ł`, `đ`, `ħ`, `ı`. So `"Straße"` and `"Strasse"` are different
 *    trips, as are Turkish dotless `ı` and `i`. Folding those would require
 *    full Unicode case folding plus a transliteration table — far past what
 *    AC-1.4 asks for, and each extra rule is another way the two mirrored
 *    implementations can drift.
 *  - `\s` does not match U+200B ZERO WIDTH SPACE, so a zero-width space
 *    survives the collapse. It matches U+00A0 NBSP, U+202F, U+3000 and the BOM,
 *    which is what actually matters (pasting a motivo out of Word/Outlook).
 */

/** One canonical fold vector: `input` must fold to exactly `expected`. */
export type MotivoFoldVector = {
  /** Why this vector exists — what would break if the fold stopped honouring it. */
  readonly description: string;
  readonly input: string;
  readonly expected: string;
};

/**
 * THE canonical vector table. `refund-ui/src/lib/tripSuggestions.test.ts`
 * asserts this exact table against its mirrored fold (plan risk R2).
 *
 * Vectors sharing an `expected` value are an equivalence class: every input in
 * the class MUST collapse onto the one suggestion (AC-2.1).
 */
export const MOTIVO_FOLD_VECTORS: readonly MotivoFoldVector[] = [
  // ── AC-2.1 / AC-1.4: the headline equivalence class from plan D3. ──────────
  // Every input folding to "milano → lugano" groups as exactly ONE trip.
  {
    description: "plan D3 headline: surrounding + internal whitespace and casing",
    input: "Milano  →  LUGANO ",
    expected: "milano → lugano",
  },
  {
    description: "plan D3 headline: already folded — the fold is idempotent",
    input: "milano → lugano",
    expected: "milano → lugano",
  },
  {
    description: "plan D3 headline: accent (à) plus casing",
    input: "Milano → Lugàno",
    expected: "milano → lugano",
  },
  {
    description:
      "same trip pasted out of Word: NBSP (U+00A0) is whitespace to \\s and collapses to a plain space",
    input: "Milano\u00A0→\u00A0LUGANO",
    expected: "milano → lugano",
  },

  // ── Empty and whitespace-only input ───────────────────────────────────────
  {
    description: "empty string folds to empty string, never throws",
    input: "",
    expected: "",
  },
  {
    description: "whitespace-only input folds to empty — it is not a query and not a trip",
    input: "     ",
    expected: "",
  },
  {
    description: "mixed whitespace-only (tab, newline, CR, NBSP) also folds to empty",
    input: "\t\n\r\u00A0 ",
    expected: "",
  },

  // ── Tabs / newlines / exotic spaces are ordinary whitespace ───────────────
  {
    description: "tabs and newlines collapse to single spaces like any other whitespace run",
    input: "Milano\t→\nLugano",
    expected: "milano → lugano",
  },
  {
    description:
      "ideographic space (U+3000), narrow NBSP (U+202F) and BOM (U+FEFF) all collapse and trim",
    input: "\uFEFFMilano\u3000→\u202FLugano ",
    expected: "milano → lugano",
  },

  // ── Case + accent order-independence (uppercase-accented letters) ─────────
  // Both fold to "aeeiou": stripping accents before lowercasing gives the same
  // answer as lowercasing before stripping, for every Latin letter.
  {
    description: "lowercase Italian accents à è é ì ò ù strip to their base letters",
    input: "àèéìòù",
    expected: "aeeiou",
  },
  {
    description:
      "UPPERCASE accented À È É Ì Ò Ù fold identically — proves case/accent order-independence",
    input: "ÀÈÉÌÒÙ",
    expected: "aeeiou",
  },
  {
    description: "À and È inside real words fold to the plain lowercase base",
    input: "Città di ZÜRICH — CAFFÈ",
    expected: "citta di zurich — caffe",
  },
  {
    description:
      "precomposed è (U+00E8) and decomposed e+U+0300 fold alike — a macOS/NFD paste still groups",
    input: "caffe\u0300",
    expected: "caffe",
  },
  {
    description: "precomposed form of the same word, same fold",
    input: "caffè",
    expected: "caffe",
  },
  {
    description:
      "non-Italian European accents an employee may still type: ä ö ü ç ñ å ș ț all strip",
    input: "Zürich Köln Genève Logroño Malmö Åre Timișoara",
    expected: "zurich koln geneve logrono malmo are timisoara",
  },

  // ── Non-Latin scripts MUST survive the strip (see header, reason 2) ───────
  {
    description:
      "Japanese dakuten is SEMANTIC, not an accent: ガ must stay ガ — \\p{Diacritic}/\\p{Mn} would turn it into カ (ga -> ka)",
    input: "ガギグ",
    expected: "ガギグ",
  },
  {
    description: "Hangul survives the NFD/strip round trip and is re-composed by the final NFC",
    input: "한국 출장",
    expected: "한국 출장",
  },
  {
    description: "Cyrillic is lowercased but otherwise untouched",
    input: "МОСКВА",
    expected: "москва",
  },

  // ── Spacing 'diacritics' are ordinary text, not accents (header reason 1) ──
  {
    description:
      "middle dot U+00B7 is Diacritic=Yes but is a real separator — it must survive, and must not leave a double space",
    input: "Koln · Bonn",
    expected: "koln · bonn",
  },
  {
    description:
      "caret, backtick and spacing acute are Diacritic=Yes but are ordinary characters — all survive",
    input: "a ^ b ` c ´ d",
    expected: "a ^ b ` c ´ d",
  },

  // ── Turkish i: .toLowerCase() is locale-INDEPENDENT, never toLocaleLowerCase ──
  {
    description:
      "plain I lowercases to i — with toLocaleLowerCase('tr') this would be 'ıstanbul' and the two apps could disagree by locale",
    input: "ISTANBUL",
    expected: "istanbul",
  },
  {
    description:
      "İ (U+0130) decomposes to I + U+0307 and folds to the SAME 'istanbul' — dotted capital I groups with plain I",
    input: "İSTANBUL",
    expected: "istanbul",
  },
  {
    description:
      "LIMITATION: dotless ı (U+0131) has no decomposition and does NOT fold to i — 'ıstanbul' stays a separate trip",
    input: "ıstanbul",
    expected: "ıstanbul",
  },

  // ── Letters with no canonical decomposition (documented limitation) ───────
  {
    description:
      "ẞ/ß case-fold to each other, so STRAẞE and Straße group together",
    input: "STRAẞE 12",
    expected: "straße 12",
  },
  {
    description:
      "LIMITATION: ß does not expand to ss — the Swiss spelling 'Strasse' is a DIFFERENT trip from 'Straße'",
    input: "Strasse 12",
    expected: "strasse 12",
  },
  {
    description:
      "LIMITATION: stroked/slashed letters ø ł đ have no canonical decomposition and keep their form",
    input: "Malmø Łódź Đakovo",
    expected: "malmø łodz đakovo",
  },

  // ── Ordering guarantees on the output itself ──────────────────────────────
  {
    description:
      "a long internal whitespace run anywhere collapses to exactly one space, and the result never has leading/trailing space",
    input: "   Roma    →     Milano   →   Torino   ",
    expected: "roma → milano → torino",
  },
  {
    description: "digits, punctuation and symbols pass through untouched apart from casing",
    input: "Trasferta #42 (A/R) 100% — cliente ACME S.p.A.",
    expected: "trasferta #42 (a/r) 100% — cliente acme s.p.a.",
  },
];

/** Combining Diacritical Marks (U+0300–U+036F) — see the header for why not `\p{Diacritic}`. */
const COMBINING_DIACRITICAL_MARKS = /[̀-ͯ]/g;

const WHITESPACE_RUN = /\s+/g;

/**
 * Fold a motivo onto its comparison key.
 *
 * Step order is deliberate and load-bearing:
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
 *  6. `NFC`      — re-compose, so the key is canonical and byte-stable on the
 *                  wire (`normalisedMotivo`) rather than a decomposed form.
 *
 * The result is idempotent: `normaliseMotivo(normaliseMotivo(x))` always equals
 * `normaliseMotivo(x)`.
 */
export function normaliseMotivo(value: string): string {
  return value
    .normalize("NFD")
    .replace(COMBINING_DIACRITICAL_MARKS, "")
    .toLowerCase()
    .replace(WHITESPACE_RUN, " ")
    .trim()
    .normalize("NFC");
}
