/**
 * Structural checks of the Admin catalog constant (specs/20261117-legal-entities — AC-4.1).
 * The registration path and the role grants are covered by `../seed.test.ts`.
 */

import { describe, expect, test } from "bun:test";
import { ADMIN_APP_ID, ADMIN_CATALOG } from "./admin";
import { CRM_CATALOG } from "./crm";
import { ESTIMAI_CATALOG } from "./estimai";
import { INVENTORY_CATALOG } from "./inventory";
import { LETTERHEADS_CATALOG } from "./letterheads";
import { MEETINGS_CATALOG } from "./meetings";
import { PROJECTS_CATALOG } from "./projects";
import { REFUND_CATALOG } from "./refund";

describe("ADMIN_CATALOG (specs/20261117-legal-entities)", () => {
  test("declares appId `admin` with a condition-free `access` action on the app-access resource", () => {
    expect(ADMIN_APP_ID).toBe("admin");
    expect(ADMIN_CATALOG.appId).toBe("admin");
    expect(ADMIN_CATALOG.resources.find((r) => r.key === "admin")?.actions).toEqual([
      { key: "access", label: "Access", supportedConditions: [] },
    ]);
  });

  test("lists legal-entity:manage with the entity condition under the admin app", () => {
    const legalEntity = ADMIN_CATALOG.resources.find((r) => r.key === "legal-entity");
    expect(legalEntity?.actions).toEqual([{ key: "manage", label: "Manage", supportedConditions: ["entity"] }]);
  });

  test("declares exactly admin:access and entity-scoped legal-entity:manage", () => {
    const capabilities = ADMIN_CATALOG.resources.flatMap((r) =>
      r.actions.map((a) => [`${r.key}:${a.key}`, a.supportedConditions] as const),
    );
    expect(capabilities.sort(([a], [b]) => a.localeCompare(b))).toEqual([
      ["admin:access", []],
      ["legal-entity:manage", ["entity"]],
    ]);
  });

  test("no resource name collides with another app's (the resolver matches grants by resource, not app)", () => {
    const others = [
      ESTIMAI_CATALOG,
      REFUND_CATALOG,
      INVENTORY_CATALOG,
      CRM_CATALOG,
      MEETINGS_CATALOG,
      PROJECTS_CATALOG,
      LETTERHEADS_CATALOG,
    ].flatMap((c) => c.resources.map((r) => r.key));
    for (const resource of ADMIN_CATALOG.resources) expect(others).not.toContain(resource.key);
  });
});
