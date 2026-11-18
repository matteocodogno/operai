/**
 * ExchangeRatesView — the "Exchange rates" view of Settings (specs/20261118-refund-accounting-export, design S5). Mounted
 * only while its tab is open, so the `fetchDue` auto-fetch it will run (T26) happens only when someone looks.
 *
 * T23 ships the empty host; the rates card arrives with T26. `month` is the `&month=YYYY-MM` deep link
 * from the export's missing-rate blocker, which the card will scroll to and focus.
 */

export type ExchangeRatesViewProps = {
  month?: string
}

export default function ExchangeRatesView({ month }: ExchangeRatesViewProps) {
  return <div className="flex flex-col gap-4" data-testid="refund-settings-exchange-rates" data-month={month} />
}
