/**
 * Unit tests for `normaliseMotivo` (T1, specs/014-motivo-autocomplete, plan D3)
 * — pure, DB-free (`bun:test`, no Prisma/HTTP).
 *
 * Exercised against the canonical `MOTIVO_FOLD_VECTORS` table exported from
 * `normaliseMotivo.ts`, so `refund-ui`'s mirrored fold
 * (`refund-ui/src/lib/tripSuggestions.ts`, T8) can assert the IDENTICAL table
 * and the two implementations can never silently diverge (plan risk R2). This
 * is the ADR-0025 mirrored-rule-with-shared-vectors pattern, exactly as
 * `computeMileageAmountCents` + `mileage-vectors.json` already do it.
 *
 * Beyond the table, the suite pins the fold's *properties* — idempotency,
 * output invariants, and the equivalence classes AC-2.1 depends on — because a
 * mirrored implementation can pass every individual vector and still be wrong
 * on an input nobody thought to tabulate.
 */

import { describe, expect, it } from "bun:test";
import { MOTIVO_FOLD_VECTORS, normaliseMotivo } from "./normaliseMotivo";

/** Render invisible characters so a failure message is actually readable. */
const visible = (s: string): string =>
  JSON.stringify(s).replace(/[-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}`);

describe("normaliseMotivo — canonical vector table (mirrored in refund-ui, plan R2)", () => {
  for (const vector of MOTIVO_FOLD_VECTORS) {
    it(`${vector.description} — ${visible(vector.input)} -> ${visible(vector.expected)}`, () => {
      expect(normaliseMotivo(vector.input)).toBe(vector.expected);
    });
  }
});

describe("normaliseMotivo — the vector table is a contract artifact, not a fixture", () => {
  it("is non-empty and has no duplicate inputs (a duplicate hides a botched mirror edit)", () => {
    expect(MOTIVO_FOLD_VECTORS.length).toBeGreaterThan(0);
    const inputs = MOTIVO_FOLD_VECTORS.map((v) => v.input);
    expect(new Set(inputs).size).toBe(inputs.length);
  });

  it("every `expected` is itself a fixed point of the fold", () => {
    for (const vector of MOTIVO_FOLD_VECTORS) {
      expect(normaliseMotivo(vector.expected)).toBe(vector.expected);
    }
  });
});

describe("normaliseMotivo — AC-2.1: casing, accent and whitespace variants collapse to ONE key", () => {
  it("the three plan-D3 headline inputs all fold to one identical string", () => {
    const folded = ["Milano  →  LUGANO ", "milano → lugano", "Milano → Lugàno"].map(
      normaliseMotivo,
    );
    expect(new Set(folded).size).toBe(1);
    expect(folded[0]).toBe("milano → lugano");
  });

  it("every vector sharing an `expected` value forms a real equivalence class", () => {
    const classes = new Map<string, string[]>();
    for (const vector of MOTIVO_FOLD_VECTORS) {
      classes.set(vector.expected, [...(classes.get(vector.expected) ?? []), vector.input]);
    }
    // At least the headline trip, the empty class and the accent class exist.
    const multiMember = [...classes.values()].filter((members) => members.length > 1);
    expect(multiMember.length).toBeGreaterThanOrEqual(3);

    for (const [expected, members] of classes) {
      const foldedMembers = new Set(members.map(normaliseMotivo));
      expect(foldedMembers).toEqual(new Set([expected]));
    }
  });

  it("differing text still folds apart — the fold merges variants, never distinct trips", () => {
    expect(normaliseMotivo("Milano → Lugano")).not.toBe(normaliseMotivo("Milano → Como"));
  });
});

describe("normaliseMotivo — output invariants", () => {
  const samples = [
    ...MOTIVO_FOLD_VECTORS.map((v) => v.input),
    "    leading and trailing    ",
    "a\u0300\u0301\u0302 stacked marks",
    "\u0300 bare leading mark",
    "trailing mark \u0301",
  ];

  it("never has leading or trailing whitespace", () => {
    for (const sample of samples) {
      const folded = normaliseMotivo(sample);
      expect(folded).toBe(folded.trim());
    }
  });

  it("never contains a run of two or more whitespace characters", () => {
    for (const sample of samples) {
      expect(normaliseMotivo(sample)).not.toMatch(/\s{2}/);
    }
  });

  it("never contains a whitespace character other than U+0020 SPACE", () => {
    for (const sample of samples) {
      const folded = normaliseMotivo(sample);
      for (const char of folded) {
        if (/\s/.test(char)) expect(char).toBe(" ");
      }
    }
  });

  it("never leaves a residual combining diacritical mark (U+0300-U+036F)", () => {
    for (const sample of samples) {
      expect(normaliseMotivo(sample)).not.toMatch(/[̀-ͯ]/);
    }
  });

  it("is already NFC-normalised, so it is byte-stable on the wire as `normalisedMotivo`", () => {
    for (const sample of samples) {
      const folded = normaliseMotivo(sample);
      expect(folded).toBe(folded.normalize("NFC"));
    }
  });

  it("is idempotent — folding an already-folded value changes nothing", () => {
    for (const sample of samples) {
      const once = normaliseMotivo(sample);
      expect(normaliseMotivo(once)).toBe(once);
    }
  });
});

describe("normaliseMotivo — accent stripping must not damage non-Latin scripts", () => {
  // The adversarial finding behind choosing [U+0300-U+036F] over `\p{Diacritic}`
  // / `\p{Mn}`: NFD splits the Japanese dakuten off as U+3099, and stripping it
  // turns "ga" into "ka" — a different word, not an accent variant.
  it("Japanese dakuten survives: ガ stays ガ and never degrades to カ", () => {
    expect(normaliseMotivo("ガ")).toBe("ガ");
    expect(normaliseMotivo("ガ")).not.toBe("カ");
  });

  it("a decomposed kana sequence is re-composed by the final NFC, not stripped", () => {
    expect(normaliseMotivo("\u30AB\u3099")).toBe("ガ");
  });

  it("Hangul survives the NFD/NFC round trip intact", () => {
    expect(normaliseMotivo("한국")).toBe("한국");
  });

  it("spacing 'diacritics' are ordinary characters and must not be deleted", () => {
    // `·` `^` `` ` `` `´` are all Diacritic=Yes but are real text. Deleting them
    // would also leave a double space where a separator used to be.
    expect(normaliseMotivo("Koln · Bonn")).toBe("koln · bonn");
    expect(normaliseMotivo("a ^ b")).toBe("a ^ b");
  });
});

