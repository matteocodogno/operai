/**
 * `canOpenAccountingRates` (T19, specs/20261119-accounting; AC-7.3, AC-8.1 and plan R12): the same coverage rule as auth
 * and accounting-api, proved against the one shared vectors file that auth owns.
 */

import { describe, expect, it } from "bun:test";
import type { ResolvedPermission } from "./resolveClient";
import { accountingReadCoverage, canOpenAccountingRates } from "./accountingViewer";

interface Vectors {
  readonly entities: string[];
  readonly cases: {
    readonly name: string;
    readonly permissions: ResolvedPermission[];
    readonly user: { entity: string | null };
    readonly covered: { read: string[]; manage: string[] };
    readonly appReachable: boolean;
  }[];
}

// Read-only: the file is auth's (T2). The path climbs from refund-api/src/authz to the repository root.
const vectorsPath = new URL("../../../auth/src/authz/entity-coverage-vectors.json", import.meta.url);
const vectors = (await Bun.file(vectorsPath).json()) as Vectors;

describe("the shared coverage vectors", () => {
  it("are the file auth owns, and non-trivial", () => {
    expect(vectors.entities).toEqual(["welld_ch", "welld_it"]);
    expect(vectors.cases.length).toBeGreaterThan(30);
  });

  for (const c of vectors.cases) {
    it(`${c.name}`, () => {
      expect([...accountingReadCoverage(c.permissions, c.user)].map(String).sort()).toEqual([...c.covered.read].sort());
      expect(canOpenAccountingRates(c.permissions, c.user)).toBe(c.covered.read.includes("welld_ch"));
    });
  }
});

describe("AC-7.3 by hand", () => {
  const entityCondition = { attributes: [{ key: "entity", match: "user" }] };
  const grant = (action: string, conditions: ResolvedPermission["conditions"] = null): ResolvedPermission => ({
    resource: "accounting",
    action,
    conditions,
  });

  it("read or manage covering WellD CH opens the link", () => {
    expect(canOpenAccountingRates([grant("read")], { entity: null })).toBe(true);
    expect(canOpenAccountingRates([grant("manage")], { entity: null })).toBe(true);
    expect(canOpenAccountingRates([grant("read", entityCondition)], { entity: "welld_ch" })).toBe(true);
  });

  it("none, or WellD Italia only, does not", () => {
    expect(canOpenAccountingRates([], { entity: "welld_ch" })).toBe(false);
    expect(canOpenAccountingRates([grant("read", entityCondition)], { entity: "welld_it" })).toBe(false);
    expect(canOpenAccountingRates([grant("manage", entityCondition)], { entity: "welld_it" })).toBe(false);
  });

  it("a Refund grant, even the review grant of WellD CH, opens nothing (AC-3.9)", () => {
    const review: ResolvedPermission = { resource: "request", action: "review", conditions: null };
    const settings: ResolvedPermission = { resource: "settings", action: "manage", conditions: null };
    expect(canOpenAccountingRates([review, settings], { entity: "welld_ch" })).toBe(false);
  });
});
