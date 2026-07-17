/**
 * ErrorBanner — inline RFC 7807 error banner with a Retry action (T15,
 * specs/007-refund-service/tasks.md, design.md Component inventory:
 * "ErrorBanner — Reuse (ported pattern) — admin-ui/src/components/ErrorBanner.tsx").
 *
 * Ported pattern: `refund-ui` cannot import admin-ui's source across the
 * Module Federation boundary (ADR-0006), so this is a near-verbatim
 * re-authoring of `admin-ui/src/components/ErrorBanner.tsx` — same props
 * shape, same idle/retry/dismiss behavior, same `role="alert"` contract.
 * Every refund-ui list/detail screen (R1/R2/A1/A2 — T16/T18) renders a
 * failed `GET`'s RFC 7807 `detail` text through this one component, per
 * design.md's "Err" state convention on every screen.
 *
 * Presentational: the caller extracts `detail`/`title` off its own
 * `ApiError`-shaped error (`src/lib/refundApi.ts`) and passes plain strings
 * in — this component has no knowledge of the Problem+JSON shape itself.
 *
 * Copy sourced from `strings.ts` (T14/T15 convention: no hardcoded UI
 * strings) — only the default retry label and the dismiss button's
 * `aria-label` are static; `message` itself is always caller-supplied.
 *
 * A11y: `role="alert"` — assistive tech announces the message as soon as it
 * is inserted, without requiring focus to move there. "Retry" and "Dismiss"
 * are real `<button>`s.
 */

import { strings } from '../strings'

export type ErrorBannerProps = {
  /** The error text to display (typically an RFC 7807 `detail`). */
  message: string
  /** Called when the user clicks "Retry". Omit to render without a Retry action. */
  onRetry?: () => void
  /** Label for the retry action. Defaults to strings.components.errorBanner.defaultRetryLabel. */
  retryLabel?: string
  /** Called when the user dismisses the banner. Omit to render without a dismiss action. */
  onDismiss?: () => void
}

export default function ErrorBanner({
  message,
  onRetry,
  retryLabel = strings.components.errorBanner.defaultRetryLabel,
  onDismiss,
}: ErrorBannerProps) {
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
            aria-label={strings.components.errorBanner.dismissLabel}
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
