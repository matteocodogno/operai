/**
 * Pure, DB-free authorization-condition helpers (T7, specs/015-hardware-
 * inventory, ADR-0014 point 3 + ADR-0015; AC-9.4, AC-9.5).
 *
 * `auth`'s resolver persists and surfaces `conditions` on each permission but
 * NEVER evaluates them against a real record — that is the consuming app's job
 * (ADR-0007 point 6, ADR-0014). These are inventory-api's evaluators, ported
 * from refund-api/src/authz/conditions.ts and re-pointed at this tool's one
 * condition: the entity.
 *
 *   - `hasCapability` / `findPermission`  does the resolved set contain the grant?
 *   - `scopeFor`                          which entities does a grant cover?
 *   - `assetInScope`                      is this asset inside such a set?
 *
 * Unlike refund (ADR-0015: "at least one LINE's entity matches"), scope here is
 * evaluated per ASSET and is exact: an asset has exactly one entity for its
 * whole life (AC-1.9, `entity` is immutable), so there is no "at least one" to
 * reason about.
 *
 * Denials built on these follow ADR-0014: capability absent → 403; asset out of
 * scope → 404 (no existence leak).
 */

import type { ResolveConditions, ResolvedPermission } from "./resolveClient";

/** The wellD legal entities, in a fixed order so scope lists are stable. */
export const ENTITIES = ["welld_ch", "welld_it"] as const;
export type Entity = (typeof ENTITIES)[number];

export const isEntity = (value: unknown): value is Entity =>
  typeof value === "string" && (ENTITIES as readonly string[]).includes(value);

// ─── Capability check ──────────────────────────────────────────────────────

/**
 * Whether the resolved permission set contains a grant for `(resource, action)`
 * AT ALL, regardless of attached conditions. A missing capability is a
 * wholesale 403, never a 404.
 */
export function hasCapability(
  permissions: readonly ResolvedPermission[],
  resource: string,
  action: string,
): boolean {
  return permissions.some(
    (permission) =>
      permission.resource === resource && permission.action === action,
  );
}

/** The first `(resource, action)` grant, with its conditions, if any. */
export function findPermission(
  permissions: readonly ResolvedPermission[],
  resource: string,
  action: string,
): ResolvedPermission | undefined {
  return permissions.find(
    (permission) =>
      permission.resource === resource && permission.action === action,
  );
}

// ─── Entity scope (ADR-0015, reused by plan.md § Authorization model) ──────

/**
 * Whether a grant's conditions narrow it to the caller's own entity —
 * `{key:"entity", match:"user"}` in `attributes[]`.
 *
 * Only this one attribute is understood. The catalog declares
 * `supportedConditions: ["entity"]` for `asset:manage` and `ledger:manage`
 * (auth/src/authz/catalogs/inventory.ts), so the admin API cannot attach
 * anything else to them; a condition this function does not recognise is
 * therefore treated as no entity restriction, exactly as ADR-0015 /
 * refund-api's `entityScopeForPermission` do.
 */
function isEntityConditioned(conditions: ResolveConditions | null): boolean {
  return (
    conditions?.attributes?.some(
      (attribute) => attribute.key === "entity" && attribute.match === "user",
    ) ?? false
  );
}

/**
 * The entities the caller may act on through `(resource, action)`:
 *
 *   - no such grant                              → `[]`
 *   - unconditioned grant                        → both entities
 *   - entity-conditioned, caller has an entity   → `[callerEntity]`
 *   - entity-conditioned, `callerEntity` is null → `[]` (R-7: fail closed on a
 *     data-integrity edge the admin GUI should prevent — never "everything")
 *
 * Several grants of the same pair are unioned, widest wins (ADR-0007): a
 * conditioned one plus an unconditioned one covers both entities. `auth`'s
 * resolver already de-duplicates, so this is defence in depth, not the main
 * path. The result is in the fixed `ENTITIES` order with no duplicates.
 */
export function scopeFor(
  permissions: readonly ResolvedPermission[],
  resource: string,
  action: string,
  callerEntity: string | null,
): Entity[] {
  const covered = new Set<Entity>();

  for (const permission of permissions) {
    if (permission.resource !== resource || permission.action !== action) {
      continue;
    }
    if (!isEntityConditioned(permission.conditions)) {
      return [...ENTITIES];
    }
    // A callerEntity that is not one of ours (corrupt attribute) matches nothing.
    if (isEntity(callerEntity)) covered.add(callerEntity);
  }

  return ENTITIES.filter((entity) => covered.has(entity));
}

/** Whether `asset` falls inside `scope` (the result of `scopeFor`). */
export function assetInScope(
  asset: { readonly entity: string },
  scope: readonly Entity[],
): boolean {
  return (scope as readonly string[]).includes(asset.entity);
}
