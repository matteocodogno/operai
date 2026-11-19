import type { StatusMeaning } from '@operai/ui'

/**
 * statusMeaning — hours-ui's ONE map from each domain status to the suite's status dictionary
 * (INC-23, operai-ui design-system.md § Statuses). The meaning fixes the badge's tone and icon; the
 * label comes from `strings.settings.status`. Every status badge in this app reads this module.
 */

/**
 * A time-list item (category or work type, specs/20261112-time-tracking): in use, or retired — no
 * longer offered for a new entry, kept by the entries that have it. Keyed by the wire's `retired`
 * flag, so the map is the one place that says Retired is `voided` ("no longer counts") and not a
 * failure.
 */
export type TimeListItemStatus = 'active' | 'retired'

export const TIME_LIST_STATUS_MEANING: Record<TimeListItemStatus, StatusMeaning> = {
  active: 'active',
  retired: 'voided',
}
