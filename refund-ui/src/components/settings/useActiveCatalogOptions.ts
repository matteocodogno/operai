/**
 * useActiveCatalogOptions — the ACTIVE ledger accounts and VAT codes a defaults dialog may offer (AC-2.4:
 * "only active entries"), loaded when the dialog opens and again on demand (`reload`, after a 422 says an entry was
 * deactivated while the dialog was open).
 *
 * Read from the catalog lists (`settings:read`), not from `GET /accounting/options`: that one needs
 * `request:review`, which an administrator editing defaults need not hold. Both lists are loaded together, so a
 * dialog never shows one select ready and the other not. A `reload` keeps the options on screen until the
 * new answer arrives.
 */

import { listLedgerAccounts, listVatCodes } from '../../lib/accountingApi'
import type { AccountingOptions } from '../../lib/accountingApi'
import { useLoadedResource } from '../../lib/useLoadedResource'

const loadActive = async (): Promise<AccountingOptions> => {
  const [accounts, vatCodes] = await Promise.all([listLedgerAccounts(), listVatCodes()])
  return {
    ledgerAccounts: accounts.filter((account) => account.active),
    vatCodes: vatCodes.filter((vatCode) => vatCode.active),
  }
}

export const useActiveCatalogOptions = () => useLoadedResource(loadActive)
