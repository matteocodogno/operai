/**
 * EstimAI's declared permission catalog (T26, specs/004-auth-roles-permissions
 * — refs AC-3.4; plan.md "Catalog registration"; ADR-0007 §7).
 *
 * Every Operai suite app ships a typed catalog declaration — a plain constant,
 * not a database row — describing the (resource, action, supportedConditions)
 * surface it exposes to the authorization system. This file is EstimAI's.
 * `../seed.ts`'s `seedEstimaiCatalog` registers it into `auth`'s
 * `catalog_resource`/`catalog_action` tables via `upsertAppCatalog` (T5), so
 * the admin-ui rule composer (T18) can build roles against it.
 *
 * Two resources:
 *   - The app-access resource (keyed by the app id itself, `estimai`) — a
 *     single `access` action, no conditions. This is the same shape every
 *     suite app gets from `seedAppAccessCatalog` (T11), but EstimAI is
 *     deliberately excluded from that seed's app list (see `seed.ts`) so its
 *     `access` action is registered exactly once, here, alongside its own
 *     domain resource — one full-replace upsert per appId, not two
 *     potentially-conflicting ones.
 *   - `estimate` — the domain resource — with `view`/`create`/`edit`/`delete`
 *     actions. Per the conditions model (plan.md, ADR-0007 §7), each action
 *     declares `["ownership", "entity", "department"]` as its
 *     `supportedConditions`, so an admin can later compose a rule such as
 *     "edit only estimates you own" (ownership) or "view estimates for your
 *     entity/department" (attribute conditions) once the rule builder and any
 *     future estimai-api enforcement consume this catalog.
 *
 * Declaration only (AC-3.4): registering this catalog does NOT make
 * `estimai-api`/`estimai-ui` enforce anything. Enforcement is an explicit
 * non-goal of this feature.
 */

import type { AppCatalogInput } from "../catalog";

/** EstimAI's app id across the Operai suite catalog/role system. */
export const ESTIMAI_APP_ID = "estimai";

/**
 * The conditions model (plan.md "conditions model" / ADR-0007 §7): ownership
 * (the caller owns the record) plus the two attribute conditions carried on
 * `user.entity`/department membership. Shared across every `estimate` action
 * so admins can compose the same kinds of rules regardless of which action
 * they're scoping.
 */
const ESTIMATE_SUPPORTED_CONDITIONS = ["ownership", "entity", "department"];

/** EstimAI's full declared catalog — registered by `seedEstimaiCatalog` (T26). */
export const ESTIMAI_CATALOG: AppCatalogInput = {
  appId: ESTIMAI_APP_ID,
  resources: [
    {
      key: ESTIMAI_APP_ID,
      label: "EstimAI",
      actions: [{ key: "access", label: "Access", supportedConditions: [] }],
    },
    {
      key: "estimate",
      label: "Estimate",
      actions: [
        { key: "view", label: "View", supportedConditions: ESTIMATE_SUPPORTED_CONDITIONS },
        {
          key: "create",
          label: "Create",
          supportedConditions: ESTIMATE_SUPPORTED_CONDITIONS,
        },
        { key: "edit", label: "Edit", supportedConditions: ESTIMATE_SUPPORTED_CONDITIONS },
        {
          key: "delete",
          label: "Delete",
          supportedConditions: ESTIMATE_SUPPORTED_CONDITIONS,
        },
      ],
    },
  ],
};
