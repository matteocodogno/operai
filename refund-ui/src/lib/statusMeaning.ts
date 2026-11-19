/**
 * The app's ONE domain → status-meaning map (INC-23). Each refund status maps
 * to a meaning of the suite's status dictionary (`STATUS` in @operai/ui),
 * which fixes its tone and icon, so an icon means the same thing in every
 * tool. `RequestStatusBadge` and `BatchStatusBadge` render through it.
 *
 * `paid` is "settled" for both a request and a batch: the same real-world
 * event seen from two sides, hence the same icon — and distinct from an
 * approved request ("active") by icon, though both are the success tone.
 */

import type { StatusMeaning } from '@operai/ui'
import type { RequestStatus } from '../components/RequestStatusBadge'
import type { BatchStatus } from './batchesApi'

export const REQUEST_STATUS_MEANING: Record<RequestStatus, StatusMeaning> = {
  draft: 'draft',
  submitted: 'pending',
  approved: 'active',
  rejected: 'failed',
  paid: 'settled',
}

export const BATCH_STATUS_MEANING: Record<BatchStatus, StatusMeaning> = {
  compiled: 'pending',
  paid: 'settled',
  discarded: 'voided',
}

/** The mileage rate in effect today (Settings tab) — the one live entry of a series. */
export const RATE_IN_EFFECT_MEANING: StatusMeaning = 'active'

/**
 * A ledger account or VAT code in the catalog (specs/20261118-refund-accounting-export): *Active* is
 * `active`, a deactivated one is `voided` (reversible, so not `failed`: A1 lets it be reactivated).
 */
export type CatalogStatus = 'active' | 'inactive'

export const CATALOG_STATUS_MEANING: Record<CatalogStatus, StatusMeaning> = {
  active: 'active',
  inactive: 'voided',
}

/** A month with no exchange rate: someone has to act, nothing has failed (the dictionary's `attention`). */
export const RATE_MISSING_MEANING: StatusMeaning = 'attention'

/**
 * The state of an Accounting entry a stored copy points to, wherever it is shown in Refund (specs/20261119-accounting
 * UX-18): `deactivated` is the reversible "no longer offered" (`voided`), `not_found` needs someone but nothing
 * failed (`attention`). `active` has no mark, and `unverified` (Accounting cannot be read) has none either: the value
 * is not wrong, it is unchecked, so a badge would cry wolf.
 */
export const ENTRY_STATE_MEANING = { deactivated: 'voided', not_found: 'attention' } as const satisfies Record<
  'deactivated' | 'not_found',
  StatusMeaning
>
