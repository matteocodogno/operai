import { Banner } from '@operai/ui'
import { strings } from '../strings'

export type ErrorBannerProps = {
  /** The error text to display (typically an RFC 7807 `detail`, through `errorMessage`). */
  message: string
  /** A bold first line ("Authorization service unavailable"). */
  title?: string
  /** Called when the person clicks Retry. Omit to render without a Retry action. */
  onRetry?: () => void
  /** Label for the retry action; defaults to "Retry". */
  retryLabel?: string
  /** Called when the person dismisses the banner. Omit to render without a ×. */
  onDismiss?: () => void
  /**
   * `warning` (default): a failed load the person can retry (orange); `danger`: a failed save
   * or decision the person must act on (red, INC-20).
   */
  tone?: 'warning' | 'danger'
  /** Test id of the banner; its Retry is `${testId}-retry` and its × `${testId}-dismiss`. */
  testId?: string
}

/**
 * ErrorBanner — an inline error with an optional Retry (design-system.md § Feedback). A thin adapter
 * over the library `Banner`, like the same file in admin-ui: the screen that failed passes plain
 * strings and the retry, this component knows nothing about the Problem shape. `role="alert"`:
 * announced as soon as it is inserted, without moving focus.
 */
export default function ErrorBanner({
  message,
  title,
  onRetry,
  retryLabel = strings.common.retry,
  onDismiss,
  tone = 'warning',
  testId = 'hours-error-banner',
}: ErrorBannerProps) {
  return (
    <Banner
      tone={tone}
      title={title}
      data-testid={testId}
      onRetry={onRetry}
      retryLabel={retryLabel}
      retryTestId={`${testId}-retry`}
      onDismiss={onDismiss}
      dismissLabel={strings.common.dismiss}
      dismissTestId={`${testId}-dismiss`}
    >
      {message}
    </Banner>
  )
}
