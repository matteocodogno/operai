/**
 * Unit tests for the expense-line validation schema and the submit-time
 * completeness re-check (T8, specs/007-refund-service, AC-1.2/1.6).
 */

import { describe, it, expect } from "bun:test";
import { LineBodySchema, isLineComplete } from "./lines.schemas";

const base = {
  date: "2026-06-01",
  type: "office_material" as const,
  motivo: "Printer paper",
  entity: "welld_it" as const,
  requestedAmountCents: 1500,
};

describe("LineBodySchema", () => {
  it("accepts a complete non-travel_km line with no km", () => {
    expect(LineBodySchema.safeParse(base).success).toBe(true);
  });

  it("accepts a complete travel_km line with km > 0", () => {
    const result = LineBodySchema.safeParse({ ...base, type: "travel_km", km: 10 });
    expect(result.success).toBe(true);
  });

  it("rejects a travel_km line with km missing", () => {
    const result = LineBodySchema.safeParse({ ...base, type: "travel_km" });
    expect(result.success).toBe(false);
  });

  it("rejects a travel_km line with km === 0", () => {
    const result = LineBodySchema.safeParse({ ...base, type: "travel_km", km: 0 });
    expect(result.success).toBe(false);
  });

  it("rejects a travel_km line with km negative", () => {
    const result = LineBodySchema.safeParse({ ...base, type: "travel_km", km: -1 });
    expect(result.success).toBe(false);
  });

  it("rejects a non-travel_km line with km present", () => {
    const result = LineBodySchema.safeParse({ ...base, km: 5 });
    expect(result.success).toBe(false);
  });

  it("rejects an empty motivo", () => {
    const result = LineBodySchema.safeParse({ ...base, motivo: "" });
    expect(result.success).toBe(false);
  });

  it("rejects a missing date/type/entity/requestedAmountCents", () => {
    expect(LineBodySchema.safeParse({ ...base, date: undefined }).success).toBe(false);
    expect(LineBodySchema.safeParse({ ...base, type: undefined }).success).toBe(false);
    expect(LineBodySchema.safeParse({ ...base, entity: undefined }).success).toBe(false);
    expect(
      LineBodySchema.safeParse({ ...base, requestedAmountCents: undefined }).success,
    ).toBe(false);
  });

  it("rejects a negative requestedAmountCents", () => {
    expect(LineBodySchema.safeParse({ ...base, requestedAmountCents: -1 }).success).toBe(false);
  });

  it("rejects a non-integer requestedAmountCents", () => {
    expect(LineBodySchema.safeParse({ ...base, requestedAmountCents: 10.5 }).success).toBe(false);
  });

  it("accepts requestedAmountCents === 0", () => {
    expect(LineBodySchema.safeParse({ ...base, requestedAmountCents: 0 }).success).toBe(true);
  });

  it("rejects a malformed date", () => {
    expect(LineBodySchema.safeParse({ ...base, date: "06/01/2026" }).success).toBe(false);
  });
});

describe("isLineComplete (T10 submit-time defense-in-depth)", () => {
  it("a complete non-travel_km line is complete", () => {
    expect(
      isLineComplete({ motivo: "x", requestedAmountCents: 100, type: "postal", km: null }),
    ).toBe(true);
  });

  it("a complete travel_km line (km > 0) is complete", () => {
    expect(
      isLineComplete({ motivo: "x", requestedAmountCents: 100, type: "travel_km", km: 5 }),
    ).toBe(true);
  });

  it("a travel_km line with km null is incomplete", () => {
    expect(
      isLineComplete({ motivo: "x", requestedAmountCents: 100, type: "travel_km", km: null }),
    ).toBe(false);
  });

  it("a travel_km line with km <= 0 is incomplete", () => {
    expect(
      isLineComplete({ motivo: "x", requestedAmountCents: 100, type: "travel_km", km: 0 }),
    ).toBe(false);
  });

  it("a non-travel_km line with km set is incomplete", () => {
    expect(
      isLineComplete({ motivo: "x", requestedAmountCents: 100, type: "postal", km: 5 }),
    ).toBe(false);
  });

  it("an empty/whitespace motivo is incomplete", () => {
    expect(
      isLineComplete({ motivo: "   ", requestedAmountCents: 100, type: "postal", km: null }),
    ).toBe(false);
  });

  it("a negative requestedAmountCents is incomplete", () => {
    expect(
      isLineComplete({ motivo: "x", requestedAmountCents: -1, type: "postal", km: null }),
    ).toBe(false);
  });
});
