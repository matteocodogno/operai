/**
 * The shapes of letterhead-api's person routes that the tool's frame reads (plan § Person routes and
 * Amendment G2, G4). The configurator's own shapes (the config, versions, problems) are added with the
 * form (T21).
 */

/** The two entities of the suite, as letterhead-api names them. */
export const ENTITIES = ['welld_it', 'welld_ch'] as const
export type Entity = (typeof ENTITIES)[number]

/**
 * One entity in `GET /v1/letterheads` (G4, G10): the active version (`null` before the first save) and
 * whether the caller may change this entity's letterhead (`canManage`, computed by the service from
 * `/authz/resolve`; the browser never evaluates conditions itself).
 */
export interface EntitySummary {
  activeVersion: number | null
  canManage: boolean
}

/** `GET /v1/letterheads`: both entities, always. */
export type LetterheadList = Record<Entity, EntitySummary>

/**
 * `GET /v1/catalog`: the closed lists the form offers (fonts, placeholders, named styles, bounds, the
 * escape help) and `defaultConfig`, the starting values of an entity with no letterhead (G2). The form
 * (T21) narrows this type; the frame only holds it.
 */
export type Catalog = Readonly<Record<string, unknown>>

/**
 * `issuerDetails` of a configurator preview answer (specs/20261117-legal-entities AC-5.4, plan E3): `current` when
 * the registry's details of the entity were read, `unavailable` when they could not be (the preview is still made,
 * with every issuer placeholder in the "missing" look).
 */
export type IssuerDetails = 'current' | 'unavailable'
