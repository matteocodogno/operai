import { formatNumber } from '@operai/ui'

/**
 * `8.1` → `8.1%` in English and `8,1%` in Italian, through `formatNumber` (design AS4, § Copy keys; copied from refund-ui's
 * `catalogLabels`, D29). Display only: the server's `ratePercent` string is what is kept, and a rate that is not a number
 * is shown as sent. Nothing is computed from the result.
 */
export const formatVatRate = (ratePercent: string): string => {
  const rate = Number.parseFloat(ratePercent)
  return Number.isFinite(rate)
    ? formatNumber(rate / 100, { style: 'percent', maximumFractionDigits: 2 })
    : `${ratePercent}%`
}
