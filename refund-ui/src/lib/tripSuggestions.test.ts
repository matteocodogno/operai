/**
 * Unit tests for src/lib/tripSuggestions.ts (T8, specs/014-motivo-autocomplete/
 * tasks.md; plan.md "## Test strategy" AC-1.4/AC-1.5, risk R2).
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ THE MIRRORED VECTOR TABLE BELOW IS A CONTRACT ARTIFACT, NOT A FIXTURE.   │
 * │                                                                          │
 * │ `MOTIVO_FOLD_VECTORS` is a copy of the table exported by                 │
 * │ `refund-api/src/requests/normaliseMotivo.ts` (T1) — same 28 vectors, in  │
 * │ the same order, with the same `{ description, input, expected }` shape   │
 * │ and byte-identical string VALUES. Only the quote style differs (each     │
 * │ app's own prettier config); nothing inside a string may.                 │
 * │                                                                          │
 * │ Every invisible character is written as an explicit \uXXXX escape        │
 * │ precisely so a copy cannot silently mangle it: NBSP U+00A0, BOM U+FEFF,  │
 * │ ideographic space U+3000, narrow NBSP U+202F, combining grave U+0300.    │
 * │ Keep them as escapes — re-typing one as a literal invisible character is │
 * │ exactly the silent corruption the escapes exist to prevent.              │
 * │                                                                          │
 * │ Asserting it here IS plan.md's mitigation for risk R2 (silent fold       │
 * │ divergence). The two apps are not npm-linked (mixed pnpm/Bun monorepo,   │
 * │ no workspace package), so the table cannot be imported — this is the     │
 * │ ADR-0025 mirrored-rule-with-shared-vectors pattern. If this file and     │
 * │ `refund-api`'s ever disagree, the FOLD is broken, not the test.          │
 * └──────────────────────────────────────────────────────────────────────────┘
 */

import { describe, expect, it } from 'vitest'
import { matchTripSuggestions, normaliseMotivo, queryQualifies } from './tripSuggestions'
import type { TripSuggestion } from './suggestionsApi'

/** One canonical fold vector: `input` must fold to exactly `expected`. */
type MotivoFoldVector = {
  /** Why this vector exists — what would break if the fold stopped honouring it. */
  readonly description: string
  readonly input: string
  readonly expected: string
}

