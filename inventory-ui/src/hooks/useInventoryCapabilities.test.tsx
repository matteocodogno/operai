/**
 * @vitest-environment jsdom
 *
 * useInventoryCapabilities (T28, specs/015-hardware-inventory; design.md §
 * Component inventory: "derives {canManageAssets, canManageLedger} from
 * usePermissions() once, so every screen gates the same way"). The gate is the
 * PRESENCE of the grant: entity scoping (ADR-0015) is enforced server-side and
 * reported by `GET /scope`, so a conditioned grant counts the same as an
 * unconditioned one. UX only — the real gate is inventory-api's (AC-9.7).
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, renderHook } from '@testing-library/react'
import type { Permission, PermissionsResult } from 'shell/session'

const { usePermissions } = vi.hoisted(() => ({ usePermissions: vi.fn() }))
vi.mock('shell/session', () => ({ usePermissions }))

import { useInventoryCapabilities } from './useInventoryCapabilities'

const permissionsWith = (permissions: Permission[]): PermissionsResult => ({
  epoch: 0,
  apps: ['inventory'],
  roles: [],
  departments: [],
  permissions,
})

const capabilitiesFor = (permissions: Permission[]) => {
  usePermissions.mockReturnValue(permissionsWith(permissions))
  return renderHook(() => useInventoryCapabilities()).result.current
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('useInventoryCapabilities', () => {
  it('grants nothing to a user with neither capability (and while permissions are still loading)', () => {
    expect(capabilitiesFor([])).toEqual({ canManageAssets: false, canManageLedger: false })
  })

  it('grants only asset management for asset:manage', () => {
    expect(capabilitiesFor([{ resource: 'asset', action: 'manage' }])).toEqual({
      canManageAssets: true,
      canManageLedger: false,
    })
  })

  it('grants only ledger management for ledger:manage', () => {
    expect(capabilitiesFor([{ resource: 'ledger', action: 'manage' }])).toEqual({
      canManageAssets: false,
      canManageLedger: true,
    })
  })

  it('grants both when both are held', () => {
    expect(
      capabilitiesFor([
        { resource: 'asset', action: 'manage' },
        { resource: 'ledger', action: 'manage' },
      ]),
    ).toEqual({ canManageAssets: true, canManageLedger: true })
  })

  it('counts an entity-conditioned grant: presence, not scope, gates the control', () => {
    expect(
      capabilitiesFor([{ resource: 'ledger', action: 'manage', conditions: { entity: 'welld_ch' } }]).canManageLedger,
    ).toBe(true)
  })

  it('ignores the same action on another resource, and another action on the same resource', () => {
    expect(
      capabilitiesFor([
        { resource: 'request', action: 'manage' },
        { resource: 'asset', action: 'read' },
        { resource: 'ledger', action: 'access' },
        { resource: 'inventory', action: 'access' },
      ]),
    ).toEqual({ canManageAssets: false, canManageLedger: false })
  })

  it('returns a stable object while the permissions are unchanged (safe in a dependency array)', () => {
    usePermissions.mockReturnValue(permissionsWith([{ resource: 'asset', action: 'manage' }]))
    const { result, rerender } = renderHook(() => useInventoryCapabilities())
    const first = result.current

    rerender()

    expect(result.current).toBe(first)
  })
})
