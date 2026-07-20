/**
 * Unit tests for `resolveEffectiveRate` (T3, specs/009-mileage-rate,
 * AC-2.1, AC-2.3, AC-2.4, AC-4.4).
 */

import { describe, expect, it } from "bun:test";
import { resolveEffectiveRate, type RateEntryLike } from "./resolve";

interface TestEntry extends RateEntryLike {
  readonly id: string;
}

const chJan: TestEntry = { id: "ch-jan", entity: "welld_ch", validFrom: "2026-01-01" };
const chJul: TestEntry = { id: "ch-jul", entity: "welld_ch", validFrom: "2026-07-01" };
const chFutureAug: TestEntry = {
  id: "ch-future-aug",
  entity: "welld_ch",
  validFrom: "2026-08-01",
};
const itMar: TestEntry = { id: "it-mar", entity: "welld_it", validFrom: "2026-03-01" };

describe("resolveEffectiveRate", () => {
  it("(AC-2.1) picks the latest validFrom <= date", () => {
    const entries = [chJan, chJul];
    expect(resolveEffectiveRate(entries, "welld_ch", "2026-07-15")?.id).toBe("ch-jul");
    expect(resolveEffectiveRate(entries, "welld_ch", "2026-03-01")?.id).toBe("ch-jan");
  });

  it("(AC-2.1) an entry effective exactly ON its validFrom date is selected", () => {
    const entries = [chJan, chJul];
    expect(resolveEffectiveRate(entries, "welld_ch", "2026-07-01")?.id).toBe("ch-jul");
  });

  it("(AC-2.2 precondition / no-rate case) returns null when the entity has no entry at all", () => {
    expect(resolveEffectiveRate([], "welld_ch", "2026-07-15")).toBeNull();
  });

  it("(AC-2.2) returns null when the earliest entry's validFrom is AFTER the date", () => {
    const entries = [chJul];
    expect(resolveEffectiveRate(entries, "welld_ch", "2026-01-01")).toBeNull();
  });

  it("(AC-2.3) two entities' series resolve completely independently", () => {
    const entries = [chJan, chJul, itMar];
    // welld_it's single entry never leaks into welld_ch resolution or vice versa.
    expect(resolveEffectiveRate(entries, "welld_it", "2026-07-15")?.id).toBe("it-mar");
    expect(resolveEffectiveRate(entries, "welld_ch", "2026-02-01")?.id).toBe("ch-jan");
    // welld_it has nothing before 2026-03-01, regardless of welld_ch's history.
    expect(resolveEffectiveRate(entries, "welld_it", "2026-02-01")).toBeNull();
  });

  it("(AC-4.4) a future-dated entry is never retroactively effective for an earlier date", () => {
    const entries = [chJan, chJul, chFutureAug];
    // A date before the future entry's validFrom still resolves to whatever
    // was already in effect — never the future entry.
    expect(resolveEffectiveRate(entries, "welld_ch", "2026-07-15")?.id).toBe("ch-jul");
    // On/after the future entry's own validFrom, it IS in effect.
    expect(resolveEffectiveRate(entries, "welld_ch", "2026-08-01")?.id).toBe("ch-future-aug");
    expect(resolveEffectiveRate(entries, "welld_ch", "2026-12-31")?.id).toBe("ch-future-aug");
  });

  it("(AC-2.4 support) re-evaluating against a different date can flip the result", () => {
    const entries = [chJan, chJul];
    const beforeJul = resolveEffectiveRate(entries, "welld_ch", "2026-06-30");
    const onJul = resolveEffectiveRate(entries, "welld_ch", "2026-07-01");
    expect(beforeJul?.id).toBe("ch-jan");
    expect(onJul?.id).toBe("ch-jul");
  });

  it("array order does not matter — the latest validFrom wins regardless of input order", () => {
    const entries = [chFutureAug, chJan, chJul];
    expect(resolveEffectiveRate(entries, "welld_ch", "2026-12-31")?.id).toBe("ch-future-aug");
    expect(resolveEffectiveRate(entries, "welld_ch", "2026-07-01")?.id).toBe("ch-jul");
  });
});
