/**
 * ConfirmDeleteModal — accessible confirmation dialog for destructive estimate
 * deletion (US-3, AC-3.1, AC-3.2, specs/001-estimate-persistence).
 *
 * Presentational: all data and callbacks arrive via props. EstimatesPage owns
 * the state and the API call.
 *
 * Generalized (T19, specs/013-estimate-sharing, AC-5.2/AC-6.1) — `title` /
 * `bodyText` / `confirmLabel` are optional overrides so this same dialog also
 * backs the Remove-collaborator and Leave-estimate confirmations (design.md's
 * component inventory). All three default to today's exact copy, so
 * `EstimatesPage`'s existing call site needs no change. `isDeleting` /
 * `errorMessage` keep their existing contract verbatim (design.md S2/S3).
 *
 * A11y (design.md Screen C):
 *   • role="dialog" aria-modal="true" aria-labelledby="confirm-delete-title"
 *   • Focus trap: Tab cycles only between Cancel and Confirm while modal is open.
 *   • Default focus: "Cancel" (safe default — avoids accidental destruction).
 *   • Escape = Cancel; no confirm action is triggered.
 *   • Contrast: --color-red (#f55a5a dark / #d93636 light) on ink-soft bg — ≥ 5.5:1 AA.
 *
 * States (per design.md):
 *   • idle      — title + body + Cancel + Confirm buttons
 *   • deleting  — "Deleting…" + spinner, both buttons disabled
 *   • error     — inline error text between body and footer; both buttons re-enabled
 */

import { useEffect, useRef } from 'react'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ConfirmDeleteModalProps = {
  /** Name of the estimate being deleted — shown in the default body copy. */
  estimateName: string
  /** Whether the confirm action is currently in-flight. */
  isDeleting: boolean
  /** Inline error message shown if the action failed; null = no error. */
  errorMessage: string | null
  /** Called when the user confirms (clicks the confirm button). */
  onConfirm: () => void
  /** Called when the user cancels (clicks "Cancel", "×", or presses Escape). */
  onCancel: () => void
  /** Dialog heading. Defaults to today's exact copy: "Delete estimate?" */
  title?: string
  /**
   * Body copy. Defaults to today's exact copy, built from `estimateName`
   * ("'{name}' will be permanently deleted. This cannot be undone."). Pass a
   * fully-composed string (e.g. "{email} will lose access …") for other flows.
   */
  bodyText?: string
  /** Confirm-button label shown in the idle state. Defaults to "Delete". */
  confirmLabel?: string
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function ConfirmDeleteModal({
  estimateName,
  isDeleting,
  errorMessage,
  onConfirm,
  onCancel,
  title = 'Delete estimate?',
  bodyText,
  confirmLabel = 'Delete',
}: ConfirmDeleteModalProps) {
  const cancelBtnRef = useRef<HTMLButtonElement>(null)
  const deleteBtnRef = useRef<HTMLButtonElement>(null)

  // Focus Cancel on mount — safe default (design.md a11y: "Cancel is the default focus").
  useEffect(() => {
    cancelBtnRef.current?.focus()
  }, [])

  // Keyboard: Escape = Cancel; Tab / Shift+Tab trapped within the two buttons.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onCancel()
        return
      }

      // Focus trap: keep Tab cycling only between Cancel and Delete.
      if (e.key !== 'Tab') return

      const focusable = [cancelBtnRef.current, deleteBtnRef.current].filter(
        (el): el is HTMLButtonElement => el !== null && !el.disabled,
      )
      if (focusable.length === 0) return

      const first = focusable[0]
      const last = focusable[focusable.length - 1]

      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault()
          last.focus()
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const displayName = estimateName || 'Untitled'
  const body =
    bodyText ??
    `‘${displayName}’ will be permanently deleted. This cannot be undone.`

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onCancel}
      data-testid="confirm-delete-modal"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-delete-title"
        className="bg-ink-soft border border-rule rounded-lg shadow-2xl w-full max-w-sm mx-4 p-5"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-3">
          <h2
            id="confirm-delete-title"
            className="font-disp text-sm font-bold text-text"
          >
            {title}
          </h2>
          <button
            onClick={onCancel}
            disabled={isDeleting}
            className="text-muted hover:text-text text-lg leading-none transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            aria-label="Cancel"
          >
            ×
          </button>
        </div>

        {/* Body */}
        <p className="text-sm text-text leading-relaxed mb-4">{body}</p>

        {/* Inline error (between body and footer, per design.md) */}
        {errorMessage && (
          <p
            className="text-sm text-org mb-3"
            role="alert"
            data-testid="confirm-delete-error"
          >
            {errorMessage}
          </p>
        )}

        {/* Footer */}
        <div className="flex items-center justify-end gap-3">
          <button
            ref={cancelBtnRef}
            onClick={onCancel}
            disabled={isDeleting}
            data-testid="confirm-delete-cancel"
            className="py-2 px-4 text-sm font-medium border border-rule text-muted hover:text-text transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Cancel
          </button>
          <button
            ref={deleteBtnRef}
            onClick={onConfirm}
            disabled={isDeleting}
            data-testid="confirm-delete-confirm"
            className="py-2 px-4 text-sm font-medium text-red border border-red/50 hover:bg-red/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {isDeleting ? (
              <span className="flex items-center gap-2">
                <span
                  className="inline-block w-3 h-3 border-2 border-red border-t-transparent rounded-full animate-spin"
                  aria-hidden="true"
                />
                Deleting…
              </span>
            ) : (
              confirmLabel
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
