/**
 * The Accounting module's declared permission catalog (specs/20261119-accounting — T1; refs
 * AC-3.1, AC-3.3; plan.md "Authorization model"; ADR 20261119-accounting-reference-data-belongs-to-accounting-api-…;
 * ADR 20261117-an-app-is-reachable-through-a-capability-it-administers-… amendment of 2026-11-19, point 2).
 *
 * One resource, `accounting`, with two actions, both supporting the `entity` condition
 * (ADR 20260716-entity-scoped-abac-refund-api): `read` (the chart of accounts, the VAT codes and the
 * monthly rates of the holder's entity, or of both when unconditioned) and `manage` (change them).
 * `manage` includes `read` (AC-3.2); that rule is enforced by accounting-api's `coverage.ts` and
 * written in AGENTS.md's Identity section, NOT here: a catalog only declares the surface.
 * Labels are English only, like every catalog (design.md G12).
 *
 * NO `access` action, on purpose (ADR amendment point 2). A third `accounting:access` permission
 * would be a capability that can drift from the two the spec names. The only door to the tool is the
 * derived `accounting` entry of `GET /authz/me` `apps` (`../derivedApps.ts`), built from `read` or
 * `manage` covering at least one entity. For the same reason `accounting` is NOT in `ALL_APP_IDS`
 * (which feeds `seedAdminRoleGrants`' per-app `access` grant) and NOT in `SUITE_APPS`.
 *
 * The resource key `accounting` must stay unique across catalogs: the resolver matches grants by
 * `(resource, action)` without the app id (`uniqueResourceKeys.test.ts`). It is also the name of the
 * `accounting` system ROLE — a role name and a resource key live in different tables and never clash.
 *
 * Declaration only: registering this catalog grants nothing — `seedAccountingGrants` does
 * (`../seed.ts`).
 */

import type { AppCatalogInput } from "../catalog";

/** The Accounting module's app id across the Operai suite catalog/role system. */
export const ACCOUNTING_APP_ID = "accounting";

/** Accounting's declared catalog — registered by `seedAccountingCatalog`. */
export const ACCOUNTING_CATALOG: AppCatalogInput = {
  appId: ACCOUNTING_APP_ID,
  resources: [
    {
      key: ACCOUNTING_APP_ID,
      label: "Accounting",
      actions: [
        { key: "read", label: "Read", supportedConditions: ["entity"] },
        { key: "manage", label: "Manage", supportedConditions: ["entity"] },
      ],
    },
  ],
};
