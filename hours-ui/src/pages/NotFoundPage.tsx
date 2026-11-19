import { Link } from '@tanstack/react-router'
import { StatePanel } from '@operai/ui'
import { strings } from '../strings'

/** The router fallback: an unknown path under `/hours`. Takes focus, and leads back to My hours. */
export default function NotFoundPage() {
  return (
    <StatePanel
      role="alert"
      focusOnMount
      headingLevel={2}
      title={strings.common.notFound.heading}
      testId="hours-not-found"
      action={
        <Link to="/" className="link">
          {strings.common.notFound.back}
        </Link>
      }
    >
      {strings.common.notFound.body}
    </StatePanel>
  )
}
