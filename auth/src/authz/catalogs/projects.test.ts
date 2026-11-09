/**
 * Structural checks of the projects catalog constant (specs/024-projects — AC-4.1,
 * AC-4.3–4.5). The registration path and the role grants are covered by `../seed.test.ts`.
 */

import { describe, expect, test } from "bun:test";
import { CRM_CATALOG } from "./crm";
import { ESTIMAI_CATALOG } from "./estimai";
import { INVENTORY_CATALOG } from "./inventory";
import { PROJECTS_APP_ID, PROJECTS_CATALOG } from "./projects";
import { REFUND_CATALOG } from "./refund";

describe("PROJECTS_CATALOG (specs/024)", () => {
  test("declares appId `projects` with a condition-free `access` action on the app-access resource", () => {
    expect(PROJECTS_APP_ID).toBe("projects");
    expect(PROJECTS_CATALOG.appId).toBe("projects");
    expect(PROJECTS_CATALOG.resources.find((r) => r.key === "projects")?.actions).toEqual([
      { key: "access", label: "Access", supportedConditions: [] },
    ]);
  });

  test("`project:manage` supports only the entity condition (ADR-0015); `contract:bexio` none", () => {
    const project = PROJECTS_CATALOG.resources.find((r) => r.key === "project");
    expect(project?.actions.map((a) => [a.key, a.supportedConditions])).toEqual([["manage", ["entity"]]]);
    const contract = PROJECTS_CATALOG.resources.find((r) => r.key === "contract");
    expect(contract?.actions.map((a) => [a.key, a.supportedConditions])).toEqual([["bexio", []]]);
  });

  test("declares exactly three resources", () => {
    expect(PROJECTS_CATALOG.resources.map((r) => r.key).sort()).toEqual(["contract", "project", "projects"]);
  });

  test("no resource key collides with another app's (the resolver keys grants by resource, not app)", () => {
    const others = [ESTIMAI_CATALOG, REFUND_CATALOG, INVENTORY_CATALOG, CRM_CATALOG].flatMap((c) =>
      c.resources.map((r) => r.key),
    );
    for (const resource of PROJECTS_CATALOG.resources) expect(others).not.toContain(resource.key);
  });
});
