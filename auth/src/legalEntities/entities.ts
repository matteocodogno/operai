/**
 * The one list of legal entities (specs/20261117-legal-entities, plan "Data model").
 *
 * `legal_entity_version.entity` CHECKs the same two values in SQL; `ENTITY_VALUES` of
 * `admin/users.routes.ts` imports this constant. A third entity changes the CHECK, this
 * constant and the user-entity enum together, by a migration (ADR
 * 20261117-legal-entity-registry-in-auth-is-append-only-versions-immutable-in-the-database,
 * escalation triggers).
 */
export const LEGAL_ENTITIES = ["welld_it", "welld_ch"] as const;

export type LegalEntity = (typeof LEGAL_ENTITIES)[number];
