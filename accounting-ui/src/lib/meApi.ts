/**
 * meApi — `GET /v1/me`, the one read the frame makes (specs/20261119-accounting, plan § API contracts, AC-8.2).
 *
 *   200 { entities: [ { entity, ownCurrency, canManage, rateSource: "bazg" | null } ] }   covered entities, welld_ch first
 *   403 { code: "accounting_forbidden" }                                                 no read for any entity (AC-3.6)
 *
 * The browser never evaluates a grant's entity condition (ADR 20261117-an-app-is-reachable-…, point 4): which entities
 * the person covers, and whether they may manage each, is what the server says here, and write controls follow
 * `canManage` of the DISPLAYED entity, never `usePermissions()` (design UX-4).
 *
 * The answer is read defensively. An entity id this build does not know is dropped (it has no name in the catalog and
 * no page), and the order is the catalog's (WellD CH first) whatever the server sent; a body without a list reads as
 * "no entity", which the frame treats as denied (design AS1: "or an empty entity list").
 */
import { getJson } from './api'

/** The entities of the suite's legal-entity registry, in display order (the plan's `ENTITIES`). */
export const ENTITY_IDS = ['welld_ch', 'welld_it'] as const

export type EntityId = (typeof ENTITY_IDS)[number]

export const isEntityId = (value: unknown): value is EntityId =>
  typeof value === 'string' && (ENTITY_IDS as readonly string[]).includes(value)

export interface MeEntity {
  entity: EntityId
  /** The entity's own currency (CHF, EUR): the unit rates are quoted in. */
  ownCurrency: string
  /** The person may add, deactivate, reactivate, fetch and correct for this entity (manage includes read). */
  canManage: boolean
  /** Where the entity's rates come from; null for an entity with no official source yet (AC-2.11). */
  rateSource: 'bazg' | null
}

export interface Me {
  entities: MeEntity[]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Reads a `/v1/me` body into a `Me`, dropping anything it cannot vouch for. */
export function readMe(body: unknown): Me {
  const raw = isRecord(body) && Array.isArray(body.entities) ? body.entities : []
  const known = new Map<EntityId, MeEntity>()
  for (const item of raw) {
    if (!isRecord(item) || !isEntityId(item.entity) || known.has(item.entity)) continue
    known.set(item.entity, {
      entity: item.entity,
      ownCurrency: typeof item.ownCurrency === 'string' ? item.ownCurrency : '',
      // Fail closed: only a literal `true` shows a write control.
      canManage: item.canManage === true,
      rateSource: item.rateSource === 'bazg' ? 'bazg' : null,
    })
  }
  return { entities: ENTITY_IDS.flatMap((id) => known.get(id) ?? []) }
}

/** The covered entities with `canManage` for each. A 403 `accounting_forbidden` is an `ApiError` the caller handles. */
export const getMe = async (init?: RequestInit): Promise<Me> => readMe(await getJson<unknown>('/v1/me', init))
