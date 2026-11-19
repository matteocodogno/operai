import { Banner, SkeletonRows, VisuallyHidden } from '@operai/ui'
import { errorMessage, statusOf } from '../lib/errors'
import { strings } from '../strings'
import PermissionDenied from './PermissionDenied'

/** The loading state: a polite live line plus skeleton rows (copied from letterheads-ui). */
export function Loading({ label, rows = 3 }: { label: string; rows?: number }) {
  return (
    <div data-testid="accounting-loading">
      <VisuallyHidden live role="status">
        {label}
      </VisuallyHidden>
      <SkeletonRows rows={rows} actions={2} />
    </div>
  )
}

/**
 * The failed-load state, the one failure ladder of the app (design UX-15): 403 → PermissionDenied (alert, focus, no
 * retry); 503 → the "authorization service unavailable" warning banner with Retry (ADR
 * 20260716-refund-api-authorization-enforcing-resource-server); anything else → a warning banner with Retry carrying
 * `message` (the card's own sentence), else the Problem detail, else a generic line.
 *
 * Every other consumer of the ladder (the frame, each card) renders this, so the three rungs read the same everywhere.
 */
export function LoadFailure({
  error,
  onRetry,
  message,
}: {
  error: unknown
  onRetry: () => void
  /** The card's own sentence for "could not load X", used for the third rung instead of the Problem detail. */
  message?: string
}) {
  const status = statusOf(error)
  if (status === 403) return <PermissionDenied />
  const auth = status === 503
  return (
    <Banner
      tone="warning"
      data-testid="accounting-load-error"
      title={auth ? strings.common.authUnavailable.heading : strings.common.loadErrorTitle}
      onRetry={onRetry}
      retryLabel={strings.common.retry}
      retryTestId="accounting-load-error-retry"
    >
      {auth ? strings.common.authUnavailable.body : (message ?? errorMessage(error))}
    </Banner>
  )
}
