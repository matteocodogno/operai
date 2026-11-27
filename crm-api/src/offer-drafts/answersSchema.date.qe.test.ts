import { describe, expect, it } from "bun:test";
import { AnswersSchema } from "./answersSchema";

/**
 * QE round 1 of the follow-ups (specs/20261126-teams/qe-followups.md, F4): a `client.date` that is not a calendar date must be
 * a refusal (the route's 422 `answers_invalid`), never an exception. `realDate` calls `new Date(...).toISOString()`, which
 * throws a RangeError on an Invalid Date, and a throw inside a zod refinement reaches the global handler as a 500
 * (live: `PUT /deals/{id}/offer-draft` with `date: "x"` or `"2026-13-45"` answers 500 `Invalid Date`).
 * Fixed: a refinement answers false, it never throws.
 */
const answers = (date: unknown) => ({
  v: 1,
  client: { lines: ["Via Roma 1"], contactIds: [], place: "Lugano", date },
  fields: {},
  prefilled: {},
  blocks: {},
  lists: {},
  tables: {},
  costs: { lines: {}, extra: [], columns: { position: true, unit: true }, showTotals: true },
  handEdits: {},
  orphanedEdits: [],
  validityDays: 30,
  aiAssisted: false,
  effortAnnex: false,
  attachmentIds: [],
  lastStep: "client",
});

describe("client.date that is not a calendar date is a refusal, not an exception (F4)", () => {
  it("control: a real date passes, an impossible one that parses (2026-02-30) is refused", () => {
    expect(AnswersSchema.safeParse(answers("2026-01-01")).success).toBe(true);
    expect(AnswersSchema.safeParse(answers("2026-02-30")).success).toBe(false);
  });
  for (const bad of ["x", "2026-13-45", "2026-00-10"]) {
    it(`${JSON.stringify(bad)} -> success: false, no throw`, () => {
      expect(AnswersSchema.safeParse(answers(bad)).success).toBe(false);
    });
  }
});

describe("every date helper of crm-api answers false for what it cannot read (F4 class)", () => {
  it("DateOnlySchema and isCalendarDate refuse non-dates without throwing", async () => {
    const { DateOnlySchema, isCalendarDate } = await import("../lib/http");
    for (const bad of ["x", "2026-13-45", "2026-00-10", "2026-02-30", "", "+275760-09-13", "2026-1-1", "２０２６-01-01"]) {
      expect(isCalendarDate(bad)).toBe(false);
      expect(DateOnlySchema.safeParse(bad).success).toBe(false);
    }
    expect(isCalendarDate("2026-02-28")).toBe(true);
    expect(isCalendarDate("2028-02-29")).toBe(true);
    expect(DateOnlySchema.safeParse("2026-01-01").success).toBe(true);
  });
});
