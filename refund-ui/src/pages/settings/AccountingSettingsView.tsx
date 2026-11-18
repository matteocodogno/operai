/**
 * AccountingSettingsView — the "Accounts and VAT" view of Settings (specs/20261118-refund-accounting-export, design S1):
 * ledger accounts, VAT codes, the default classification and the foreign-currency VAT code. Mounted only
 * while its tab is open and only for a user with `settings:read` (the page decides); `settings:manage`
 * adds the write controls, read from the shell's cached permissions (UX only: refund-api enforces both).
 *
 * T24 puts the two catalog cards here; the defaults card arrives with T25. The cards sit in no `<form>`,
 * so every dialog they open is mounted beside its card (ADR 20261118 dialog-beside-form).
 */

import { usePermissions } from 'shell/session'
import LedgerAccountsCard from '../../components/settings/LedgerAccountsCard'
import VatCodesCard from '../../components/settings/VatCodesCard'

export default function AccountingSettingsView() {
  const { permissions } = usePermissions()
  const canManage = permissions.some(
    (permission) => permission.resource === 'settings' && permission.action === 'manage',
  )

  return (
    <div className="flex flex-col gap-4" data-testid="refund-settings-accounting">
      <LedgerAccountsCard canManage={canManage} />
      <VatCodesCard canManage={canManage} />
    </div>
  )
}
