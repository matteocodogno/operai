/**
 * monthLabel — an API month (`YYYY-MM`) as "March 2026" / "marzo 2026" through `@operai/ui`'s `formatMonth`
 * (specs/20261118-refund-accounting-export, UX-10).
 *
 * `formatMonth` throws on a value it cannot read, like the money formatters, so that a bad value never shows as
 * "Invalid Date". A month on screen comes from the server, and one unreadable value must not blank a whole card, so
 * this falls back to the raw text (for `YYYY-MM` that is the ISO month, which is what the plan names as the
 * language-neutral fallback). One place for the three screens that name a month: the exchange-rates card, the
 * classification panel and the export blockers.
 */

import { formatMonth } from '@operai/ui'

export const monthLabel = (month: string): string => {
  try {
    return formatMonth(month)
  } catch {
    return month
  }
}
