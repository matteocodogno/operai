/**
 * DefaultsSettingsView — the "Default classification" view of Settings (specs/20261119-accounting, UX-16; it was
 * `AccountingSettingsView` of 20261118): the Accounting link note, then the default classification card with the
 * foreign-currency VAT code. The ledger accounts and VAT codes are kept in the Accounting app now, and the
 * exchange rates too. Mounted only while its tab is open and only for a user with `settings:read` (the page decides);
 * `settings:manage` adds the write controls, read from the shell's cached permissions (UX only: refund-api
 * enforces both).
 *
 * The card sits in no `<form>`, so every dialog it opens is mounted beside it (ADR 20261118 dialog-beside-form).
 */

import { usePermissions } from 'shell/session'
import AccountingLinkNote from '../../components/AccountingLinkNote'
import ExpenseTypeDefaultsCard from '../../components/settings/ExpenseTypeDefaultsCard'

export default function DefaultsSettingsView() {
  const { permissions } = usePermissions()
  const canManage = permissions.some(
    (permission) => permission.resource === 'settings' && permission.action === 'manage',
  )

  return (
    <div className="flex flex-col gap-4" data-testid="refund-settings-defaults">
      <AccountingLinkNote />
      <ExpenseTypeDefaultsCard canManage={canManage} />
    </div>
  )
}
