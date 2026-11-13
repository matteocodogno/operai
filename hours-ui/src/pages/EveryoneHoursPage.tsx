import { PageHeader } from '@operai/ui'
import { strings } from '../strings'

/**
 * Everyone's hours — `/hours/all`. T22 ships the page's frame (the h2 under the tool title) and fetches
 * nothing; the holder-only gate, the filters, the table and the denial states are T29.
 */
export default function EveryoneHoursPage() {
  return (
    <section aria-labelledby="hours-everyone-heading" data-testid="hours-everyone-page">
      <PageHeader title={strings.everyone.heading} titleId="hours-everyone-heading" />
    </section>
  )
}