const MOTIVO_FOLD_VECTORS: readonly MotivoFoldVector[] = [
  // ── AC-2.1 / AC-1.4: the headline equivalence class from plan D3. ──────────
  // Every input folding to "milano → lugano" groups as exactly ONE trip.
  {
    description: 'plan D3 headline: surrounding + internal whitespace and casing',
    input: 'Milano  →  LUGANO ',
    expected: 'milano → lugano',
  },
  {
    description: 'plan D3 headline: already folded — the fold is idempotent',
    input: 'milano → lugano',
    expected: 'milano → lugano',
  },
  {
    description: 'plan D3 headline: accent (à) plus casing',
    input: 'Milano → Lugàno',
    expected: 'milano → lugano',
  },
  {
    description: 'same trip pasted out of Word: NBSP (U+00A0) is whitespace to \\s and collapses to a plain space',
    input: 'Milano\u00A0→\u00A0LUGANO',
    expected: 'milano → lugano',
  },

  // ── Empty and whitespace-only input ───────────────────────────────────────
  {
    description: 'empty string folds to empty string, never throws',
    input: '',
    expected: '',
  },
  {
    description: 'whitespace-only input folds to empty — it is not a query and not a trip',
    input: '     ',
    expected: '',
  },
  {
    description: 'mixed whitespace-only (tab, newline, CR, NBSP) also folds to empty',
    input: '\t\n\r\u00A0 ',
    expected: '',
  },

  // ── Tabs / newlines / exotic spaces are ordinary whitespace ───────────────
  {
    description: 'tabs and newlines collapse to single spaces like any other whitespace run',
    input: 'Milano\t→\nLugano',
    expected: 'milano → lugano',
  },
  {
    description: 'ideographic space (U+3000), narrow NBSP (U+202F) and BOM (U+FEFF) all collapse and trim',
    input: '\uFEFFMilano\u3000→\u202FLugano ',
    expected: 'milano → lugano',
  },

  // ── Case + accent order-independence (uppercase-accented letters) ─────────
  // Both fold to "aeeiou": stripping accents before lowercasing gives the same
  // answer as lowercasing before stripping, for every Latin letter.
  {
    description: 'lowercase Italian accents à è é ì ò ù strip to their base letters',
    input: 'àèéìòù',
    expected: 'aeeiou',
  },
  {
    description: 'UPPERCASE accented À È É Ì Ò Ù fold identically — proves case/accent order-independence',
    input: 'ÀÈÉÌÒÙ',
    expected: 'aeeiou',
  },
  {
    description: 'À and È inside real words fold to the plain lowercase base',
    input: 'Città di ZÜRICH — CAFFÈ',
    expected: 'citta di zurich — caffe',
  },
  {
    description: 'precomposed è (U+00E8) and decomposed e+U+0300 fold alike — a macOS/NFD paste still groups',
    input: 'caffe\u0300',
    expected: 'caffe',
  },
  {
    description: 'precomposed form of the same word, same fold',
    input: 'caffè',
    expected: 'caffe',
  },
  {
    description: 'non-Italian European accents an employee may still type: ä ö ü ç ñ å ș ț all strip',
    input: 'Zürich Köln Genève Logroño Malmö Åre Timișoara',
    expected: 'zurich koln geneve logrono malmo are timisoara',
  },

  // ── Non-Latin scripts MUST survive the strip (see header, reason 2) ───────
  {
    description:
      'Japanese dakuten is SEMANTIC, not an accent: ガ must stay ガ — \\p{Diacritic}/\\p{Mn} would turn it into カ (ga -> ka)',
    input: 'ガギグ',
    expected: 'ガギグ',
  },
  {
    description: 'Hangul survives the NFD/strip round trip and is re-composed by the final NFC',
    input: '한국 출장',
    expected: '한국 출장',
  },
  {
    description: 'Cyrillic is lowercased but otherwise untouched',
    input: 'МОСКВА',
    expected: 'москва',
  },

  // ── Spacing 'diacritics' are ordinary text, not accents (header reason 1) ──
  {
    description:
      'middle dot U+00B7 is Diacritic=Yes but is a real separator — it must survive, and must not leave a double space',
    input: 'Koln · Bonn',
    expected: 'koln · bonn',
  },
  {
    description: 'caret, backtick and spacing acute are Diacritic=Yes but are ordinary characters — all survive',
    input: 'a ^ b ` c ´ d',
    expected: 'a ^ b ` c ´ d',
  },

  // ── Turkish i: .toLowerCase() is locale-INDEPENDENT, never toLocaleLowerCase ──
  {
    description:
      "plain I lowercases to i — with toLocaleLowerCase('tr') this would be 'ıstanbul' and the two apps could disagree by locale",
    input: 'ISTANBUL',
    expected: 'istanbul',
  },
  {
    description:
      "İ (U+0130) decomposes to I + U+0307 and folds to the SAME 'istanbul' — dotted capital I groups with plain I",
    input: 'İSTANBUL',
    expected: 'istanbul',
  },
  {
    description:
      "LIMITATION: dotless ı (U+0131) has no decomposition and does NOT fold to i — 'ıstanbul' stays a separate trip",
    input: 'ıstanbul',
    expected: 'ıstanbul',
  },

  // ── Letters with no canonical decomposition (documented limitation) ───────
  {
    description: 'ẞ/ß case-fold to each other, so STRAẞE and Straße group together',
    input: 'STRAẞE 12',
    expected: 'straße 12',
  },
  {
    description: "LIMITATION: ß does not expand to ss — the Swiss spelling 'Strasse' is a DIFFERENT trip from 'Straße'",
    input: 'Strasse 12',
    expected: 'strasse 12',
  },
  {
    description: 'LIMITATION: stroked/slashed letters ø ł đ have no canonical decomposition and keep their form',
    input: 'Malmø Łódź Đakovo',
    expected: 'malmø łodz đakovo',
  },

  // ── Ordering guarantees on the output itself ──────────────────────────────
  {
    description:
      'a long internal whitespace run anywhere collapses to exactly one space, and the result never has leading/trailing space',
    input: '   Roma    →     Milano   →   Torino   ',
    expected: 'roma → milano → torino',
  },
  {
    description: 'digits, punctuation and symbols pass through untouched apart from casing',
    input: 'Trasferta #42 (A/R) 100% — cliente ACME S.p.A.',
    expected: 'trasferta #42 (a/r) 100% — cliente acme s.p.a.',
  },
]

// ── The mirrored table, asserted ──────────────────────────────────────────

describe('normaliseMotivo — the canonical MOTIVO_FOLD_VECTORS table (risk R2)', () => {
  it('carries exactly the 28 vectors refund-api exports — a short copy is a broken mirror', () => {
    expect(MOTIVO_FOLD_VECTORS).toHaveLength(28)
  })

  it.each(MOTIVO_FOLD_VECTORS)('$description', ({ input, expected }) => {
    expect(normaliseMotivo(input)).toBe(expected)
  })

  it('is idempotent for every vector — folding a folded key changes nothing', () => {
    for (const { input } of MOTIVO_FOLD_VECTORS) {
      const once = normaliseMotivo(input)
      expect(normaliseMotivo(once)).toBe(once)
    }
  })

  it('collapses every "milano → lugano" vector onto one identical key (AC-2.1 equivalence class)', () => {
    const classMembers = MOTIVO_FOLD_VECTORS.filter((vector) => vector.expected === 'milano → lugano')
    // The table is expected to carry several spellings of the one headline trip.
    expect(classMembers.length).toBeGreaterThanOrEqual(4)
    const folded = new Set(classMembers.map((vector) => normaliseMotivo(vector.input)))
    expect([...folded]).toEqual(['milano → lugano'])
  })
})

