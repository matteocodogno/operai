/**
 * Unit tests for inventory's declared catalog constant (T3, specs/015-hardware-
 * inventory — refs AC-9.1, AC-9.3, AC-9.4, AC-9.5). Pure structural checks —
 * no DB, no registration; the registration path (`upsertAppCatalog` via
 * `seedInventoryCatalog`) and the role grants are covered by `../seed.test.ts`.
 */

import { describe, expect, test } from "bun:test";
import { INVENTORY_APP_ID, INVENTORY_CATALOG } from "./inventory";

describe("INVENTORY_CATALOG (T3, AC-9.1/9.3/9.4/9.5)", () => {
  test("declares appId `inventory`", () => {
    expect(INVENTORY_APP_ID).toBe("inventory");
    expect(INVENTORY_CATALOG.appId).toBe(INVENTORY_APP_ID);
  });

  test("declares the app-access resource with a single, condition-free `access` action", () => {
    const accessResource = INVENTORY_CATALOG.resources.find((r) => r.key === INVENTORY_APP_ID);
    expect(accessResource).toBeDefined();
    expect(accessResource?.actions).toEqual([
      { key: "access", label: "Access", supportedConditions: [] },
    ]);
  });

  test("`asset` declares exactly `manage`, supporting only the `entity` condition (ADR-0015)", () => {
    const asset = INVENTORY_CATALOG.resources.find((r) => r.key === "asset");
    expect(asset?.actions.map((a) => a.key)).toEqual(["manage"]);
    expect(asset?.actions[0]?.supportedConditions).toEqual(["entity"]);
  });

  test("`ledger` declares exactly `manage`, supporting only the `entity` condition (ADR-0015)", () => {
    const ledger = INVENTORY_CATALOG.resources.find((r) => r.key === "ledger");
    expect(ledger?.actions.map((a) => a.key)).toEqual(["manage"]);
    expect(ledger?.actions[0]?.supportedConditions).toEqual(["entity"]);
  });

  test("declares exactly three resources — app access, `asset`, `ledger` — nothing else", () => {
    expect(INVENTORY_CATALOG.resources.map((r) => r.key).sort()).toEqual(
      ["asset", "inventory", "ledger"].sort(),
    );
  });
});
