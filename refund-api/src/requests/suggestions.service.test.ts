/**
 * Unit tests for the trip-signature fold-merge, ranking and cap (T4,
 * specs/014-motivo-autocomplete).
 *
 * No database, no Hono, no clock — every assertion here is a property of the
 * pure function, so a failure points at the domain rule rather than at
 * infrastructure. The database-backed counterparts live in
 * `suggestions.routes.test.ts`.
 *
 * AC coverage
 * ───────────
 * AC-2.1  casing/accent/whitespace variants merge into ONE signature, counts summed
 * AC-2.2  same motivo + different km, or + different entity, never merge
 * AC-2.3  count desc, then lastUsedOn desc
 * AC-2.5  display text is the MOST RECENT constituent's verbatim motivo
 * AC-1.5  the ranked list is capped, highest-ranked retained
 * AC-2.4  the window cutoff arithmetic (the boundary itself is exercised
 *         end-to-end against real rows in the route test)
 * plan D8 the full deterministic total order, pinned
 */

import { describe, expect, it } from "bun:test";
import {
  buildTripSuggestions,
  MAX_TRIP_SUGGESTIONS,
  suggestionWindowCutoff,
  SUGGESTION_WINDOW_MONTHS,
  type TripTriple,
} from "./suggestions.service";

const triple = (over: Partial<TripTriple> = {}): TripTriple => ({
  motivo: "Milano → Lugano",
  km: 62,
  entity: "welld_ch",
  count: 1,
  lastUsedOn: "2026-01-01",
  ...over,
});

// ─── AC-2.1: variants merge ─────────────────────────────────────────────────

describe("buildTripSuggestions — fold-merge (AC-2.1)", () => {
  it("merges casing / accent / whitespace variants into ONE signature and sums counts", () => {
    const out = buildTripSuggestions([
      triple({ motivo: "Milano  →  LUGANO ", count: 2, lastUsedOn: "2026-01-10" }),
      triple({ motivo: "milano → lugano", count: 3, lastUsedOn: "2026-02-10" }),
      triple({ motivo: "Milano → Lugàno", count: 5, lastUsedOn: "2026-03-10" }),
    ]);

    expect(out).toHaveLength(1);
    expect(out[0]?.count).toBe(10);
    expect(out[0]?.normalisedMotivo).toBe("milano → lugano");
    expect(out[0]?.lastUsedOn).toBe("2026-03-10");
  });

  it("a single triple passes through unchanged, with its fold attached", () => {
    const out = buildTripSuggestions([
      triple({ motivo: "  Roma   →  Firenze ", km: 270, count: 4, lastUsedOn: "2025-12-01" }),
    ]);

    expect(out).toEqual([
      {
        motivo: "  Roma   →  Firenze ",
        normalisedMotivo: "roma → firenze",
        km: 270,
        entity: "welld_ch",
        count: 4,
        lastUsedOn: "2025-12-01",
      },
    ]);
  });

  it("returns [] for an empty corpus — never null, never an error branch", () => {
    expect(buildTripSuggestions([])).toEqual([]);
  });
});

// ─── AC-2.2: km / entity are part of the signature ──────────────────────────

describe("buildTripSuggestions — signature separation (AC-2.2)", () => {
  it("same motivo, different km → two separate suggestions", () => {
    const out = buildTripSuggestions([
      triple({ km: 62, count: 4 }),
      triple({ km: 64, count: 4 }),
    ]);

    expect(out).toHaveLength(2);
    expect(out.map((s) => s.km).sort((a, b) => a - b)).toEqual([62, 64]);
    // Neither absorbed the other's count.
    expect(out.every((s) => s.count === 4)).toBe(true);
  });

  it("same motivo, different entity → two separate suggestions", () => {
    const out = buildTripSuggestions([
      triple({ entity: "welld_ch", count: 7 }),
      triple({ entity: "welld_it", count: 7 }),
    ]);

    expect(out).toHaveLength(2);
    expect(out.map((s) => s.entity).sort()).toEqual(["welld_ch", "welld_it"]);
  });

  it("folded-equal motivo + equal km + DIFFERENT entity still never merges", () => {
    const out = buildTripSuggestions([
      triple({ motivo: "Milano → LUGANO", entity: "welld_ch", count: 2 }),
      triple({ motivo: "milano → lugàno", entity: "welld_it", count: 3 }),
    ]);

    expect(out).toHaveLength(2);
    expect(out.every((s) => s.normalisedMotivo === "milano → lugano")).toBe(true);
  });
});

// ─── AC-2.5: display text ───────────────────────────────────────────────────

