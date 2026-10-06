/**
 * ErrorBanner — inline RFC 7807 error banner with a Retry action (T25,
 * specs/015-hardware-inventory; design.md § Component inventory: "Fetch error —
 * refund-ui/src/components/ErrorBanner.tsx (adds the 503 heading as a
 * prop-level variant, no new component)").
 *
 * Re-authored from refund-ui's ErrorBanner (a remote cannot import another
 * remote's source, ADR-0006): same props, same `role="alert"` contract, same
 * idle / retry / dismiss behaviour. Presentational — the caller extracts
 * `detail` off its own `ApiError` and passes plain strings in.
 *
 * The one addition is `variant="authUnavailable"`, the 503 fail-closed
 * presentation (ADR-0014: an `auth` outage denies, never allows): it carries
 * its own heading "Authorization service unavailable" and, unless the caller
 * overrides `message`, the body "We cannot verify your access right now.
 * Nothing was changed." It is the same alert with the same Retry; for a write
 * the caller keeps its dialog open and renders this inside it.
 *
 * A11y: `role="alert"` — assistive tech announces the message when it is
 * inserted, without focus moving there. Retry and Dismiss are real `<button>`s.
 */

import { strings } from '../strings'

type Common = {
  /** Called when the user clicks "Retry". Omit to render without a Retry action. */
  onRetry?: () => void
  /** Label for the retry action. Defaults to strings.common.errorBanner.defaultRetryLabel. */
  retryLabel?: string
  /** Called when the user dismisses the banner. Omit to render without a dismiss action. */
  onDismiss?: () => void
}

export type ErrorBannerProps = Common &
  (
    | {
        variant?: 'default'
        /** The error text to display (typically an RFC 7807 `detail`). */
        message: string
      }
    | {
        /** The 503 "authorization service unavailable" presentation: adds its heading. */
        variant: 'authUnavailable'
        /** Overrides the default body copy. */
        message?: string
      }
  )

export default function ErrorBanner(props: ErrorBannerProps) {
  const { onRetry, retryLabel = strings.common.errorBanner.defaultRetryLabel, onDismiss } = props
  const heading = props.variant === 'authUnavailable' ? strings.common.authUnavailable.heading : null
  const message =
    props.variant === 'authUnavailable' ? (props.message ?? strings.common.authUnavailable.body) : props.message

  return (
    <div
      role="alert"
      data-testid="error-banner"
      className="flex items-center justify-between gap-4 px-4 py-3 rounded-md border text-sm"
      style={{
        borderColor: 'var(--org)',
        backgroundColor: 'color-mix(in srgb, var(--org) 10%, transparent)',
        color: 'var(--org)',
      }}
    >
      <span className="flex flex-col gap-0.5">
        {heading !== null && (
          <strong data-testid="error-banner-heading" className="font-semibold">
            {heading}
          </strong>
        )}
        <span>{message}</span>
      </span>
      <span className="flex items-center gap-3 shrink-0">
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            data-testid="error-banner-retry"
            className="text-xs font-medium border px-2.5 py-1 transition-opacity hover:opacity-80"
            style={{ borderColor: 'var(--org)', color: 'var(--org)' }}
          >
            {retryLabel}
          </button>
        )}
        {onDismiss && (
          <button
            type="button"
            onClick={onDismiss}
            aria-label={strings.common.errorBanner.dismissLabel}
            data-testid="error-banner-dismiss"
            className="text-base leading-none transition-opacity hover:opacity-80"
            style={{ color: 'var(--org)' }}
          >
            ×
          </button>
        )}
      </span>
    </div>
  )
}
