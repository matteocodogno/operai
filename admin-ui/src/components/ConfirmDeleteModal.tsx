/**
 * ConfirmDeleteModal — accessible confirmation dialog for destructive admin
 * actions (delete role / delete department — T15, specs/004-auth-roles-permissions,
 * design.md Dialog D1).
 *
 * Ported pattern from `estimai-ui/src/components/ConfirmDeleteModal.tsx`
 * (same props shape, same idle/deleting/error states, same focus-trap and
 * keyboard contract) — admin-ui cannot import across the Module Federation
 * boundary (ADR-0006), so this is a near-verbatim re-authoring, generalised
 * from "estimate" to any named entity (role/department) via `entityLabel` +
 * `itemName` props.
 *
 * Deliberate a11y refinement over the source pattern (design.md
 * "Accessibility — Confirmation / guardrail dialogs"): `role="alertdialog"`
 * instead of `role="dialog"` — per WAI-ARIA authoring practices, alertdialog
 * is correct when a dialog interrupts to demand acknowledgement of something
 * consequential (a destructive delete). Scoped to admin-ui's own copy only —
 * not a retroactive change to estimai-ui's original.
 *
 * Presentational: all data and callbacks arrive via props. The screen that
 * uses this owns the state and the API call (later tasks, T17/T19).
 *
 * A11y:
 *   • role="alertdialog" aria-modal="true" aria-labelledby + aria-describedby
 *   • Focus trap: Tab cycles only between Cancel and Delete while open.
 *   • Default focus: "Cancel" (safe default — avoids accidental destruction).
 *   • Escape = Cancel; no delete is triggered.
 *
 * States:
 *   • idle      — title + body + Cancel + Delete buttons
 *   • deleting  — "Deleting…" + spinner, both buttons disabled
 *   • error     — inline error text between body and footer; both buttons re-enabled
 *
 * Styling note: colors/fonts are applied via the shared stylesheet's plain
 * CSS custom properties (`var(--text)`, `var(--red)`, …) rather than
 * Tailwind's palette-specific utility classes, mirroring App.tsx's
 * documented reasoning — those utilities only exist in a build that
 * processed `shell/tokens.css`'s `@theme` block through Tailwind's compiler,
 * which admin-ui's own build never does (the tokens arrive as a runtime
 * federated CSS import). Generic layout/spacing/type-scale Tailwind
 * utilities are used freely.
 */

import { useEffect, useRef } from 'react'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ConfirmDeleteModalProps = {
  /** Noun describing the kind of entity being deleted (e.g. "role", "department"). */
  entityLabel: string
  /** Name of the entity being deleted — shown in the body copy. */
  itemName: string
  /** Whether the DELETE request is currently in-flight. */
  isDeleting: boolean
  /** Inline error message shown if the DELETE request failed; null = no error. */
  errorMessage: string | null
  /** Called when the user confirms deletion (clicks "Delete"). */
  onConfirm: () => void
  /** Called when the user cancels (clicks "Cancel", "×", or presses Escape). */
  onCancel: () => void
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function ConfirmDeleteModal({
  entityLabel,
  itemName,
  isDeleting,
  errorMessage,
  onConfirm,
  onCancel,
}: ConfirmDeleteModalProps) {
  const cancelBtnRef = useRef<HTMLButtonElement>(null)
  const deleteBtnRef = useRef<HTMLButtonElement>(null)

  // Focus Cancel on mount — safe default.
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

  const displayName = itemName || 'Untitled'

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center backdrop-blur-sm"
      style={{ backgroundColor: 'rgba(0, 0, 0, 0.6)' }}
      onClick={onCancel}
      data-testid="confirm-delete-modal"
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-delete-title"
        aria-describedby="confirm-delete-body"
        className="border rounded-lg shadow-2xl w-full max-w-sm mx-4 p-5"
        style={{ backgroundColor: 'var(--ink-soft)', borderColor: 'var(--rule)' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-3">
          <h2
            id="confirm-delete-title"
            className="text-sm font-bold"
            style={{ fontFamily: 'var(--disp)', color: 'var(--text)' }}
          >
            Delete {entityLabel}?
          </h2>
          <button
            onClick={onCancel}
            disabled={isDeleting}
            className="text-lg leading-none transition-opacity hover:opacity-80 disabled:opacity-40 disabled:cursor-not-allowed"
            style={{ color: 'var(--muted)' }}
            aria-label="Cancel"
          >
            ×
          </button>
        </div>

        {/* Body */}
        <p
          id="confirm-delete-body"
          className="text-sm leading-relaxed mb-4"
          style={{ color: 'var(--text)' }}
        >
          &lsquo;{displayName}&rsquo; will be permanently deleted. This cannot be undone.
        </p>

        {/* Inline error (between body and footer) */}
        {errorMessage && (
          <p
            className="text-sm mb-3"
            style={{ color: 'var(--org)' }}
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
            className="py-2 px-4 text-sm font-medium border transition-opacity hover:opacity-80 disabled:opacity-40 disabled:cursor-not-allowed"
            style={{ borderColor: 'var(--rule)', color: 'var(--muted)' }}
          >
            Cancel
          </button>
          <button
            ref={deleteBtnRef}
            onClick={onConfirm}
            disabled={isDeleting}
            data-testid="confirm-delete-confirm"
            className="py-2 px-4 text-sm font-medium border transition-opacity hover:opacity-80 disabled:opacity-40 disabled:cursor-not-allowed"
            style={{ color: 'var(--red)', borderColor: 'var(--red)' }}
          >
            {isDeleting ? (
              <span className="flex items-center gap-2">
                <span
                  className="inline-block w-3 h-3 border-2 rounded-full animate-spin"
                  style={{ borderColor: 'var(--red)', borderTopColor: 'transparent' }}
                  aria-hidden="true"
                />
                Deleting…
              </span>
            ) : (
              'Delete'
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
