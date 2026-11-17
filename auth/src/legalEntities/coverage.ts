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
 * Presentation only: `adminAreaReachable` is what lets the shell show the Admin tool. It is not "is an
 * administrator" - the admin APIs keep `requireAdmin`.
 */

import { entityGrantFor, type EffectivePermission } from "../authz/resolver";
import { LEGAL_ENTITIES, type LegalEntity } from "./entities";

export const LEGAL_ENTITY_RESOURCE = "legal-entity";
export const LEGAL_ENTITY_MANAGE_ACTION = "manage";

/** The entities `permissions` let `user` manage, in `LEGAL_ENTITIES` order (stable for the API). */
export function coveredEntities(
  permissions: readonly EffectivePermission[],
  user: { readonly entity: string | null },
): LegalEntity[] {
  return LEGAL_ENTITIES.filter(
    (entity) =>
      entityGrantFor(permissions, LEGAL_ENTITY_RESOURCE, LEGAL_ENTITY_MANAGE_ACTION, user, entity) !== null,
  );
}

/** Whether the person may manage at least one entity, hence reaches the administration area (AC-4.3). */
export function adminAreaReachable(
  permissions: readonly EffectivePermission[],
  user: { readonly entity: string | null },
): boolean {
  return coveredEntities(permissions, user).length > 0;
}
