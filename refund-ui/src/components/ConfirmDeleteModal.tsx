/**
 * ConfirmDeleteModal — accessible confirmation dialog for a destructive
 * refund-ui action ("Delete request" — T15, specs/007-refund-service/tasks.md,
 * design.md F1 step 7: "'Delete request' → ConfirmDeleteModal (ported, own
 * copy) … used as-is"; Component inventory: "ConfirmDeleteModal — Reuse
 * (ported pattern) — admin-ui/src/components/ConfirmDeleteModal.tsx").
 *
 * Ported pattern: `refund-ui` cannot import admin-ui's source across the
 * Module Federation boundary (ADR-0006), so this is a near-verbatim
 * re-authoring of `admin-ui/src/components/ConfirmDeleteModal.tsx` (itself
 * ported from `estimai-ui`) — same props shape, same idle/deleting/error
 * states, same focus-trap and keyboard contract, generalised from "role"/
 * "department" to any named entity (here: a draft refund request) via
 * `entityLabel` + `itemName`. Used as-is by T16's "Delete request" flow —
 * design.md does not ask for an extended variant here (unlike `ApproveDialog`,
 * T18's ported+extended sibling).
 *
 * Presentational: all data and callbacks arrive via props. The screen that
 * uses this (T16) owns the state and the `DELETE /requests/:id` call.
 *
 * Copy sourced from `strings.ts` (T14/T15 convention: no hardcoded UI
 * strings) — `title`/`defaultBody` are functions because their exact wording
 * depends on the caller-supplied `entityLabel`/`itemName` (see strings.ts's
 * own doc comment on why these are functions, not template literals inlined
 * here).
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
 */

import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { strings } from '../strings'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ConfirmDeleteModalProps = {
  /** Noun describing the kind of entity being deleted (e.g. "request"). */
  entityLabel: string
  /** Name of the entity being deleted — shown in the default body copy (ignored when `body` is supplied). */
  itemName: string
  /** Whether the DELETE request is currently in-flight. */
  isDeleting: boolean
  /** Inline error message shown if the DELETE request failed; null = no error. */
  errorMessage: string | null
  /** Called when the user confirms deletion (clicks "Delete"). */
  onConfirm: () => void
  /** Called when the user cancels (clicks "Cancel", "×", or presses Escape). */
  onCancel: () => void
  /** Overrides the default body copy. Omit to keep the default hard-delete wording. */
  body?: ReactNode
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
  body,
}: ConfirmDeleteModalProps) {
  const cancelBtnRef = useRef<HTMLButtonElement>(null)
  const deleteBtnRef = useRef<HTMLButtonElement>(null)
  const t = strings.components.confirmDeleteModal

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

  const displayName = itemName || t.untitledFallback

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
            {t.title(entityLabel)}
          </h2>
          <button
            onClick={onCancel}
            disabled={isDeleting}
            className="text-lg leading-none transition-opacity hover:opacity-80 disabled:opacity-40 disabled:cursor-not-allowed"
            style={{ color: 'var(--muted)' }}
            aria-label={t.cancelAriaLabel}
          >
            ×
          </button>
        </div>

        {/* Body — a <div>, not a <p>, so an overriding `body` can nest block
            content without invalid markup; aria-describedby targets it either way. */}
        <div id="confirm-delete-body" className="text-sm leading-relaxed mb-4" style={{ color: 'var(--text)' }}>
          {body ?? <p>{t.defaultBody(displayName)}</p>}
        </div>

        {/* Inline error (between body and footer) */}
        {errorMessage && (
          <p className="text-sm mb-3" style={{ color: 'var(--org)' }} role="alert" data-testid="confirm-delete-error">
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
            {t.cancelLabel}
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
                  className="inline-block w-3 h-3 border-2 rounded-full animate-spin motion-reduce:animate-none"
                  style={{ borderColor: 'var(--red)', borderTopColor: 'transparent' }}
                  aria-hidden="true"
                />
                {t.deletingLabel}
              </span>
            ) : (
              t.deleteLabel
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
