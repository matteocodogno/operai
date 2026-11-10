/**
 * The projects module's declared permission catalog (specs/025-projects — AC-4.1,
 * AC-4.3–4.6; ADR-0079).
 *
 * Mirrors `catalogs/crm.ts`'s shape: a plain constant describing the
 * (resource, action, supportedConditions) surface `projects-api` enforces
 * server-side. `../seed.ts`'s `seedProjectsCatalog` registers it via
 * `upsertAppCatalog` (one full-replace upsert keyed by `appId`).
 *
 * Three resources:
 *   - the app-access resource (`projects`) — `access`, no conditions. Gates the
 *     tool AND is the whole read capability: every holder reads every project
 *     and contract (D13). `projects` is registered ONLY here, never also through
 *     `SUITE_APPS` (a second full-replace registration would prune it).
 *   - `project` — `manage`, supporting the `entity` condition (ADR-0015): create
 *     and edit projects, their team and contracts, and move their states, for the
 *     holder's own entity, or both when unconditioned.
 *   - `contract` — `bexio`, no conditions: write a contract's Bexio order id
 *     (held by `accounting`, D35).
 *
 * Declaration only: the role grants are `seedProjectsGrants`, a separate step.
 */

import type { AppCatalogInput } from "../catalog";

/** The projects module's app id across the Operai suite catalog/role system. */
export const PROJECTS_APP_ID = "projects";

export const PROJECTS_CATALOG: AppCatalogInput = {
  appId: PROJECTS_APP_ID,
  resources: [
    {
      key: PROJECTS_APP_ID,
      label: "Projects",
      actions: [{ key: "access", label: "Access", supportedConditions: [] }],
    },
    {
      key: "project",
      label: "Project",
      actions: [{ key: "manage", label: "Manage", supportedConditions: ["entity"] }],
    },
    {
      key: "contract",
      label: "Contract",
      actions: [{ key: "bexio", label: "Set the Bexio order id", supportedConditions: [] }],
    },
  ],
};
