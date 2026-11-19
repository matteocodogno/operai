/**
 * The apps `GET /authz/me` derives into `apps` from a capability, instead of from an `access` grant
 * (specs/20261117-legal-entities, ADR 20261117-an-app-is-reachable-through-a-capability-it-administers-…, and
 * its amendment of 2026-11-19: specs/20261119-accounting, T2, AC-8.1, AC-3.2).
 *
 * One table, one function. A row names an app and the `(resource, action)` pairs it is reached through; the row
 * applies when ANY of its pairs covers at least one legal entity for the caller, decided by
 * `entitiesCoveredByAny` (`../legalEntities/coverage.ts`), i.e. by `entityGrantFor`, the function the management
 * routes use. The next tool whose capability is also its entrance gets a row here, not a new function (ADR
 * amendment point 6).
 *
 *   - `admin`      <- `legal-entity:manage`
 *   - `accounting` <- `accounting:read` OR `accounting:manage` (AC-3.2: manage includes read). The catalog has no
 *                     `accounting:access`, so this entry is the only door to the tool.
 *
 * Presentation only. A derived entry means "may enter the tool", never "is an administrator" and never proof of a
 * capability over a particular entity: the resource servers (admin APIs, accounting-api) enforce every route. For
 * the same reason `/authz/resolve`, `/authz/app-access-check` and the directory's app filter derive nothing.
 *
 * Two services compute "covers an entity" (auth here, accounting-api for its routes). The rule is one set of
 * shared vectors, `entity-coverage-vectors.json`, run by both packages' tests; both fail closed on a condition
 * they do not know.
 */

import { type EntityGrantRef, entitiesCoveredByAny, LEGAL_ENTITY_MANAGE_GRANT } from "../legalEntities/coverage";
import { ACCOUNTING_APP_ID } from "./catalogs/accounting";
import type { EffectivePermission } from "./resolver";

export interface DerivedApp {
  /** The id added to `apps`. */
  readonly appId: string;
  /** The row applies when any of these covers at least one entity for the caller. */
  readonly grants: readonly EntityGrantRef[];
}

/** The derived apps, in the order they are appended to `apps`. */
export const DERIVED_APPS: readonly DerivedApp[] = [
  { appId: "admin", grants: [LEGAL_ENTITY_MANAGE_GRANT] },
  {
    appId: ACCOUNTING_APP_ID,
    grants: [
      { resource: ACCOUNTING_APP_ID, action: "read" },
      { resource: ACCOUNTING_APP_ID, action: "manage" },
    ],
  },
];

/** The ids of the table's rows that apply to `user` with `permissions`, in table order. */
export function derivedAppIds(
  permissions: readonly EffectivePermission[],
  user: { readonly entity: string | null },
): string[] {
  return DERIVED_APPS.filter((row) => entitiesCoveredByAny(permissions, user, row.grants).length > 0).map(
    (row) => row.appId,
  );
}

/**
 * `apps` plus every derived id it does not already hold, appended in table order. Never reorders or removes an
 * id, never duplicates one; returns a new array.
 */
export function withDerivedApps(
  apps: readonly string[],
  permissions: readonly EffectivePermission[],
  user: { readonly entity: string | null },
): string[] {
  const result = [...apps];
  for (const appId of derivedAppIds(permissions, user)) {
    if (!result.includes(appId)) result.push(appId);
  }
  return result;
}
