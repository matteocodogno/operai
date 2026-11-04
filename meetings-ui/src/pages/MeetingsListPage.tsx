import { PageHeader } from '@operai/ui'
import { strings } from '../strings'

export type MeetingsListPageProps = {
  /** `true` in `./MyMeetings` (identity-scoped entry, no tool frame), `false` in `./App` (design.md S1). */
  mine: boolean
}

/** Placeholder (specs/021-meetings T53): T55 fills this page in place, for both entries. */
export default function MeetingsListPage({ mine }: MeetingsListPageProps) {
  return (
    <section aria-labelledby="meetings-list-page-heading" data-testid="meetings-list-page">
      <PageHeader title={mine ? strings.list.myHeading : strings.list.heading} titleId="meetings-list-page-heading" />
    </section>
  )
}
