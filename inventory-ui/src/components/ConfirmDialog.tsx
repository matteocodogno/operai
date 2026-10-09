/**
 * ConfirmDialog — the generic confirm `alertdialog` (T25, specs/015-hardware-
 * inventory; design.md § Component inventory: "Confirm dialogs (return, lost,
 * cancel assignment, decline) — refund-ui/src/components/ConfirmDeleteModal.tsx
 * (generic title/body/tone props)").
 *
 * Re-authored from refund-ui's ConfirmDeleteModal with the same props and
 * behaviour (ADR-0006: no cross-remote imports): Cancel is the default focus,
 * Escape / backdrop / × cancel, Tab is trapped between the two buttons, an
 * in-flight state disables both and shows a spinner, an inline `role="alert"`
 * error sits above the footer. The default copy is the hard-delete wording;
 * every inventory use overrides `title`, `body`, `confirmLabel` and
 * `confirmingLabel` (`isDeleting` simply means "the request is in flight").
 *
 * Added for design.md § Accessibility ("every dialog"):
 *   - in flight the dialog is not dismissible — Escape and the backdrop are
 *     no-ops, and the confirm button is `aria-busy`;
 *   - closing returns focus to the element that had it when the dialog opened,
 *     if it is still in the page (else the page moves focus to its heading).
 */

import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { strings } from '../strings'

export type ConfirmDialogTone = 'destructive' | 'positive'

export type ConfirmDialogProps = {
  /** Noun describing the kind of entity being acted on (e.g. "assignment"). */
  entityLabel: string
  /** Name of the entity — shown in the default body copy (ignored when `body` is supplied). */
  itemName: string
  /** Whether the request is currently in flight. */
  isDeleting: boolean
  /** Inline error message shown if the request failed; null = no error. */
  errorMessage: string | null
  /** Called when the user confirms. */
  onConfirm: () => void
  /** Called when the user cancels (clicks "Cancel", "×", the backdrop, or presses Escape). */
  onCancel: () => void
  /** Overrides the default body copy. */
  body?: ReactNode
  /** Confirm-button variant: `'destructive'` -> `btn-danger` (default), `'positive'` -> `btn-primary`. */
  tone?: ConfirmDialogTone
  /** Overrides the default `title(entityLabel)` heading. */
  title?: ReactNode
  /** Overrides the default "Delete" confirm-button label. */
  confirmLabel?: string
  /** Overrides the default "Deleting…" in-flight label. */
  confirmingLabel?: string
  /** Namespaces every `data-testid`/internal id this dialog renders. Defaults to `'confirm-delete'`. */
  testIdPrefix?: string
}

export default function ConfirmDialog({
  entityLabel,
  itemName,
  isDeleting,
  errorMessage,
  onConfirm,
  onCancel,
  body,
  tone = 'destructive',
  title,
  confirmLabel,
  confirmingLabel,
  testIdPrefix = 'confirm-delete',
}: ConfirmDialogProps) {
  const cancelBtnRef = useRef<HTMLButtonElement>(null)
  const confirmBtnRef = useRef<HTMLButtonElement>(null)
  const t = strings.common.confirmDialog
  const confirmVariant = tone === 'positive' ? 'btn-primary' : 'btn-danger'
  const titleId = `${testIdPrefix}-title`
  const bodyId = `${testIdPrefix}-body`

  // Remember what had focus (the trigger) and give it back on close. Declared
  // before the focus-Cancel effect so it reads the trigger, not the dialog.
  useEffect(() => {
    const trigger = document.activeElement
    return () => {
      if (trigger instanceof HTMLElement && trigger !== document.body && trigger.isConnected) trigger.focus()
    }
  }, [])

  // Focus Cancel on mount — the safe default.
  useEffect(() => {
    cancelBtnRef.current?.focus()
  }, [])

  // Keyboard: Escape = Cancel (unless in flight); Tab / Shift+Tab trapped within the two buttons.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        if (!isDeleting) onCancel()
        return
      }

      if (e.key !== 'Tab') return

      const focusable = [cancelBtnRef.current, confirmBtnRef.current].filter(
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
      } else if (document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel, isDeleting])

  const displayName = itemName || t.untitledFallback

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center backdrop-blur-sm"
      style={{ backgroundColor: 'rgba(0, 0, 0, 0.6)' }}
      onClick={() => {
        if (!isDeleting) onCancel()
      }}
      data-testid={`${testIdPrefix}-modal`}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        className="border rounded-lg shadow-2xl w-full max-w-sm mx-4 p-5"
        style={{ backgroundColor: 'var(--ink-soft)', borderColor: 'var(--rule)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <h2 id={titleId} className="text-sm font-bold" style={{ fontFamily: 'var(--disp)', color: 'var(--text)' }}>
            {title ?? t.title(entityLabel)}
          </h2>
          <button
            onClick={onCancel}
            disabled={isDeleting}
            className="btn btn-ghost btn-icon"
            aria-label={t.cancelAriaLabel}
          >
            ×
          </button>
        </div>

        {/* A <div>, not a <p>, so an overriding `body` can nest block content; aria-describedby targets it either way. */}
        <div id={bodyId} className="text-sm leading-relaxed mb-4" style={{ color: 'var(--text)' }}>
          {body ?? <p>{t.defaultBody(displayName)}</p>}
        </div>

        {errorMessage && (
          <p
            className="text-sm mb-3"
            style={{ color: 'var(--org)' }}
            role="alert"
            data-testid={`${testIdPrefix}-error`}
          >
            {errorMessage}
          </p>
        )}

        <div className="flex items-center justify-end gap-3">
          <button
            ref={cancelBtnRef}
            onClick={onCancel}
            disabled={isDeleting}
            data-testid={`${testIdPrefix}-cancel`}
            className="btn btn-ghost"
          >
            {t.cancelLabel}
          </button>
          <button
            ref={confirmBtnRef}
            onClick={onConfirm}
            disabled={isDeleting}
            aria-busy={isDeleting || undefined}
            data-testid={`${testIdPrefix}-confirm`}
            className={`btn ${confirmVariant}`}
          >
            {isDeleting ? (
              <span className="flex items-center gap-2">
                <span
                  className="inline-block w-3 h-3 border-2 rounded-full animate-spin motion-reduce:animate-none"
                  style={{ borderColor: 'currentColor', borderTopColor: 'transparent' }}
                  aria-hidden="true"
                />
                {confirmingLabel ?? t.deletingLabel}
              </span>
            ) : (
              (confirmLabel ?? t.deleteLabel)
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
