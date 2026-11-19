/**
 * The time-tracking declared permission catalog (specs/20261112-time-tracking —
 * AC-5.2, AC-3.3, AC-4.3; plan § auth; ADR 20261112-hours-api-time-entries-own-service-hours-catalog).
 *
 * Mirrors `catalogs/meetings.ts`'s shape: a plain constant describing the
 * (resource, action, supportedConditions) surface `hours-api` enforces
 * server-side. `../seed.ts`'s `seedHoursCatalog` registers it via
 * `upsertAppCatalog` (one full-replace upsert keyed by `appId`).
 *
 * Two resources, both unconditioned, and deliberately NO `access` resource:
 * recording and reading your own hours is open to every signed-in user whatever
 * tools they can open (AC-5.1, ADR 20261112-hours-ui-ungated-remote), so there is nothing for an app-access
 * grant to gate and `hours` is NOT in `ALL_APP_IDS` (which exists to give
 * `admin` an `access` rule per app).
 *   - `time-entry` — `read-all`: see everyone's hours (D21). An oversight read
 *     only (ADR 20261108-estimai-oversight-permission-amends-0036 shape): holding it never lets anyone write someone else's
 *     entry (D14), and `hours-api` resolves it live on the oversight path only.
 *   - `time-list` — `manage`: create, rename, retire and restore the categories
 *     and the work types an entry may use (AC-3.3).
 *
 * The resolver, the shell's permission hints and `DIRECTORY_GATE_PERMISSIONS`
 * all key grants by `(resource, action)` without the app id, so `time-entry`
 * and `time-list` must stay unique across catalogs (`uniqueResourceKeys.test.ts`).
 * `time-entry:read-all` is NOT added to `DIRECTORY_GATE_PERMISSIONS`: the
 * person filter reads the `person` groups of the totals route instead, so the
 * user directory's audience does not widen (plan § auth, ADR 20261104-user-directory-gate-meetings-access untouched).
 *
 * Declaration only: the role grants are `seedHoursGrants`, a separate step.
 */

import type { AppCatalogInput } from "../catalog";

/** The time-tracking app id across the Operai suite catalog/role system. */
export const HOURS_APP_ID = "hours";

export const HOURS_CATALOG: AppCatalogInput = {
  appId: HOURS_APP_ID,
  resources: [
    {
      key: "time-entry",
      label: "Time entry",
      actions: [{ key: "read-all", label: "See everyone's hours", supportedConditions: [] }],
    },
    {
      key: "time-list",
      label: "Time lists",
      actions: [{ key: "manage", label: "Manage categories and work types", supportedConditions: [] }],
    },
  ],
};
