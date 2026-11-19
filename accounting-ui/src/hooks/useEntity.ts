/**
 * useEntity — which entity the page shows, and what the frame lets a page do about it (specs/20261119-accounting,
 * design UX-2, UX-4, UX-12, UX-15, AS2).
 *
 * `resolveEntity` is the one decision about the `?entity=` search parameter, made from the entities `GET /v1/me` says
 * the person covers (the browser evaluates no grant):
 *
 *   absent                       → `default`: the first covered entity (WellD CH first); the URL is left alone
 *   an entity the person covers  → `given`
 *   not an entity id at all      → `fallback`: the first covered entity, and the frame rewrites the URL (`replace`)
 *   a known entity not covered   → `not_found`: the not-found view, never the other entity's data and never a silent
 *                                  substitution (AC-3.5, UX-12) — showing CH when the address said Italia would be a
 *                                  misattribution, which matters more in accounting than anywhere
 *
 * `AccountingContext` is what `AccountingShell` hands to the pages. The displayed entity's `canManage` is the ONLY source of a
 * write control (UX-4); `usePermissions()` says whether a grant exists, not for which entity.
 */
import { createContext, useContext } from 'react'
import { isEntityId } from '../lib/meApi'
import type { EntityId, Me, MeEntity } from '../lib/meApi'

export type EntityResolution =
  | { kind: 'given'; entity: MeEntity }
  | { kind: 'default'; entity: MeEntity }
  | { kind: 'fallback'; entity: MeEntity }
  | { kind: 'not_found'; requested: EntityId }
  | { kind: 'none' }

/** Resolves the raw `?entity=` value against the covered entities. No covered entity at all is `none` (the frame shows denied). */
export function resolveEntity(entities: readonly MeEntity[], raw: unknown): EntityResolution {
  const first = entities[0]
  if (first === undefined) return { kind: 'none' }
  if (raw === undefined || raw === null || raw === '') return { kind: 'default', entity: first }
  if (!isEntityId(raw)) return { kind: 'fallback', entity: first }
  const covered = entities.find((candidate) => candidate.entity === raw)
  return covered ? { kind: 'given', entity: covered } : { kind: 'not_found', requested: raw }
}

/** What the frame says after it re-read `/v1/me` on a page's behalf. */
export type Notice = { kind: 'lost'; was: EntityId; now: EntityId } | { kind: 'access' }

/** Why a page asked for the re-read: a list answered 404 (`gone`), a write answered 403 (`refused`). */
export type RereadReason = 'gone' | 'refused'

/** The one note a re-read earns, from what was displayed and what `/v1/me` says now (null: nothing to say). */
export function noticeAfterReread(
  reason: RereadReason,
  before: { entity: EntityId; canManage: boolean },
  fresh: Me,
): Notice | null {
  const still = fresh.entities.find((candidate) => candidate.entity === before.entity)
  const first = fresh.entities[0]
  if (!still) return first ? { kind: 'lost', was: before.entity, now: first.entity } : null
  if (reason === 'refused' && still.canManage !== before.canManage) return { kind: 'access' }
  return null
}

export interface AccountingContextValue {
  /** Every covered entity, WellD CH first. One entity means no switch. */
  entities: readonly MeEntity[]
  /** The displayed entity: its `canManage` decides every write control. */
  entity: MeEntity
  /** Shows another covered entity: writes `?entity=` with `replace` (design UX-2) and drops `?month=`, which belongs to the one it was addressed to. */
  selectEntity: (id: EntityId) => void
  /**
   * A list answered 404 for the displayed entity (a grant narrowed during the session, UX-12): re-reads `/v1/me`, falls back to
   * the first entity still covered and says so once.
   */
  entityGone: () => void
  /**
   * A write answered 403 `accounting_manage_required` (UX-15, AC-3.4): re-reads `/v1/me` so that a control that should not be
   * there disappears. The card says "You don't have permission to do this." itself.
   */
  writeRefused: () => void
}

export const AccountingContext = createContext<AccountingContextValue | null>(null)

/** The displayed entity and the frame's callbacks. Only inside `AccountingShell`. */
export function useEntity(): AccountingContextValue {
  const value = useContext(AccountingContext)
  if (value === null) throw new Error('useEntity must be used inside AccountingShell')
  return value
}
