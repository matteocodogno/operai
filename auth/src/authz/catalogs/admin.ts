/**
 * The Admin tool's declared permission catalog (specs/20261117-legal-entities — AC-4.1;
 * plan Key decision 4; ADR 20261117-an-app-is-reachable-through-a-capability-it-administers-…).
 *
 * `admin` moves here from the access-only `SUITE_APPS` list of `../seed.ts`:
 * `upsertAppCatalog` is a full replace per `appId`, so registering `admin` twice (once
 * through `SUITE_APPS`, once here) would make each registration prune the other's resources.
 * `admin` is registered ONLY here, never also through `SUITE_APPS`.
 *
 * Two resources:
 *   - the app-access resource (`admin`) — `access`, no conditions. Its meaning is unchanged:
 *     it opens the Roles, Departments, Users and Audit sections of the Admin tool.
 *   - `legal-entity` — `manage`, supporting the `entity` condition (ADR 20260716-entity-scoped-abac-refund-api):
 *     change the details of the holder's own entity, or of both when unconditioned.
 *
 * Resource names stay unique across catalogs: the resolver matches grants by
 * `(resource, action)` without the app id.
 *
 * Declaration only: the role grant is `seedLegalEntityGrants` (`admin` role only), and
 * `admin:access` for the `admin` role comes from `seedAdminRoleGrants` (`ALL_APP_IDS`).
 */

import type { AppCatalogInput } from "../catalog";

/** The Admin tool's app id across the Operai suite catalog/role system. */
export const ADMIN_APP_ID = "admin";

export const ADMIN_CATALOG: AppCatalogInput = {
  appId: ADMIN_APP_ID,
  resources: [
    {
      key: ADMIN_APP_ID,
      label: "Admin",
      actions: [{ key: "access", label: "Access", supportedConditions: [] }],
    },
    {
      key: "legal-entity",
      label: "Legal entity",
      actions: [{ key: "manage", label: "Manage", supportedConditions: ["entity"] }],
    },
  ],
};
