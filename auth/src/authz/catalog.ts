/**
 * Permission catalog module (T5, specs/004-auth-roles-permissions — refs
 * AC-3.1, AC-3.2, AC-3.3, plan.md "Catalog registration" + ADR-0007 §7).
 *
 * Each app in the Operai suite ships a typed catalog declaration (resources
 * → actions → the condition types each action supports) and registers it
 * idempotently via `PUT /authz/catalog` (`catalog.routes.ts`). The catalog
 * is the ONLY source of truth for which (resource, action) pairs a
 * `permission_rule` may reference (AC-2.1/3.2) and which condition kinds a
 * rule against that pair may use (AC-2.3) — an app that never declared a
 * permission can never have a role rule written against it.
 *
 * `permission_rule.resource`/`.action` are plain strings, NOT foreign keys
 * into `catalog_resource`/`catalog_action` (ADR-0007 §7: apps are
 * independently deployable and register their catalog over HTTP, so a rule
 * and its declaring app's catalog entry are never in the same migration or
 * even necessarily the same database). Off-catalog rejection is therefore a
 * query against the catalog tables (`isKnownPermission`/
 * `isConditionSupported` below), not a DB constraint — T8's
 * `PUT /admin/roles/:id/rules` is the intended caller.
 */

import { db } from "../lib/db";
import type { Prisma, PrismaClient } from "../lib/generated/prisma/client";

// A catalog write may run inside a caller's transaction or against the
// default singleton (mirrors resolver.ts's `PrismaClientLike`).
type PrismaClientLike = PrismaClient | Prisma.TransactionClient;

// ─── Types ────────────────────────────────────────────────────────────────────

/** One action declared on a resource, as an app submits it to `PUT /authz/catalog`. */
export interface CatalogActionInput {
  /** e.g. `view`/`create`/`edit`/`delete`/`approve`/`access`. */
  key: string;
  label: string;
  /** Condition kinds a rule against this (resource, action) may use, e.g. `["ownership", "entity"]`. */
  supportedConditions: string[];
}

/** One resource declared by an app, with the actions it supports. */
export interface CatalogResourceInput {
  /** e.g. `estimate`, or the app id itself for the app-access resource. */
  key: string;
  label: string;
  actions: CatalogActionInput[];
}

/** The full body of `PUT /authz/catalog` — one app's entire catalog. */
export interface AppCatalogInput {
  /** The declaring app, e.g. `estimai`. */
  appId: string;
  resources: CatalogResourceInput[];
}

export interface CatalogActionView {
  key: string;
  label: string;
  supportedConditions: string[];
}

export interface CatalogResourceView {
  key: string;
  label: string;
  actions: CatalogActionView[];
}

/** One app's catalog, as read back (`GET /admin/catalog` groups these by app). */
export interface AppCatalogView {
  appId: string;
  resources: CatalogResourceView[];
}

// ─── Registration (write) ────────────────────────────────────────────────────

/**
 * Idempotent, full-replace upsert of ONE app's catalog into
 * `catalog_resource`/`catalog_action` (T5, AC-3.1). "Full replace" means the
 * app's catalog in the DB is made to match `input` exactly: resources/actions
 * present in `input` are created or updated in place (preserving their ids,
 * so any `permission_rule` that happens to reference them by (resource,
 * action) string is unaffected); resources/actions previously registered for
 * this `appId` but no longer present in `input` are deleted. Re-submitting
 * the identical catalog is therefore a true no-op on the resulting state
 * (idempotent — the task's `done when`).
 *
 * Runs as a single transaction so a partial write (e.g. failing halfway
 * through a large catalog) never leaves the app's catalog in a mixed
 * old/new state.
 */
