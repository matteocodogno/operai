/**
 * monthLabel — an API month (`YYYY-MM`) as "March 2026" / "marzo 2026" through `@operai/ui`'s `formatMonth`
 * (copied from refund-ui's `lib/monthLabel.ts`, which keeps its own: specs/20261119-accounting, plan D29, design component #32;
 * originally specs/20261118-refund-accounting-export, UX-10).
 *
 * `formatMonth` throws on a value it cannot read, like the money formatters, so that a bad value never shows as
 * "Invalid Date". A month on screen comes from the server, and one unreadable value must not blank a whole card, so
 * this falls back to the raw text (for `YYYY-MM` that is the ISO month, which is what the plan names as the
 * language-neutral fallback). One place for what names a month in this app: the exchange-rates card, its dialog and the
 * deep-link note.
 */

import { formatMonth } from '@operai/ui'

export const monthLabel = (month: string): string => {
  try {
    return formatMonth(month)
  } catch {
    return month
  }
}
