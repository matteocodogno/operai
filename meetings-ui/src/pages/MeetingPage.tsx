import { PageHeader } from '@operai/ui'
import { strings } from '../strings'

export type MeetingPageProps = {
  /** The list this page's back link returns to: `/meetings` in `./App`, `/my-meetings` in `./MyMeetings` (design.md Conventions). */
  listPath: '/meetings' | '/my-meetings'
}

/** Placeholder (specs/021-meetings T53): T57 builds the meeting page frame here, shared by both entries. */
export default function MeetingPage({ listPath }: MeetingPageProps) {
  return (
    <section
      aria-labelledby="meetings-meeting-page-heading"
      data-testid="meetings-meeting-page"
      data-list-path={listPath}
    >
      <PageHeader title={strings.nav.tabs.meetings} titleId="meetings-meeting-page-heading" />
    </section>
  )
}
