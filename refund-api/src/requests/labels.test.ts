/**
 * refund-api's half of the label contract.
 *
 * `document-labels.json` is canonical; refund-ui asserts against the same
 * values in `documentLabels.parity.test.ts`. Neither package imports the
 * other (CLAUDE.md ### Git — no workspace), so drift is caught by each side
 * failing its own suite, the same mechanism as rates/mileage-vectors.json.
 */

import { describe, it, expect } from "bun:test";
import labels from "./document-labels.json";
import { entityLabel, entityHeaderLabel, expenseTypeLabel, requestStatusLabel } from "./labels";

describe("document labels", () => {
  // The defect this exists to prevent: the exported PDF read
  // "travel_km — welld_ch" and "Status: approved" while the screen beside it
  // said "Travel — mileage (km)", "WellD CH" and "Approved".
  it("renders every expense type as its display label, never the enum", () => {
    for (const [id, label] of Object.entries(labels.expenseType)) {
      expect(expenseTypeLabel(id)).toBe(label);
      expect(expenseTypeLabel(id)).not.toBe(id);
    }
  });

  it("covers all twelve expense types from the domain table", () => {
    expect(Object.keys(labels.expenseType)).toHaveLength(12);
  });

  it("renders both entities and every status as display labels", () => {
    expect(entityLabel("welld_ch")).toBe("WellD CH");
    expect(entityLabel("welld_it")).toBe("WellD Italia");
    expect(requestStatusLabel("approved")).toBe("Approved");
    expect(requestStatusLabel("paid")).toBe("Paid");
  });

  // A request's lines may straddle both entities (AC-3.5/6.6). The header must
  // not name one of them, which would invite the reader to treat it as THE
  // entity for the whole request.
  it("says Multiple for a mixed-entity request, deferring to the lines", () => {
    expect(entityHeaderLabel(["welld_ch", "welld_it"])).toBe("Multiple — see each line");
  });

  it("names the entity outright when every line shares one", () => {
    expect(entityHeaderLabel(["welld_ch", "welld_ch"])).toBe("WellD CH");
    expect(entityHeaderLabel(["welld_it"])).toBe("WellD Italia");
  });

  it("renders nothing for a request with no lines rather than a stray label", () => {
    expect(entityHeaderLabel([])).toBe("");
  });

  // A document that fails to generate is worse than one showing a raw value:
  // the raw value is at least the truth.
  it("falls back to the raw value for an unknown enum rather than throwing", () => {
    expect(expenseTypeLabel("a_type_shipped_after_this_table")).toBe(
      "a_type_shipped_after_this_table",
    );
    expect(entityLabel("welld_xx")).toBe("welld_xx");
    expect(requestStatusLabel("archived")).toBe("archived");
  });
});
