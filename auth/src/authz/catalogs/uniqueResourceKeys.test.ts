/**
 * No two catalogs may declare the same resource key (specs/021-meetings —
 * AC-10.8, plan § Authorization).
 *
 * The resolver and the shell's `PermissionsResult` key grants by
 * `(resource, action)` WITHOUT the app id, so a `template` or `meeting` resource
 * declared by a second catalog would silently merge with the Meetings one — and
 * `DIRECTORY_GATE_PERMISSIONS` matches the same way. This test fails the day a
 * catalog reuses a key.
 */

import { describe, expect, test } from "bun:test";
import type { AppCatalogInput } from "../catalog";
import { DECLARED_CATALOGS, SUITE_APPS } from "../seed";

/** Resource keys declared by more than one catalog, with the app ids that declare them. */
function duplicateResourceKeys(catalogs: readonly AppCatalogInput[]): Record<string, string[]> {
  const owners = new Map<string, string[]>();
  for (const catalog of catalogs) {
    for (const resource of catalog.resources) {
      owners.set(resource.key, [...(owners.get(resource.key) ?? []), catalog.appId]);
    }
  }
  return Object.fromEntries([...owners].filter(([, apps]) => apps.length > 1));
}

describe("catalog resource keys are unique across the suite", () => {
  test("no two registered catalogs declare the same resource key", () => {
    const suiteAppCatalogs: AppCatalogInput[] = SUITE_APPS.map((app) => ({
      appId: app.appId,
      resources: [
        { key: app.appId, label: app.label, actions: [{ key: "access", label: "Access", supportedConditions: [] }] },
      ],
    }));
    expect(duplicateResourceKeys([...DECLARED_CATALOGS, ...suiteAppCatalogs])).toEqual({});
  });

  test("every declared catalog is in the list the check runs over", () => {
    expect(DECLARED_CATALOGS.map((c) => c.appId).sort()).toEqual(["crm", "estimai", "inventory", "meetings", "refund"]);
  });

  test("a duplicate resource key fails the check", () => {
    const clash: AppCatalogInput = {
      appId: "future-tool",
      resources: [
        { key: "template", label: "Template", actions: [{ key: "manage", label: "Manage", supportedConditions: [] }] },
      ],
    };
    expect(duplicateResourceKeys([...DECLARED_CATALOGS, clash])).toEqual({ template: ["meetings", "future-tool"] });
  });
});
