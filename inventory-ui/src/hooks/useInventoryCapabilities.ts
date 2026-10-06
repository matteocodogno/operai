import { useMemo } from 'react'
import { usePermissions } from 'shell/session'

/** What the caller can do in the Inventory tool, as the layout and every screen gate on it. */
export type InventoryCapabilities = {
  /** Holds `asset:manage` — register, edit, assign and move assets; sees holders and the invoice file. */
  canManageAssets: boolean
  /** Holds `ledger:manage` — sees book value and the schedule; owns rules, fiscal years and disposal. */
  canManageLedger: boolean
}

/**
 * useInventoryCapabilities — derives `{canManageAssets, canManageLedger}` from
 * `usePermissions()` once, so every screen gates the same way (T28,
 * specs/015-hardware-inventory; design.md § Component inventory).
 *
 * The gate is the PRESENCE of the grant, conditioned or not: entity scoping
 * (ADR-0015) is enforced server-side and surfaced through `GET /scope`
 * (`useScope`), so a conditioned grant must still show its tab. Before the
 * shell's `/authz/me` fetch settles `usePermissions()` is empty and both flags
 * are false (the tabs appear a tick late — the RefundShell precedent); the shell
 * only mounts this remote once the access grant is resolved, so a deep link does
 * not normally see that tick.
 *
 * This is UX, not the gate: hiding a control here never replaces the server's
 * 403 (ADR-0014, AC-9.7).
 */
export function useInventoryCapabilities(): InventoryCapabilities {
  const { permissions } = usePermissions()

  return useMemo(() => {
    const holds = (resource: string) =>
      permissions.some((permission) => permission.resource === resource && permission.action === 'manage')
    return { canManageAssets: holds('asset'), canManageLedger: holds('ledger') }
  }, [permissions])
}
