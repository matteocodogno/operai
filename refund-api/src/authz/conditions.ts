/**
 * Pure, DB-free authorization-condition helpers (T6, specs/007-refund-service,
 * ADR-0014 point 3 + ADR-0015).
 *
 * `auth`'s resolver (T1's `GET /authz/resolve`) persists and surfaces
 * `conditions` on each permission but NEVER evaluates them against a real
 * record — that has always been the consuming app's job (ADR-0007 point 6,
 * reaffirmed by ADR-0014). These are refund-api's own evaluators:
 *
 *   - `hasCapability`   — does the resolved permission set contain the grant
 *                          at all? (403 if not — capability check.)
 *   - `ownershipOwn`    — does a record's owner match the caller? (`ownership:own`)
 *   - `requestInScope`  — ADR-0015's entity-scope predicate: "at least one
 *                          line's entity matches the caller's entity; an
 *                          unconditioned/global grant sees everything."
 *
 * No route wiring here (T7+ is out of scope for T6) — these are exercised
 * directly by unit tests and, in a real route, would back a 404 (record-level
 * denial, ADR-0005/0014 "not yours = not found") rather than a 403.
 */

import type { ResolveConditions, ResolvedPermission } from "./resolveClient";

// ─── Capability check ──────────────────────────────────────────────────────

/**
 * Whether the resolved permission set contains a grant for
 * `(resource, action)` AT ALL, regardless of any attached conditions.
 * A missing capability is a wholesale 403 (e.g. `/review/*` — ADR-0014
 * point 3), never a 404.
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

/**
 * Returns the specific `(resource, action)` grant, if any — needed by
 * `entityScopeForPermission` (and by future route handlers) to inspect
 * *which* conditions (if any) are attached to a capability the caller does
 * hold. Returns `undefined` when the caller has no such grant at all (in
 * which case `hasCapability` has already/would already deny with 403 before
 * this is ever consulted).
 */
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

// ─── Ownership condition (`ownership:own`) ─────────────────────────────────

/**
 * Whether `record` is owned by `sub` — the local evaluation of the
 * `ownership:own` condition (ADR-0014 point 3). A caller's own requests
 * (`request:create`/`request:read`, ownership:own) are scoped this way;
 * a mismatch is a record-level 404 (ADR-0005's "not yours = not found"),
 * never a 403.
 */
export function ownershipOwn(
  record: { readonly ownerUserId: string },
  sub: string,
): boolean {
  return record.ownerUserId === sub;
}

// ─── Entity-scope predicate (ADR-0015) ─────────────────────────────────────

/**
 * Sentinel marking "no entity restriction" (an unconditioned `review`/
 * `approve`/`reject`/`set-approved-total` grant — ADR-0015 point 1/4,
 * composed via the resolver's widest-wins union, never a seeded role). A
 * `Symbol` (rather than the string `"global"`) is used deliberately so this
 * can never collide with a real `Entity` enum value on the wire.
 */
export const GLOBAL_ENTITY_SCOPE = Symbol("refund-api:global-entity-scope");

/** The second argument to `requestInScope`: either a single entity value, or `GLOBAL_ENTITY_SCOPE`. */
export type EntityScope = string | typeof GLOBAL_ENTITY_SCOPE;

/**
 * ADR-0015's request-level entity-scope predicate: "at least one line's
 * entity matches the caller's `user.entity`; an unconditioned (global) grant
 * sees everything." Used identically for queue visibility (AC-5.1/5.5/5.6)
 * and record-level access (AC-6.4/6.5) — the SAME predicate backs both
 * surfaces so they cannot silently desync (ADR-0015 Risks).
 *
 * A request with zero lines never matches a single-entity scope (there is
 * nothing to match against) — only a global scope sees it. This mirrors
 * `Array.prototype.some` on an empty array (`false`), which is exactly what
 * this function delegates to.
 */
export function requestInScope(
  lines: readonly { readonly entity: string }[],
  callerEntityOrGlobal: EntityScope,
): boolean {
  if (callerEntityOrGlobal === GLOBAL_ENTITY_SCOPE) return true;
  return lines.some((line) => line.entity === callerEntityOrGlobal);
}

/**
 * Bridges a resolved permission's `conditions` to the `EntityScope` value
 * `requestInScope` expects (ADR-0015 point 1: "which case applies is
 * determined entirely by what the resolver returns for that permission").
 *
 * - No entity attribute condition on the grant → `GLOBAL_ENTITY_SCOPE`
 *   (unconditioned = every submitted request, AC-5.5).
 * - An entity attribute condition (`{key:"entity", match:"user"}`) → the
 *   caller's own `entity` (from `/authz/resolve`'s response) — single-entity
 *   scope (AC-5.6/6.4).
 * - A conditioned grant but the caller has no `entity` attribute set
 *   (`null`) → `null`: there is no value this scope could ever match, so the
 *   caller is scoped to nothing (fail-closed on a data-integrity edge case
 *   the admin GUI should prevent, not a spec-defined state).
 */
export function entityScopeForPermission(
  conditions: ResolveConditions | null,
  callerEntity: string | null,
): EntityScope | null {
  const hasEntityCondition = conditions?.attributes?.some(
    (attribute) => attribute.key === "entity" && attribute.match === "user",
  );

  if (!hasEntityCondition) return GLOBAL_ENTITY_SCOPE;
  return callerEntity;
}