export async function upsertAppCatalog(input: AppCatalogInput): Promise<AppCatalogView> {
  return db.$transaction(async (tx) => {
    const keptResourceIds: string[] = [];

    for (const resource of input.resources) {
      const resourceRow = await tx.catalogResource.upsert({
        where: { appId_key: { appId: input.appId, key: resource.key } },
        update: { label: resource.label },
        create: { appId: input.appId, key: resource.key, label: resource.label },
      });
      keptResourceIds.push(resourceRow.id);

      const keptActionIds: string[] = [];
      for (const action of resource.actions) {
        const actionRow = await tx.catalogAction.upsert({
          where: { resourceId_key: { resourceId: resourceRow.id, key: action.key } },
          update: {
            label: action.label,
            supportedConditions: action.supportedConditions,
          },
          create: {
            resourceId: resourceRow.id,
            key: action.key,
            label: action.label,
            supportedConditions: action.supportedConditions,
          },
        });
        keptActionIds.push(actionRow.id);
      }

      // Prune actions no longer declared for this resource. An empty
      // `keptActionIds` (a resource submitted with zero actions) correctly
      // deletes every existing action for it — Prisma's `notIn: []`
      // excludes nothing, so nothing is spared.
      await tx.catalogAction.deleteMany({
        where: { resourceId: resourceRow.id, id: { notIn: keptActionIds } },
      });
    }

    // Prune resources no longer declared for this app at all.
    await tx.catalogResource.deleteMany({
      where: { appId: input.appId, id: { notIn: keptResourceIds } },
    });

    return getAppCatalog(input.appId, tx);
  });
}

// ─── Reads ────────────────────────────────────────────────────────────────────

/** One app's registered catalog (resources + actions + supportedConditions), sorted for determinism. */
export async function getAppCatalog(
  appId: string,
  client: PrismaClientLike = db,
): Promise<AppCatalogView> {
  const resources = await client.catalogResource.findMany({
    where: { appId },
    orderBy: { key: "asc" },
    include: { actions: { orderBy: { key: "asc" } } },
  });

  return { appId, resources: resources.map(toResourceView) };
}

/**
 * The full catalog across every registered app, grouped by `appId`
 * (T5, AC-3.1/3.3 — the shape the admin rule-builder consumes). Apps with
 * no registered resources are simply absent (there is nothing to group).
 */
export async function getFullCatalog(
  client: PrismaClientLike = db,
): Promise<AppCatalogView[]> {
  const resources = await client.catalogResource.findMany({
    orderBy: [{ appId: "asc" }, { key: "asc" }],
    include: { actions: { orderBy: { key: "asc" } } },
  });

  const byApp = new Map<string, CatalogResourceView[]>();
  for (const resource of resources) {
    const existing = byApp.get(resource.appId);
    if (existing) {
      existing.push(toResourceView(resource));
    } else {
      byApp.set(resource.appId, [toResourceView(resource)]);
    }
  }

  return Array.from(byApp.entries()).map(([appId, resourceViews]) => ({
    appId,
    resources: resourceViews,
  }));
}

function toResourceView(resource: {
  key: string;
  label: string;
  actions: { key: string; label: string; supportedConditions: string[] }[];
}): CatalogResourceView {
  return {
    key: resource.key,
    label: resource.label,
    actions: resource.actions.map((action) => ({
      key: action.key,
      label: action.label,
      supportedConditions: action.supportedConditions,
    })),
  };
}

// ─── Validation (T8's off-catalog gate, AC-2.1/3.2) ─────────────────────────

/**
 * Whether (resource, action) is a known catalog entry — registered by ANY
 * app, since `permission_rule` does not carry an `appId` (see module doc
 * comment). This is the primary gate `PUT /admin/roles/:id/rules` (T8) must
 * apply to every rule before persisting it: a rule referencing a pair no
 * app ever declared is rejected with `422` (AC-2.1/AC-3.2).
 */
export async function isKnownPermission(
  resource: string,
  action: string,
  client: PrismaClientLike = db,
): Promise<boolean> {
  const match = await client.catalogAction.findFirst({
    where: { key: action, resource: { key: resource } },
    select: { id: true },
  });
  return match !== null;
}

/**
 * Whether `condition` (`"ownership"`, or an attribute key such as
 * `"entity"`/`"department"`/`"jobTitle"`) is declared as supported for
 * (resource, action) in the catalog (AC-2.3). Returns `false` — not a
 * thrown error — when (resource, action) itself is unknown; callers that
 * need to distinguish "unknown permission" from "known permission, but this
 * condition isn't declared for it" should call {@link isKnownPermission}
 * first (T8's `422` messaging is expected to do exactly that).
 */
export async function isConditionSupported(
  resource: string,
  action: string,
  condition: string,
  client: PrismaClientLike = db,
): Promise<boolean> {
  const match = await client.catalogAction.findFirst({
    where: { key: action, resource: { key: resource } },
    select: { supportedConditions: true },
  });
  return match?.supportedConditions.includes(condition) ?? false;
}
