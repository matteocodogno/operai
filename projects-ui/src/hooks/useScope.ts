import { createContext, useContext } from 'react'
import type { Entity, Scope } from '../lib/types'

/**
 * The caller's projects scope (`GET /scope`), loaded once by `ProjectsShell` and
 * read by every page: which entities `project:manage` covers, whether that is
 * every entity (the admin), whether they may write a purchase order's Bexio
 * order id, which entities' won deals they may take (`handoff:take`) and whether
 * they oversee every purchase order (`purchase-order:receive` unconditioned).
 * UX only — the server's 403 is the gate (ADR-0014). The default is "may do
 * nothing", so a control gated on it never appears before the scope is known.
 */
export const ScopeContext = createContext<Scope>({
  manage: [],
  managesAll: false,
  bexio: false,
  take: [],
  oversees: false,
})

export type ScopeCapabilities = {
  /** Entities the caller may create and edit projects, terms and purchase orders for; empty = read-only. */
  manage: readonly Entity[]
  canManage: boolean
  canManageEntity: (entity: Entity) => boolean
  managesAll: boolean
  /** `purchase-order:bexio`: may set, change or clear a purchase order's Bexio order id (AC-3.1). */
  bexio: boolean
  /** Entities whose won deals the caller may take; empty = no "To start" queue at all (AC-1.9). */
  take: readonly Entity[]
  canTake: boolean
  canTakeEntity: (entity: Entity) => boolean
  /** May pick the project manager of any purchase order awaiting one, in the ops-manager's place (D47). */
  oversees: boolean
}

export function useScope(): ScopeCapabilities {
  const scope = useContext(ScopeContext)
  return {
    manage: scope.manage,
    canManage: scope.manage.length > 0,
    canManageEntity: (entity) => scope.manage.includes(entity),
    managesAll: scope.managesAll,
    bexio: scope.bexio,
    take: scope.take,
    canTake: scope.take.length > 0,
    canTakeEntity: (entity) => scope.take.includes(entity),
    oversees: scope.oversees,
  }
}
