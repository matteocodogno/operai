/**
 * ErrorBanner — inline RFC 7807 error banner with a Retry action (T15,
 * specs/20260713-auth-roles-permissions).
 *
 * Ported pattern, merging two existing estimai-ui shapes admin-ui cannot
 * import across the Module Federation boundary (ADR 20260709-suite-frontend-module-federation):
 *   • `estimai-ui/src/components/ToastBanner.tsx` — role="alert" strip,
 *     border-left accent, optional dismiss "×".
 *   • `estimai-ui/src/pages/EstimatesPage.tsx`'s inline list-error banner —
 *     message + a "Retry" button, used for a failed `GET` that the user can
 *     immediately re-attempt.
 *
 * Every admin-ui list/detail screen (Roles/Departments/Users/Audit — later
 * tasks T17–T21) renders its RFC 7807 `detail` text through this one
 * component rather than a bespoke error block, per design.md's "Err" state
 * convention ("mirrors EstimatesPage's list-error pattern").
 *
 * Presentational: the caller extracts `detail`/`title` off its own
 * `ApiError`-shaped error (admin-ui's API client is a separate task, T16)
 * and passes plain strings in — this component has no knowledge of the
 * Problem+JSON shape itself.
 *
 * A11y: `role="alert"` — assistive tech announces the message as soon as it
 * is inserted, without requiring focus to move there. "Retry" and "Dismiss"
 * are real `<button>`s.
 *
 * Now @operai/ui's `Banner tone="warning"` (ADR 20261031-shared-ui-library-consumed-as-source): a recoverable failure
 * is orange, Retry is a `secondary` `sm` Button, × an icon-only ghost Button.
 */

import { Banner } from '@operai/ui'
import { strings } from '../strings'

export type ErrorBannerProps = {
  /** The error text to display (typically an RFC 7807 `detail`). */
  message: string
  /** Called when the user clicks "Retry". Omit to render without a Retry action. */
  onRetry?: () => void
  /** Label for the retry action. Defaults to "Retry". */
  retryLabel?: string
  /** Called when the user dismisses the banner. Omit to render without a dismiss action. */
  onDismiss?: () => void
  /**
   * `warning` (default) — a failed load the user can retry (orange);
   * `danger` — a failed save/decision the user must act on (red, INC-20).
   */
  tone?: 'warning' | 'danger'
}

export default function ErrorBanner({
  message,
  onRetry,
  retryLabel = strings.common.actions.retry,
  onDismiss,
  tone = 'warning',
}: ErrorBannerProps) {
  return (
    <Banner
      tone={tone}
      data-testid="error-banner"
      onRetry={onRetry}
      retryLabel={retryLabel}
      retryTestId="error-banner-retry"
      onDismiss={onDismiss}
      dismissLabel={strings.common.actions.dismiss}
      dismissTestId="error-banner-dismiss"
    >
      {message}
    </Banner>
  )
}
