/**
 * Which legal entities a person may manage (specs/20261117-legal-entities, plan decisions 4 and 5, ADR
 * 20261117-an-app-is-reachable-through-a-capability-it-administers...).
 *
 * One coverage function for everyone: the management routes, `GET /legal-entities/manageable` and the
 * `admin` entry that `GET /authz/me` derives into `apps` all answer "who may manage which entity" through
 * `entityGrantFor` (authz/resolver.ts), so the page's reachability and the routes' authorisation cannot drift.
 * It fails closed: a grant carrying a condition `grantKind` does not recognise covers nothing, and a user
 * with no entity (or one outside `LEGAL_ENTITIES`) is covered only by an unconditioned grant.
 *
 * Presentation only: `adminAreaReachable` is what lets the shell show the Admin tool (and, through the
 * `DERIVED_APPS` table, accounting's `read`/`manage` coverage lets it show Accounting). It is not "is an
 * administrator" - the admin APIs keep `requireAdmin`.
 */

import { entityGrantFor, type EffectivePermission } from "../authz/resolver";
import { db } from "../lib/db";
import { LEGAL_ENTITIES, type LegalEntity } from "./entities";

export const LEGAL_ENTITY_RESOURCE = "legal-entity";
export const LEGAL_ENTITY_MANAGE_ACTION = "manage";

/** One `(resource, action)` pair whose entity coverage counts. */
export interface EntityGrantRef {
  readonly resource: string;
  readonly action: string;
}

/**
 * The entities in which at least ONE of `grants` covers `user`, in `LEGAL_ENTITIES` order (stable for the API).
 * Every caller that asks "which entities does this person cover" goes through here, so each answer is
 * `entityGrantFor`'s: an unconditioned grant covers both entities, `{key:"entity", match:"user"}` covers the
 * user's own entity, anything else covers nothing. A union of several grants (Accounting's `read` or `manage`,
 * specs/20261119-accounting, AC-3.2) is one call, not two functions that could drift.
 */
export function entitiesCoveredByAny(
  permissions: readonly EffectivePermission[],
  user: { readonly entity: string | null },
  grants: readonly EntityGrantRef[],
): LegalEntity[] {
  return LEGAL_ENTITIES.filter((entity) =>
    grants.some((grant) => entityGrantFor(permissions, grant.resource, grant.action, user, entity) !== null),
  );
}

/** The `(resource, action)` the Admin tool is derived from (specs/20261117-legal-entities). */
export const LEGAL_ENTITY_MANAGE_GRANT: EntityGrantRef = {
  resource: LEGAL_ENTITY_RESOURCE,
  action: LEGAL_ENTITY_MANAGE_ACTION,
};

/** The entities `permissions` let `user` manage, in `LEGAL_ENTITIES` order (stable for the API). */
export function coveredEntities(
  permissions: readonly EffectivePermission[],
  user: { readonly entity: string | null },
): LegalEntity[] {
  return entitiesCoveredByAny(permissions, user, [LEGAL_ENTITY_MANAGE_GRANT]);
}

/**
 * Whether the person may manage at least one entity, hence reaches the administration area (AC-4.3). One row of
 * `DERIVED_APPS` (`../authz/derivedApps.ts`), which is what `GET /authz/me` reads; kept as a named function for
 * the callers and tests that ask only this question.
 */
export function adminAreaReachable(
  permissions: readonly EffectivePermission[],
  user: { readonly entity: string | null },
): boolean {
  return coveredEntities(permissions, user).length > 0;
}

/**
 * The profile the registry evaluates a person's grants against, or null when there is no such person or the person
 * is soft-deleted (F2, plan G8). A better-auth session outlives the soft delete (cookie cache, Bearer token), so
 * every registry route that answers "who is this person" asks here instead of trusting the session alone: a
 * deleted person is refused everywhere (403 on the management routes, `{ entities: [] }` on `manageable`, 401 on
 * the person reads), whatever grants they still hold.
 */
export async function activeUserProfile(userId: string): Promise<{ entity: string | null } | null> {
  const row = await db.user.findUnique({ where: { id: userId }, select: { entity: true, deletedAt: true } });
  if (row === null || row.deletedAt !== null) return null;
  return { entity: row.entity };
}
