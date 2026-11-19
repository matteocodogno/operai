/**
 * useActiveCatalogOptions — the ACTIVE ledger accounts and VAT codes a defaults dialog may offer (AC-2.4:
 * "only active entries"), loaded when the dialog opens and again on demand (`reload`, after a 422 says an entry was
 * deactivated or removed while the dialog was open).
 *
 * specs/20261119-accounting (T35): read from `GET /accounting/options`, which refund-api answers for a reviewer
 * covering WellD CH OR for `settings:manage` (D16), so an administrator editing defaults needs no Accounting
 * capability (AC-4.4). The entries come live from Accounting, keyed by number and code. When Accounting cannot be
 * read the answer is 503 `accounting_unavailable`: the resource is then in `error`, and `optionsUnavailable` says so
 * (the dialog shows the AC-6.10 message and no options, AC-6.9). A `reload` keeps the options on screen until the
 * new answer arrives.
 */

import { getAccountingOptions, isAccountingUnavailable } from '../../lib/accountingApi'
import type { AccountingOptions } from '../../lib/accountingApi'
import type { LoadedResource } from '../../lib/useLoadedResource'
import { useLoadedResource } from '../../lib/useLoadedResource'

export const useActiveCatalogOptions = () => useLoadedResource(getAccountingOptions)

/** The options call answered 503 `accounting_unavailable`: nothing to choose from until Accounting can be read. */
export const optionsUnavailable = (options: LoadedResource<AccountingOptions>): boolean =>
  options.status === 'error' && isAccountingUnavailable(options.error)
