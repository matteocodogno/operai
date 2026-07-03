/**
 * ToastBanner — a persistent, dismissible error strip rendered inline in the
 * editor layout (below the tab bar, above the main content area).
 *
 * Design spec (design.md — Screen B toast zone):
 *   px-5.5 py-2 border-l-2 border-org bg-org/10 text-sm text-text
 *   Dismiss button ("×") on the right.
 *   Only one toast shown at a time; the 413 toast does not auto-dismiss.
 *
 * Accessibility (design.md — Accessibility: Save error toast):
 *   role="alert" — screen readers announce immediately on insertion.
 *   Dismiss "×" button has aria-label="Dismiss".
 */

type ToastBannerProps = {
  message: string
  onDismiss: () => void
}

export default function ToastBanner({ message, onDismiss }: ToastBannerProps) {
  return (
    <div
      role="alert"
      className="flex items-center justify-between gap-3 px-5.5 py-2 border-l-2 border-org bg-org/10 text-sm text-text"
    >
      <span>{message}</span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="shrink-0 text-org hover:text-text transition-colors text-base leading-none"
      >
        ×
      </button>
    </div>
  )
}
