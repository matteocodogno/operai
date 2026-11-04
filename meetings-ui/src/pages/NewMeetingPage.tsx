import { PageHeader } from '@operai/ui'
import { strings } from '../strings'

/** Placeholder (specs/021-meetings T53): the owning task fills this page in place. */
export default function NewMeetingPage() {
  return (
    <section aria-labelledby="meetings-new-page-heading" data-testid="meetings-new-page">
      <PageHeader title={strings.newMeeting.heading} titleId="meetings-new-page-heading" />
    </section>
  )
}
