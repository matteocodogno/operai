/**
 * The app's ONE domain → status-meaning map (specs/20261119-accounting, design component #33; copied from refund-ui's
 * `lib/statusMeaning.ts`, three lines). Each state maps to a meaning of the suite's status dictionary (`STATUS` in
 * @operai/ui), which fixes its tone and icon, so an icon means the same thing in every tool.
 *
 * A ledger account or VAT code: *Active* is `active`, a deactivated one is `voided` (reversible, so not `failed`: it can be
 * reactivated). A month with no exchange rate: someone has to act, nothing has failed (the dictionary's `attention`).
 */

import type { StatusMeaning } from '@operai/ui'

export type CatalogStatus = 'active' | 'inactive'

export const CATALOG_STATUS_MEANING: Record<CatalogStatus, StatusMeaning> = {
  active: 'active',
  inactive: 'voided',
}

/** A month with no exchange rate (AC-2.7): never an estimate from another month, and not a failure. */
export const RATE_MISSING_MEANING: StatusMeaning = 'attention'
