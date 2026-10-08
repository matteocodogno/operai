/**
 * Inventory's declared permission catalog (T3, specs/015-hardware-inventory —
 * refs AC-9.1, AC-9.3, AC-9.4, AC-9.5, AC-9.6; plan.md "Authorization model
 * (`auth`)"; ADR-0007 §7, ADR-0015).
 *
 * Mirrors `catalogs/refund.ts`'s shape: a plain constant describing the
 * (resource, action, supportedConditions) surface `inventory-api` enforces
 * server-side — NOT a database row. `../seed.ts`'s `seedInventoryCatalog`
 * registers it via `upsertAppCatalog` (one full-replace upsert keyed by
 * `appId`).
 *
 * Three resources:
 *   - The app-access resource (keyed by the app id itself, `inventory`) — a
 *     single `access` action, no conditions. It gates whether the tool appears
 *     in the sidebar at all (AC-9.6). `inventory` is registered ONLY here, never
 *     also through `seed.ts`'s `SUITE_APPS` list: `upsertAppCatalog` is a
 *     full-replace upsert, so a second registration would silently prune
 *     whichever ran first (the same reason `estimai` and `refund` are excluded).
 *   - `asset` — `manage`, supporting the `entity` condition. The **inventory
 *     manager** capability (register, assign, edit, invoice fields).
 *   - `ledger` — `manage`, supporting the `entity` condition. The **hardware
 *     accountant** capability (depreciation figures, fiscal years, rules).
 *
 * `entity` is ADR-0015's `{key:"entity", match:"user"}`: a conditioned grant
 * scopes the holder to their own `user.entity`; an unconditioned grant covers
 * both entities (the resolver's widest-wins union, ADR-0007). `inventory-api`
 * evaluates it per ASSET (an asset has one entity for life), which is exact —
 * unlike refund, where it is evaluated at request level.
 *
 * Declaration only: registering this catalog grants nothing. The role grants
 * (`seed.ts`'s `seedInventoryGrants`) are a separate, independent step.
 */

import type { AppCatalogInput } from "../catalog";

/** Inventory's app id across the Operai suite catalog/role system. */
export const INVENTORY_APP_ID = "inventory";

/** The entity-scoped actions' supported conditions (ADR-0015). */
const ENTITY_SCOPED_CONDITIONS = ["entity"];

/** Inventory's full declared catalog — registered by `seedInventoryCatalog` (T3). */
export const INVENTORY_CATALOG: AppCatalogInput = {
  appId: INVENTORY_APP_ID,
  resources: [
    {
      key: INVENTORY_APP_ID,
      label: "Inventory",
      actions: [{ key: "access", label: "Access", supportedConditions: [] }],
    },
    {
      key: "asset",
      label: "Hardware asset",
      actions: [{ key: "manage", label: "Manage", supportedConditions: ENTITY_SCOPED_CONDITIONS }],
    },
    {
      key: "ledger",
      label: "Asset ledger",
      actions: [{ key: "manage", label: "Manage", supportedConditions: ENTITY_SCOPED_CONDITIONS }],
    },
  ],
};
