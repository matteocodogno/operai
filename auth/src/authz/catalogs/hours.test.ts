/**
 * Structural checks of the `hours` catalog constant (specs/029-time-tracking —
 * AC-5.2, AC-3.3, AC-4.3; plan § auth). The registration path and the role
 * grants are covered by `../seed.test.ts`.
 */

import { describe, expect, test } from "bun:test";
import { DIRECTORY_GATE_PERMISSIONS } from "../directory.routes";
import { HOLDERS_GATE_PERMISSIONS } from "../holders.routes";
import { HOURS_APP_ID, HOURS_CATALOG } from "./hours";

describe("HOURS_CATALOG (specs/029)", () => {
  test("declares appId `hours`", () => {
    expect(HOURS_APP_ID).toBe("hours");
    expect(HOURS_CATALOG.appId).toBe("hours");
  });

  test("`time-entry:read-all` and `time-list:manage` are declared, both unconditioned (AC-5.2, AC-3.3, AC-4.3)", () => {
    const entry = HOURS_CATALOG.resources.find((r) => r.key === "time-entry");
    expect(entry?.actions.map((a) => [a.key, a.supportedConditions])).toEqual([["read-all", []]]);
    const list = HOURS_CATALOG.resources.find((r) => r.key === "time-list");
    expect(list?.actions.map((a) => [a.key, a.supportedConditions])).toEqual([["manage", []]]);
  });

  test("declares exactly those two permissions", () => {
    const pairs = HOURS_CATALOG.resources.flatMap((r) => r.actions.map((a) => `${r.key}:${a.key}`));
    expect(pairs.sort()).toEqual(["time-entry:read-all", "time-list:manage"]);
  });

  test("declares no `access` resource: the feature is ungated, every signed-in user records hours (AC-5.1)", () => {
    expect(HOURS_CATALOG.resources.some((r) => r.key === HOURS_APP_ID)).toBe(false);
    expect(HOURS_CATALOG.resources.some((r) => r.actions.some((a) => a.key === "access"))).toBe(false);
  });

  test("neither permission opens the user directory or the holders listing: their audience does not widen (plan § auth, ADR-0066)", () => {
    const hours = new Set(HOURS_CATALOG.resources.flatMap((r) => r.actions.map((a) => `${r.key}:${a.key}`)));
    for (const gate of [DIRECTORY_GATE_PERMISSIONS, HOLDERS_GATE_PERMISSIONS]) {
      expect(gate.filter((g) => hours.has(`${g.resource}:${g.action}`))).toEqual([]);
    }
  });
});