describe("buildTripSuggestions — display text (AC-2.5)", () => {
  it("shows the MOST RECENT constituent's motivo, verbatim, never the fold", () => {
    const out = buildTripSuggestions([
      triple({ motivo: "milano lugano", lastUsedOn: "2025-05-01", count: 9 }),
      triple({ motivo: "Milano  →  LUGANO", lastUsedOn: "2026-04-02", count: 1 }),
    ]);

    // Note the higher-count variant is the OLDER one — recency wins, not
    // popularity (AC-2.5 says "most recent", full stop).
    expect(out).toHaveLength(2); // different folds: "milano lugano" vs "milano → lugano"
    const merged = buildTripSuggestions([
      triple({ motivo: "milano → lugano", lastUsedOn: "2025-05-01", count: 9 }),
      triple({ motivo: "Milano  →  LUGANO", lastUsedOn: "2026-04-02", count: 1 }),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.motivo).toBe("Milano  →  LUGANO");
    expect(merged[0]?.normalisedMotivo).toBe("milano → lugano");
    expect(merged[0]?.count).toBe(10);
  });

  it("the elected display text is independent of input order", () => {
    const oldest = triple({ motivo: "milano lugano x", lastUsedOn: "2024-01-01", count: 4 });
    const newest = triple({ motivo: "MILANO LUGANO X", lastUsedOn: "2026-06-01", count: 1 });

    expect(buildTripSuggestions([oldest, newest])[0]?.motivo).toBe("MILANO LUGANO X");
    expect(buildTripSuggestions([newest, oldest])[0]?.motivo).toBe("MILANO LUGANO X");
  });

  it("on an equal most-recent date the higher-count variant wins, then code-unit order", () => {
    // AC-2.5 is silent on this tie; the rule exists so the response cannot
    // flap between two requests over identical data.
    const a = triple({ motivo: "AAA bbb", lastUsedOn: "2026-06-01", count: 1 });
    const b = triple({ motivo: "aaa BBB", lastUsedOn: "2026-06-01", count: 5 });
    expect(buildTripSuggestions([a, b])[0]?.motivo).toBe("aaa BBB");
    expect(buildTripSuggestions([b, a])[0]?.motivo).toBe("aaa BBB");

    const c = triple({ motivo: "ZZZ ccc", lastUsedOn: "2026-06-01", count: 2 });
    const d = triple({ motivo: "AAA ccc", lastUsedOn: "2026-06-01", count: 2 });
    // Same date, same count → lexicographically smallest wins, both orders.
    expect(buildTripSuggestions([c, d])[0]?.motivo).toBe("AAA ccc");
    expect(buildTripSuggestions([d, c])[0]?.motivo).toBe("AAA ccc");
  });

  it("a three-way merge still elects the single most recent variant", () => {
    const out = buildTripSuggestions([
      triple({ motivo: "roma napoli", lastUsedOn: "2025-01-01", count: 20 }),
      triple({ motivo: "Roma → Napoli", lastUsedOn: "2026-07-01", count: 1 }),
      triple({ motivo: "ROMA NAPOLI", lastUsedOn: "2026-03-01", count: 6 }),
    ]);

    // "roma napoli" / "ROMA NAPOLI" fold alike; "Roma → Napoli" does not.
    const grouped = out.find((s) => s.normalisedMotivo === "roma napoli");
    expect(grouped?.count).toBe(26);
    expect(grouped?.motivo).toBe("ROMA NAPOLI");
    expect(grouped?.lastUsedOn).toBe("2026-03-01");
  });
});

// ─── AC-2.3 + plan D8: ranking ──────────────────────────────────────────────

describe("buildTripSuggestions — ranking (AC-2.3, plan D8)", () => {
  it("(AC-2.3) orders by count desc, then lastUsedOn desc", () => {
    const out = buildTripSuggestions([
      triple({ motivo: "b trip", km: 2, count: 3, lastUsedOn: "2026-05-01" }),
      triple({ motivo: "a trip", km: 1, count: 9, lastUsedOn: "2024-01-01" }),
      triple({ motivo: "c trip", km: 3, count: 3, lastUsedOn: "2026-06-01" }),
    ]);

    expect(out.map((s) => s.normalisedMotivo)).toEqual(["a trip", "c trip", "b trip"]);
  });

  it("(plan D8) pins the FULL total order: count, date, normalisedMotivo, km, entity", () => {
    // Every pair below is separated by exactly one key, the later keys being
    // deliberately arranged to disagree — so a comparator that dropped or
    // reordered a key would produce a different sequence.
    const out = buildTripSuggestions([
      // 5th: lowest count.
      triple({ motivo: "zz", km: 1, entity: "welld_ch", count: 1, lastUsedOn: "2026-12-01" }),
      // 4th: count 2, older date.
      triple({ motivo: "aa", km: 1, entity: "welld_ch", count: 2, lastUsedOn: "2020-01-01" }),
      // 1st-3rd: count 2, same (newer) date — separated by motivo, then km, then entity.
      triple({ motivo: "bb", km: 5, entity: "welld_ch", count: 2, lastUsedOn: "2026-01-01" }),
      triple({ motivo: "bb", km: 5, entity: "welld_it", count: 2, lastUsedOn: "2026-01-01" }),
      triple({ motivo: "bb", km: 4, entity: "welld_it", count: 2, lastUsedOn: "2026-01-01" }),
    ]);

    expect(
      out.map((s) => `${s.count}|${s.lastUsedOn}|${s.normalisedMotivo}|${s.km}|${s.entity}`),
    ).toEqual([
      "2|2026-01-01|bb|4|welld_it",
      "2|2026-01-01|bb|5|welld_ch",
      "2|2026-01-01|bb|5|welld_it",
      "2|2020-01-01|aa|1|welld_ch",
      "1|2026-12-01|zz|1|welld_ch",
    ]);
  });

  it("is deterministic: a shuffled input produces a byte-identical ranking", () => {
    const input: TripTriple[] = [];
    for (let i = 0; i < 40; i++) {
      input.push(
        triple({
          motivo: `trip ${i % 7}`,
          km: (i % 3) + 1,
          entity: i % 2 === 0 ? "welld_ch" : "welld_it",
          count: (i % 4) + 1,
          lastUsedOn: `2026-0${(i % 9) + 1}-01`,
        }),
      );
    }
    const reference = buildTripSuggestions(input);
    const shuffled = buildTripSuggestions([...input].reverse());
    expect(shuffled).toEqual(reference);
  });

  it("(AC-1.7) the emitted count sequence is non-increasing", () => {
    const out = buildTripSuggestions(
      Array.from({ length: 25 }, (_, i) =>
        triple({ motivo: `trip ${i}`, km: i + 1, count: ((i * 7) % 11) + 1 }),
      ),
    );
    for (let i = 1; i < out.length; i++) {
      expect(out[i]!.count).toBeLessThanOrEqual(out[i - 1]!.count);
    }
  });
});

// ─── AC-1.5 / plan D5: the cap ──────────────────────────────────────────────

describe("buildTripSuggestions — cap (plan D5/R1)", () => {
  it("caps at exactly 200 signatures and keeps the highest-ranked", () => {
    // 260 distinct trips; count ascending with the index, so the retained
    // set must be exactly the top-200 counts (61..260).
    const input = Array.from({ length: 260 }, (_, i) =>
      triple({ motivo: `trip ${i}`, km: i + 1, count: i + 1 }),
    );

    const out = buildTripSuggestions(input);

    expect(out).toHaveLength(MAX_TRIP_SUGGESTIONS);
    expect(out).toHaveLength(200);
    expect(out[0]?.count).toBe(260);
    expect(out[199]?.count).toBe(61);
    // The dropped tail is by definition the LEAST-used trips (plan R1).
    expect(out.some((s) => s.count <= 60)).toBe(false);
  });

  it("counts SIGNATURES, not input rows — 300 variants of one trip yield one suggestion", () => {
    const input = Array.from({ length: 300 }, (_, i) =>
      triple({ motivo: i % 2 === 0 ? "Milano → Lugano" : "milano  →  LUGANO", count: 1 }),
    );
    expect(buildTripSuggestions(input)).toHaveLength(1);
  });

  it("honours an explicit lower limit (the parameter the UI's 8 could reuse)", () => {
    const input = Array.from({ length: 30 }, (_, i) =>
      triple({ motivo: `trip ${i}`, km: i + 1, count: i + 1 }),
    );
    const out = buildTripSuggestions(input, 8);
    expect(out).toHaveLength(8);
    expect(out[0]?.count).toBe(30);
  });
});

// ─── AC-2.4: the window cutoff ──────────────────────────────────────────────

describe("suggestionWindowCutoff (AC-2.4)", () => {
  it("is exactly 24 months before `now`, at UTC midnight", () => {
    expect(SUGGESTION_WINDOW_MONTHS).toBe(24);
    const cutoff = suggestionWindowCutoff(new Date("2026-08-11T13:45:12.000Z"));
    expect(cutoff.toISOString()).toBe("2024-08-11T00:00:00.000Z");
  });

  it("ignores the time of day — two instants on the same UTC day share a cutoff", () => {
    const early = suggestionWindowCutoff(new Date("2026-08-11T00:00:00.001Z"));
    const late = suggestionWindowCutoff(new Date("2026-08-11T23:59:59.999Z"));
    expect(early.toISOString()).toBe(late.toISOString());
  });

  it("crosses a year boundary correctly", () => {
    expect(suggestionWindowCutoff(new Date("2026-01-15T10:00:00.000Z")).toISOString()).toBe(
      "2024-01-15T00:00:00.000Z",
    );
  });

  it("normalises Feb 29 to Mar 1 (Date.UTC month overflow — accepted, plan § Data model)", () => {
    // 2024-02-29 minus 24 months = 2022-02-29, which does not exist.
    expect(suggestionWindowCutoff(new Date("2024-02-29T08:00:00.000Z")).toISOString()).toBe(
      "2022-03-01T00:00:00.000Z",
    );
  });

  it("is monotonic — a later `now` never yields an earlier cutoff", () => {
    let previous = suggestionWindowCutoff(new Date("2026-01-01T00:00:00.000Z")).getTime();
    for (let day = 2; day <= 400; day++) {
      const now = new Date(Date.UTC(2026, 0, day, 12));
      const cutoff = suggestionWindowCutoff(now).getTime();
      expect(cutoff).toBeGreaterThanOrEqual(previous);
      previous = cutoff;
    }
  });
});
