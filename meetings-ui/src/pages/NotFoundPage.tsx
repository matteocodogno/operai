import { Link } from '@tanstack/react-router'
import { StatePanel } from '@operai/ui'
import { strings } from '../strings'

export type NotFoundPageProps = {
  /** `true` in `./MyMeetings`: the back link reads "my meetings". Both entries' list is the router's `/`. */
  mine: boolean
}

/** The router fallback (S10): an unknown path under `/meetings` or `/my-meetings`. */
export default function NotFoundPage({ mine }: NotFoundPageProps) {
  return (
    <StatePanel
      role="alert"
      focusOnMount
      headingLevel={2}
      title={strings.nav.notFound.heading}
      testId="meetings-not-found"
      action={
        <Link to="/" className="link">
          {mine ? strings.nav.notFound.backMine : strings.nav.notFound.back}
        </Link>
      }
    >
      {strings.nav.notFound.body}
    </StatePanel>
  )
}
