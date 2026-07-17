/**
 * ToastBanner — a toast strip rendered inline in the editor layout (below the
 * tab bar, above the main content area). Two tones (`tone` prop, default
 * `'error'` — unchanged from the original error-only strip):
 *
 *   - `'error'`   (design.md — Screen B toast zone): persistent, only
 *     dismissed by the user's own "×" click. `role="alert"` — screen readers
 *     announce immediately on insertion. `border-org`/`bg-org/10`.
 *   - `'success'` (specs auto-save "changes stored" feedback): positive
 *     confirmation, auto-dismisses ~2s after mount by calling `onDismiss`.
 *     `role="status"` + `aria-live="polite"` — announced without interrupting
 *     (unlike `role="alert"`'s assertive announcement). `border-grn`/`bg-grn/10`.
 *
 * Design spec (design.md — Screen B toast zone):
 *   px-5.5 py-2 border-l-2 border-{tone} bg-{tone}/10 text-sm text-text
 *   Dismiss button ("×") on the right.
 *   Only one toast shown at a time; the error toast does not auto-dismiss.
 *
 * Accessibility (design.md — Accessibility: Save error toast):
 *   role="alert" — screen readers announce immediately on insertion.
 *   Dismiss "×" button has aria-label="Dismiss".
 */

import { useEffect, useRef } from 'react'

/** How long a success toast stays mounted before calling onDismiss. */
const SUCCESS_AUTO_DISMISS_MS = 2000

type ToastBannerProps = {
  message: string
  onDismiss: () => void
  /** 'error' (default, unchanged) — persistent, role="alert". 'success' — auto-dismisses, role="status". */
  tone?: 'error' | 'success'
}

export default function ToastBanner({ message, onDismiss, tone = 'error' }: ToastBannerProps) {
  const isSuccess = tone === 'success'

  // Keep the latest onDismiss without making it a timer-restarting dependency —
  // a caller re-render passing a fresh inline callback must not reset the clock.
  const onDismissRef = useRef(onDismiss)
  useEffect(() => {
    onDismissRef.current = onDismiss
  })

  useEffect(() => {
    if (!isSuccess) return
    const timer = setTimeout(() => onDismissRef.current(), SUCCESS_AUTO_DISMISS_MS)
    return () => clearTimeout(timer)
  }, [isSuccess, message])

  return (
    <div
      role={isSuccess ? 'status' : 'alert'}
      aria-live={isSuccess ? 'polite' : undefined}
      className={`flex items-center justify-between gap-3 px-5.5 py-2 border-l-2 text-sm text-text ${
        isSuccess ? 'border-grn bg-grn/10' : 'border-org bg-org/10'
      }`}
    >
      <span>{message}</span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className={`shrink-0 hover:text-text transition-colors text-base leading-none ${
          isSuccess ? 'text-grn' : 'text-org'
        }`}
      >
        ×
      </button>
    </div>
  )
}
