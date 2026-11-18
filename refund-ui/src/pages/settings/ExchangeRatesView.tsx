/**
 * ExchangeRatesView — the "Exchange rates" view of Settings (specs/20261118-refund-accounting-export, design S5). Mounted
 * only while its tab is open, so the `fetchDue` auto-fetch the card runs happens only when someone looks
 * (UX-1, UX-11). Only for a user with `settings:read` (the page decides); `settings:manage`, read from the
 * shell's cached permissions (UX only: refund-api enforces both), adds Fetch now and Correct and lets the
 * auto-fetch run.
 *
 * `month` is the `&month=YYYY-MM` deep link from the export's missing-rate blocker; the card focuses that row.
 */

import { usePermissions } from 'shell/session'
import ExchangeRatesCard from '../../components/settings/ExchangeRatesCard'

export type ExchangeRatesViewProps = {
  month?: string
}

export default function ExchangeRatesView({ month }: ExchangeRatesViewProps) {
  const { permissions } = usePermissions()
  const canManage = permissions.some(
    (permission) => permission.resource === 'settings' && permission.action === 'manage',
  )

  return (
    <div className="flex flex-col gap-4" data-testid="refund-settings-exchange-rates" data-month={month}>
      <ExchangeRatesCard canManage={canManage} month={month} />
    </div>
  )
}
