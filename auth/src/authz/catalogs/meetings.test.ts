/**
 * Structural checks of the Meetings catalog constant (specs/021-meetings —
 * AC-10.8, AC-1.4, AC-10.5). The registration path and the role grants are
 * covered by `../seed.test.ts`.
 */

import { describe, expect, test } from "bun:test";
import { MEETINGS_APP_ID, MEETINGS_CATALOG } from "./meetings";

describe("MEETINGS_CATALOG (specs/021)", () => {
  test("declares appId `meetings` with a condition-free `access` action", () => {
    expect(MEETINGS_APP_ID).toBe("meetings");
    expect(MEETINGS_CATALOG.appId).toBe("meetings");
    expect(MEETINGS_CATALOG.resources.find((r) => r.key === "meetings")?.actions).toEqual([
      { key: "access", label: "Access", supportedConditions: [] },
    ]);
  });

  test("`template:manage` and `meeting:erase` are declared, both unconditioned", () => {
    const template = MEETINGS_CATALOG.resources.find((r) => r.key === "template");
    expect(template?.actions.map((a) => [a.key, a.supportedConditions])).toEqual([["manage", []]]);
    const meeting = MEETINGS_CATALOG.resources.find((r) => r.key === "meeting");
    expect(meeting?.actions.map((a) => [a.key, a.supportedConditions])).toEqual([["erase", []]]);
  });

  test("declares exactly three permissions, none that reads a meeting (no role ever grants reading)", () => {
    const pairs = MEETINGS_CATALOG.resources.flatMap((r) => r.actions.map((a) => `${r.key}:${a.key}`));
    expect(pairs.sort()).toEqual(["meeting:erase", "meetings:access", "template:manage"]);
  });
});
