/**
 * ErrorBanner — inline RFC 7807 error banner with a Retry action (T15,
 * specs/004-auth-roles-permissions).
 *
 * Ported pattern, merging two existing estimai-ui shapes admin-ui cannot
 * import across the Module Federation boundary (ADR-0006):
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
 */

export type ErrorBannerProps = {
  /** The error text to display (typically an RFC 7807 `detail`). */
  message: string
  /** Called when the user clicks "Retry". Omit to render without a Retry action. */
  onRetry?: () => void
  /** Label for the retry action. Defaults to "Retry". */
  retryLabel?: string
  /** Called when the user dismisses the banner. Omit to render without a dismiss action. */
  onDismiss?: () => void
}

export default function ErrorBanner({ message, onRetry, retryLabel = 'Retry', onDismiss }: ErrorBannerProps) {
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
      <span>{message}</span>
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
            aria-label="Dismiss"
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
