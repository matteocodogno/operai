/**
 * Schema unit tests for `GET /line-suggestions` (T2, specs/014-motivo-autocomplete).
 *
 * These are the AC-4.3 assertions that hold WITHOUT a server, a database or a
 * caller: the query surface itself cannot address another subject, because it
 * has exactly one field and that field is a single-member enum.
 *
 * AC coverage
 * ───────────
 * AC-4.3  the query accepts ONLY `type`; every subject-addressing parameter
 *         name a future author might reach for is rejected outright
 * AC-1.7  the response shape carries `count` + `lastUsedOn` (the two ranking
 *         signals AC-1.7 requires a suggestion to display)
 * AC-2.3  `type` cannot be widened to another expense type by the caller
 */

import { describe, expect, it } from "bun:test";
import {
  SUGGESTION_TYPE_VALUES,
  SuggestionsQuerySchema,
  SuggestionsResponseSchema,
  TripSuggestionSchema,
} from "./suggestions.schemas";

describe("SuggestionsQuerySchema (AC-4.3)", () => {
  it("accepts exactly one shape: { type: 'travel_km' }", () => {
    const parsed = SuggestionsQuerySchema.safeParse({ type: "travel_km" });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toEqual({ type: "travel_km" });
  });

  it("has exactly ONE field — the shape cannot grow unnoticed", () => {
    expect(Object.keys(SuggestionsQuerySchema.shape)).toEqual(["type"]);
  });

  it("(AC-4.3) rejects every subject-addressing parameter a future author might add", () => {
    // Each of these, if ACCEPTED, would be a candidate IDOR selector. The
    // point of this list is that none of them is merely ignored — the request
    // is refused, so the property is observable from outside the process.
    const subjectSelectors = [
      "userId",
      "ownerUserId",
      "sub",
      "user",
      "employeeId",
      "requestId",
      "id",
      "email",
    ];

    for (const key of subjectSelectors) {
      const parsed = SuggestionsQuerySchema.safeParse({
        type: "travel_km",
        [key]: "someone-else",
      });
      expect(parsed.success).toBe(false);
    }
  });

  it("(AC-4.3) rejects an unknown query key, rather than silently stripping it", () => {
    const parsed = SuggestionsQuerySchema.safeParse({
      type: "travel_km",
      q: "milano",
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((i) => i.code === "unrecognized_keys")).toBe(true);
    }
  });

  it("rejects a missing type", () => {
    expect(SuggestionsQuerySchema.safeParse({}).success).toBe(false);
  });

  it("(AC-2.3) rejects any expense type other than travel_km", () => {
    // The other eleven types are an explicit spec Non-goal — a caller must not
    // be able to reach a fill set that was never designed.
    for (const type of [
      "travel_train",
      "office_material",
      "representation_meals",
      "TRAVEL_KM",
      "travel-km",
      "",
    ]) {
      expect(SuggestionsQuerySchema.safeParse({ type }).success).toBe(false);
    }
  });

  it("rejects a repeated ?type= parameter (Hono surfaces repeats as an array)", () => {
    expect(
      SuggestionsQuerySchema.safeParse({ type: ["travel_km", "office_material"] }).success,
    ).toBe(false);
  });

  it("SUGGESTION_TYPE_VALUES is a single-member set (spec Non-goals)", () => {
    expect(SUGGESTION_TYPE_VALUES).toEqual(["travel_km"]);
  });
});

describe("TripSuggestionSchema / SuggestionsResponseSchema", () => {
  const valid = {
    motivo: "Milano → Lugano  cliente ACME",
    normalisedMotivo: "milano → lugano cliente acme",
    km: 62,
    entity: "welld_ch",
    count: 14,
    lastUsedOn: "2026-07-28",
  };

  it("accepts the plan's documented wire shape", () => {
    expect(TripSuggestionSchema.safeParse(valid).success).toBe(true);
  });

  it("(AC-1.7) requires both ranking signals — count and lastUsedOn", () => {
    const { count: _count, ...noCount } = valid;
    const { lastUsedOn: _lastUsed, ...noLastUsed } = valid;
    expect(TripSuggestionSchema.safeParse(noCount).success).toBe(false);
    expect(TripSuggestionSchema.safeParse(noLastUsed).success).toBe(false);
  });

  it("rejects a non-positive km or count", () => {
    expect(TripSuggestionSchema.safeParse({ ...valid, km: 0 }).success).toBe(false);
    expect(TripSuggestionSchema.safeParse({ ...valid, count: 0 }).success).toBe(false);
  });

  it("rejects an entity outside the two wellD legal entities", () => {
    expect(TripSuggestionSchema.safeParse({ ...valid, entity: "welld_de" }).success).toBe(
      false,
    );
  });

  it("pins the response envelope", () => {
    expect(
      SuggestionsResponseSchema.safeParse({ type: "travel_km", suggestions: [valid] })
        .success,
    ).toBe(true);
    expect(
      SuggestionsResponseSchema.safeParse({ type: "travel_km", suggestions: [] }).success,
    ).toBe(true);
    expect(
      SuggestionsResponseSchema.safeParse({ type: "travel_train", suggestions: [] }).success,
    ).toBe(false);
  });
});
