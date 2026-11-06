/**
 * The projects module's declared permission catalog (specs/021-projects — AC-4.1,
 * AC-4.3–4.6; ADR-0058; reshaped by specs/022-projects-handoff — AC-1.1, AC-1.9,
 * AC-3.4, AC-4.1, AC-4.8).
 *
 * Mirrors `catalogs/crm.ts`'s shape: a plain constant describing the
 * (resource, action, supportedConditions) surface `projects-api` enforces
 * server-side. `../seed.ts`'s `seedProjectsCatalog` registers it via
 * `upsertAppCatalog` (one full-replace upsert keyed by `appId`).
 *
 * Four resources, five capabilities:
 *   - the app-access resource (`projects`) — `access`, no conditions. Gates the
 *     tool AND is the whole read capability: every holder reads every project
 *     and its terms (D13). `projects` is registered ONLY here, never also through
 *     `SUITE_APPS` (a second full-replace registration would prune it).
 *   - `project` — `manage`, supporting the `entity` condition (ADR-0015): create
 *     and edit projects, their terms, referent and team, and move their states,
 *     for the holder's own entity, or both when unconditioned.
 *   - `purchase-order` — `bexio` (no conditions: write a purchase order's Bexio
 *     order id, held by `accounting`; was `contract:bexio`, D35) and `receive`
 *     (entity: be the ops-manager of a won deal's purchase order — ops-manager
 *     own entity, `admin` unconditioned as the override of D47).
 *   - `handoff` — `take` (entity): read the hand-off queue and take a won deal
 *     into a project — `sales` own entity, `admin` unconditioned.
 *
 * There is deliberately no `contract` resource any more: "contract" is retired
 * (D38); what a project has is its terms and, when it came from a won deal, a
 * purchase order.
 *
 * Resource keys stay unique across catalogs: the resolver keys grants by
 * `(resource, action)` without the app id, and the directory gate
 * (`DIRECTORY_GATE_PERMISSIONS`) matches `project:manage` the same way.
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
      key: "purchase-order",
      label: "Purchase order",
      actions: [
        { key: "bexio", label: "Set the Bexio order id", supportedConditions: [] },
        { key: "receive", label: "Receive purchase orders (be their ops-manager)", supportedConditions: ["entity"] },
      ],
    },
    {
      key: "handoff",
      label: "Hand-off",
      actions: [{ key: "take", label: "Take a won deal into a project", supportedConditions: ["entity"] }],
    },
  ],
};
