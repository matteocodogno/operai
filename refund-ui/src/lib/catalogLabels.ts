/**
 * catalogLabels — how a ledger account and a VAT code read in a select, a table cell or a sentence
 * (specs/20261118-refund-accounting-export, design UX-4): the number or code FIRST, so a native `<select>`'s
 * type-ahead works on what accountants know by heart (`5905 — Spese rimborsi…`).
 *
 * One place, because the same text appears in the line panel, the defaults dialogs, the defaults table
 * and the history drawer, and a drift between them would show an accountant two spellings of one account.
 */

import { formatNumber } from '@operai/ui'
import { strings } from '../strings'

/** The `value` of a select's explicit "None" option. A number or a code can never equal it (digits and dots; letters, digits, - and _ in capitals). */
export const CATALOG_NONE = '__none__'

const t = strings.pages.reviewDetail.classification

/** `8.1` → `8.1%` in English and `8,1%` in Italian. Display only: a rate that is not a number is shown as sent. */
export const formatVatRate = (ratePercent: string): string => {
  const rate = Number.parseFloat(ratePercent)
  return Number.isFinite(rate)
    ? formatNumber(rate / 100, { style: 'percent', maximumFractionDigits: 2 })
    : `${ratePercent}%`
}

export const accountText = (account: { number: string; name: string }): string =>
  t.accountOption(account.number, account.name)

/** `label` is `null` for a copy that recorded none: the code and its rate stand alone. */
export const vatCodeText = (vatCode: { code: string; label: string | null; ratePercent: string }): string =>
  vatCode.label === null
    ? t.vatOptionNoLabel(vatCode.code, formatVatRate(vatCode.ratePercent))
    : t.vatOption(vatCode.code, vatCode.label, formatVatRate(vatCode.ratePercent))
