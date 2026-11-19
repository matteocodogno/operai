import { Link } from '@tanstack/react-router'
import { StatePanel } from '@operai/ui'
import { strings } from '../strings'

/**
 * The router fallback: an unknown path under `/accounting` (design AS7). It also stands in for an entity the person does
 * not cover (UX-12), which `useEntity` shows through this same panel. The link goes to the tool's root, which redirects
 * to the ledger accounts. Copied from letterheads-ui's `NotFoundPage`.
 */
export default function NotFoundPage() {
  return (
    <StatePanel
      role="alert"
      focusOnMount
      headingLevel={2}
      title={strings.common.notFound.heading}
      testId="accounting-not-found"
      headingTestId="accounting-not-found-heading"
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
