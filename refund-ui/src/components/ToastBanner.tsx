/**
 * ToastBanner — a toast strip for expense-line auto-save feedback
 * (content-app auto-save, specs/NNN). Two tones (`tone` prop, default
 * `'error'`):
 *
 *   - `'error'`:   persistent, only dismissed by the user's own "×" click.
 *     `role="alert"` — screen readers announce immediately on insertion.
 *   - `'success'`: auto-dismisses ~2s after mount by calling `onDismiss`.
 *     `role="status"` + `aria-live="polite"` — announced without
 *     interrupting (unlike `role="alert"`'s assertive announcement).
 *
 * Ported pattern: `refund-ui` cannot import estimai-ui's source across the
 * Module Federation boundary (ADR-0006), so this is a re-authoring of
 * `estimai-ui/src/components/ToastBanner.tsx` (its `tone` prop, added for
 * the same auto-save feedback feature) — same behavior, using this repo's
 * `var(--x)` inline-style color convention (see `ErrorBanner.tsx`) rather
 * than estimai-ui's Tailwind theme color classes, since this project has no
 * local `@theme` palette (App.tsx's module doc: colors are consumed at
 * runtime from the federated `shell/tokens.css`).
 *
 * Copy sourced from `strings.ts` (T14/T15 convention: no hardcoded UI
 * strings) — only the dismiss button's `aria-label` is static; `message`
 * itself is always caller-supplied.
 *
 * Scope: `RequestDetailPage` renders at most one of these at a time, driven
 * by `ExpenseLineRow`'s `onSaveOutcome` callback for line edits only — never
 * for the composer or lifecycle actions (Submit/Withdraw/Delete), which stay
 * on this project's existing `aria-live="polite"` inline-confirmation
 * convention (design.md "Notification / toast a11y").
 */

import { useEffect, useRef } from 'react'
import { strings } from '../strings'

/** How long a success toast stays mounted before calling onDismiss. */
const SUCCESS_AUTO_DISMISS_MS = 2000

export type ToastBannerProps = {
  message: string
  onDismiss: () => void
  /** 'error' (default) — persistent, role="alert". 'success' — auto-dismisses, role="status". */
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

  const toneColor = isSuccess ? 'var(--grn)' : 'var(--org)'

  return (
    <div
      role={isSuccess ? 'status' : 'alert'}
      aria-live={isSuccess ? 'polite' : undefined}
      data-testid="toast-banner"
      className="flex items-center justify-between gap-3 px-4 py-2 border-l-2 rounded-sm text-sm"
      style={{
        borderColor: toneColor,
        backgroundColor: `color-mix(in srgb, ${toneColor} 10%, transparent)`,
        color: 'var(--text)',
      }}
    >
      <span>{message}</span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label={strings.components.toastBanner.dismissLabel}
        data-testid="toast-banner-dismiss"
        className="shrink-0 text-base leading-none transition-opacity hover:opacity-80"
        style={{ color: toneColor }}
      >
        ×
      </button>
    </div>
  )
}