// ── queryQualifies (AC-1.2 / AC-1.3) ──────────────────────────────────────

describe('queryQualifies — the 2-non-whitespace-character threshold', () => {
  it.each([
    ['', false],
    [' ', false],
    ['   ', false],
    ['\t\n', false],
    ['l', false],
    [' l ', false],
    ['lu', true],
    [' l u ', true],
    ['  lug  ', true],
    ['à è', true],
  ] as const)('queryQualifies(%j) === %s', (raw, expected) => {
    expect(queryQualifies(raw)).toBe(expected)
  })
})

// ── matchTripSuggestions (AC-1.4 / AC-1.5) ────────────────────────────────

/**
 * A corpus entry as it arrives on the wire: `normalisedMotivo` is the SERVER's
 * fold, written out literally here rather than computed with the function
 * under test — the point of these tests is that the client folds the QUERY
 * only and takes each candidate's key as given (plan D3).
 */
const suggestion = (
  motivo: string,
  normalisedMotivo: string,
  overrides: Partial<TripSuggestion> = {},
): TripSuggestion => ({
  motivo,
  normalisedMotivo,
  km: 62,
  entity: 'welld_ch',
  count: 3,
  lastUsedOn: '2026-07-28',
  ...overrides,
})

const LUGANO = suggestion('Milano → Lugano client visit', 'milano → lugano client visit')
const MALPENSA = suggestion('Aeroporto Malpensa', 'aeroporto malpensa')
const ZURICH = suggestion('Zürich HQ', 'zurich hq')

describe('matchTripSuggestions — substring match anywhere (AC-1.4)', () => {
  const corpus = [LUGANO, MALPENSA, ZURICH]

  it.each(['lug', 'LUG', 'lùg', '  LÙG ', 'Lugano client'])(
    'matches mid-string, case- and accent-insensitively: %j',
    (query) => {
      expect(matchTripSuggestions(corpus, query)).toEqual([LUGANO])
    },
  )

  it('matches an accented candidate from an unaccented query (zurich → Zürich HQ)', () => {
    expect(matchTripSuggestions(corpus, 'zur')).toEqual([ZURICH])
  })

  it('returns nothing when no past trip contains the typed text', () => {
    expect(matchTripSuggestions(corpus, 'xyz')).toEqual([])
  })

  it('folds the QUERY only — a candidate is matched on the server-supplied key, never re-folded', () => {
    // A deliberately inconsistent row: its display motivo says "MILANO" but the
    // server's key says "zzz". Only the key may be matched against.
    const inconsistent = suggestion('MILANO', 'zzz')
    expect(matchTripSuggestions([inconsistent], 'mil')).toEqual([])
    expect(matchTripSuggestions([inconsistent], 'zz')).toEqual([inconsistent])
  })

  it('preserves the corpus order it was given — it never re-ranks (AC-1.7)', () => {
    const ordered = [
      suggestion('Trip C', 'trip c', { count: 9 }),
      suggestion('Trip A', 'trip a', { count: 5 }),
      suggestion('Trip B', 'trip b', { count: 2 }),
    ]
    expect(matchTripSuggestions(ordered, 'trip').map((s) => s.motivo)).toEqual(['Trip C', 'Trip A', 'Trip B'])
  })
})

describe('matchTripSuggestions — the 8-suggestion cap (AC-1.5)', () => {
  const thirty = Array.from({ length: 30 }, (_, i) =>
    suggestion(`Lugano trip ${i}`, `lugano trip ${i}`, { count: 30 - i }),
  )

  it('returns exactly 8 from a 30-match corpus', () => {
    expect(matchTripSuggestions(thirty, 'lugano')).toHaveLength(8)
  })

  it('keeps the first 8 in corpus order — the highest-ranked, since the server pre-ranked them', () => {
    expect(matchTripSuggestions(thirty, 'lugano').map((s) => s.motivo)).toEqual([
      'Lugano trip 0',
      'Lugano trip 1',
      'Lugano trip 2',
      'Lugano trip 3',
      'Lugano trip 4',
      'Lugano trip 5',
      'Lugano trip 6',
      'Lugano trip 7',
    ])
  })

  it('honours an explicit smaller limit', () => {
    expect(matchTripSuggestions(thirty, 'lugano', 3)).toHaveLength(3)
  })

  it('returns an empty array for an empty corpus, without throwing', () => {
    expect(matchTripSuggestions([], 'lugano')).toEqual([])
  })
})
