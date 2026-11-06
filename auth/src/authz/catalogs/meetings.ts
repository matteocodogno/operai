/**
 * The Meetings' declared permission catalog (specs/021-meetings — AC-10.8,
 * AC-1.4, AC-10.5; plan § Authorization).
 *
 * Mirrors `catalogs/crm.ts`'s shape: a plain constant describing the
 * (resource, action, supportedConditions) surface `meetings-api` enforces
 * server-side. `../seed.ts`'s `seedMeetingsCatalog` registers it via
 * `upsertAppCatalog` (one full-replace upsert keyed by `appId`).
 *
 * Three resources, all unconditioned:
 *   - the app-access resource (`meetings`) — `access`. Gates the tool AND is
 *     the capability to create meetings, use templates and run the AI actions.
 *     `meetings` is registered ONLY here, never also through `SUITE_APPS` (a
 *     second full-replace registration would prune it).
 *   - `template` — `manage`: create, edit and delete SHARED templates.
 *   - `meeting` — `erase`: delete any meeting, returning no content.
 *
 * There is deliberately NO permission that reads a meeting: opening one is
 * decided by the record (creator / participant / host reader), never by a role.
 *
 * The resolver, the shell's permission hints and `DIRECTORY_GATE_PERMISSIONS`
 * all key grants by `(resource, action)` without the app id, so `template` and
 * `meeting` must stay unique across catalogs (`uniqueResourceKeys.test.ts`).
 *
 * Declaration only: the role grants are `seedMeetingsGrants`, a separate step.
 */

import type { AppCatalogInput } from "../catalog";

/** The Meetings app id across the Operai suite catalog/role system. */
export const MEETINGS_APP_ID = "meetings";

export const MEETINGS_CATALOG: AppCatalogInput = {
  appId: MEETINGS_APP_ID,
  resources: [
    {
      key: MEETINGS_APP_ID,
      label: "Meetings",
      actions: [{ key: "access", label: "Access", supportedConditions: [] }],
    },
    {
      key: "template",
      label: "Summary template",
      actions: [{ key: "manage", label: "Manage shared templates", supportedConditions: [] }],
    },
    {
      key: "meeting",
      label: "Meeting",
      actions: [{ key: "erase", label: "Erase any meeting", supportedConditions: [] }],
    },
  ],
};
