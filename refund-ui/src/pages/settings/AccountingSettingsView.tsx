/**
 * AccountingSettingsView — the "Accounts and VAT" view of Settings (specs/20261118-refund-accounting-export, design S1):
 * ledger accounts, VAT codes, the default classification and the foreign-currency VAT code. Mounted only
 * while its tab is open and only for a user with `settings:read` (the page decides).
 *
 * T23 ships the empty host; the cards arrive with T24 (accounts, VAT codes) and T25 (defaults).
 */

export default function AccountingSettingsView() {
  return <div className="flex flex-col gap-4" data-testid="refund-settings-accounting" />
}
