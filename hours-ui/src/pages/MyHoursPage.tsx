import { PageHeader } from '@operai/ui'
import { strings } from '../strings'

/**
 * My hours — `/hours`. T22 ships the page's frame (the h2 under the tool title); the filters, the totals,
 * the entries by day, the entry dialog and the export are T24–T30.
 */
export default function MyHoursPage() {
  return (
    <section aria-labelledby="hours-my-heading" data-testid="hours-my-page">
      <PageHeader title={strings.myHours.heading} titleId="hours-my-heading" />
    </section>
  )
}
