/**
 * Unit tests for Accounting's declared catalog constant (specs/20261119-accounting — T1; refs
 * AC-3.1; ADR 20261117-an-app-is-reachable-through-a-capability-it-administers-… amendment point 2).
 * Pure structural checks — no DB; the registration path (`seedAccountingCatalog`) and the grants
 * are covered by `../seed.test.ts`.
 */

import { describe, expect, test } from "bun:test";
import { ACCOUNTING_APP_ID, ACCOUNTING_CATALOG } from "./accounting";

describe("ACCOUNTING_CATALOG (T1, AC-3.1)", () => {
  test("declares appId `accounting`", () => {
    expect(ACCOUNTING_APP_ID).toBe("accounting");
    expect(ACCOUNTING_CATALOG.appId).toBe(ACCOUNTING_APP_ID);
  });

  test("declares exactly one resource, `accounting`, labelled \"Accounting\"", () => {
    expect(ACCOUNTING_CATALOG.resources).toHaveLength(1);
    expect(ACCOUNTING_CATALOG.resources[0]?.key).toBe("accounting");
    expect(ACCOUNTING_CATALOG.resources[0]?.label).toBe("Accounting");
  });

  test("declares exactly `read` and `manage`, each supporting only the `entity` condition", () => {
    const actions = ACCOUNTING_CATALOG.resources[0]?.actions ?? [];
    expect(actions).toEqual([
      { key: "read", label: "Read", supportedConditions: ["entity"] },
      { key: "manage", label: "Manage", supportedConditions: ["entity"] },
    ]);
  });

  test("declares NO `access` action anywhere (the derived `apps` entry is the only door)", () => {
    const names = ACCOUNTING_CATALOG.resources.flatMap((r) => r.actions.map((a) => a["key"]));
    expect(names).not.toContain("access");
  });
});