describe("normaliseMotivo — lowercasing is locale-independent", () => {
  // `toLocaleLowerCase("tr")` folds "I" to dotless "ı". If either app used the
  // locale-sensitive variant, the same motivo would fold differently depending
  // on the user's device locale — a divergence no vector on one side could catch.
  it("I folds to i regardless of locale, so ISTANBUL and İSTANBUL group together", () => {
    expect(normaliseMotivo("ISTANBUL")).toBe("istanbul");
    expect(normaliseMotivo("İSTANBUL")).toBe("istanbul");
  });

  it("documents the limitation: dotless ı has no decomposition and stays a distinct trip", () => {
    expect(normaliseMotivo("ıstanbul")).toBe("ıstanbul");
    expect(normaliseMotivo("ıstanbul")).not.toBe("istanbul");
  });
});

describe("normaliseMotivo — AC-2.5: the fold is a key, never display text", () => {
  it("is lossy and not reversible, so a suggestion must show the verbatim motivo instead", () => {
    const verbatim = "Milano → Lugàno";
    expect(normaliseMotivo(verbatim)).not.toBe(verbatim);
  });

  it("does not mutate its input", () => {
    const verbatim = "  Milano  →  LUGÀNO  ";
    normaliseMotivo(verbatim);
    expect(verbatim).toBe("  Milano  →  LUGÀNO  ");
  });
});

describe("normaliseMotivo — degenerate input", () => {
  it("returns empty string for empty, whitespace-only and mark-only input", () => {
    expect(normaliseMotivo("")).toBe("");
    expect(normaliseMotivo("   \t\n\r\u00A0 ")).toBe("");
    expect(normaliseMotivo("\u0300\u0301\u0302")).toBe("");
  });

  it("handles a long value without pathological backtracking", () => {
    const long = `${"Milano  →   Lugàno ".repeat(5_000)}`;
    const started = performance.now();
    const folded = normaliseMotivo(long);
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(folded.startsWith("milano → lugano milano")).toBe(true);
    expect(folded).not.toMatch(/\s{2}/);
  });
});
