import { createContext, useContext } from 'react'
import type { Entity, Scope } from '../lib/types'

/**
 * The caller's projects scope (`GET /scope`), loaded once by `ProjectsShell` and
 * read by every page: which entities `project:manage` covers, whether that is
 * every entity (the admin), and whether they may write a contract's Bexio order
 * id. UX only — the server's 403 is the gate (ADR-0014). The default is "may
 * manage nothing", so a control gated on it never appears before the scope is
 * known.
 */
export const ScopeContext = createContext<Scope>({ manage: [], managesAll: false, bexio: false })

export type ScopeCapabilities = {
  /** Entities the caller may create and edit projects and contracts for; empty = read-only. */
  manage: readonly Entity[]
  canManage: boolean
  canManageEntity: (entity: Entity) => boolean
  managesAll: boolean
  /** `contract:bexio`: may set, change or clear a contract's Bexio order id (AC-3.1). */
  bexio: boolean
}

export function useScope(): ScopeCapabilities {
  const scope = useContext(ScopeContext)
  return {
    manage: scope.manage,
    canManage: scope.manage.length > 0,
    canManageEntity: (entity) => scope.manage.includes(entity),
    managesAll: scope.managesAll,
    bexio: scope.bexio,
  }
}
