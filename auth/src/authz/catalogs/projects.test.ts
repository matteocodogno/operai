/**
 * Structural checks of the projects catalog constant (specs/021-projects — AC-4.1,
 * AC-4.3–4.5; specs/022 — AC-1.1, AC-1.9, AC-4.1, AC-4.8: `contract:bexio` becomes
 * `purchase-order:bexio`, plus `purchase-order:receive` and `handoff:take`). The registration
 * path and the role grants are covered by `../seed.test.ts`.
 */

import { describe, expect, test } from "bun:test";
import { CRM_CATALOG } from "./crm";
import { ESTIMAI_CATALOG } from "./estimai";
import { INVENTORY_CATALOG } from "./inventory";
import { PROJECTS_APP_ID, PROJECTS_CATALOG } from "./projects";
import { REFUND_CATALOG } from "./refund";

describe("PROJECTS_CATALOG (specs/021)", () => {
  test("declares appId `projects` with a condition-free `access` action on the app-access resource", () => {
    expect(PROJECTS_APP_ID).toBe("projects");
    expect(PROJECTS_CATALOG.appId).toBe("projects");
    expect(PROJECTS_CATALOG.resources.find((r) => r.key === "projects")?.actions).toEqual([
      { key: "access", label: "Access", supportedConditions: [] },
    ]);
  });

  test("declares exactly the five capabilities of specs/022 § Authorization, with their conditions", () => {
    const capabilities = PROJECTS_CATALOG.resources.flatMap((r) =>
      r.actions.map((a) => [`${r.key}:${a.key}`, a.supportedConditions] as const),
    );
    expect(capabilities.sort(([a], [b]) => a.localeCompare(b))).toEqual([
      ["handoff:take", ["entity"]],
      ["project:manage", ["entity"]],
      ["projects:access", []],
      ["purchase-order:bexio", []],
      ["purchase-order:receive", ["entity"]],
    ]);
  });

  test("declares exactly four resources, and no `contract` resource (the word is retired, D38)", () => {
    expect(PROJECTS_CATALOG.resources.map((r) => r.key).sort()).toEqual([
      "handoff",
      "project",
      "projects",
      "purchase-order",
    ]);
    expect(PROJECTS_CATALOG.resources.some((r) => r.key === "contract")).toBe(false);
  });

  test("no resource key collides with another app's (the resolver keys grants by resource, not app)", () => {
    const others = [ESTIMAI_CATALOG, REFUND_CATALOG, INVENTORY_CATALOG, CRM_CATALOG].flatMap((c) =>
      c.resources.map((r) => r.key),
    );
    for (const resource of PROJECTS_CATALOG.resources) expect(others).not.toContain(resource.key);
  });
});
