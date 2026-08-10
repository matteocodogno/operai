/**
 * RejectDialog — destructive-outcome confirm dialog with an embedded,
 * REQUIRED motivation textarea (T18, specs/007-refund-service/tasks.md;
 * design.md F6 step 5, Component inventory: "RejectDialog — NEW — No
 * in-repo dialog combines a destructive confirm with an embedded
 * required-field form … ConfirmDeleteModal's shell (backdrop/trap/Escape/
 * focus) + InviteUserModal's disabled-until-valid submit, composed").
 *
 * Genuinely NEW (not a `ConfirmDeleteModal` extension like `ApproveDialog`)
 * because the tab sequence has THREE stops (textarea, Cancel, Confirm), not
 * two — `ConfirmDeleteModal`'s trap is hardcoded to exactly two buttons.
 *
 * The Confirm button stays disabled until the textarea is non-empty
 * (client-side; the server's 422 on an empty motivation is defense-in-depth,
 * AC-7.3) — a screen-reader/keyboard user tabbing to a disabled control gets
 * an immediately legible reason via the dialog's own instructional text
 * (design.md Accessibility).
 *
 * A11y: role="alertdialog", aria-modal, aria-labelledby/aria-describedby,
 * a full Tab focus trap across [textarea, Cancel, Confirm] (Confirm
 * excluded while disabled, the same `.filter(!el.disabled)` technique
 * `ConfirmDeleteModal` uses), Escape = Cancel, default focus lands on the
 * textarea — the user's very next action is always "type the reason", so
 * there is no safety reason to default elsewhere the way `ConfirmDeleteModal`
 * defaults to Cancel for an instantly-destructive action.
 */

import { useEffect, useRef, useState } from 'react'
import { strings } from '../strings'

export type RejectDialogProps = {
  /** The owning employee's display name — interpolated into the body copy. */
  employeeName: string
  isDeciding: boolean
  errorMessage: string | null
  onConfirm: (motivation: string) => void
  onCancel: () => void
}

type FocusableRef = { current: HTMLTextAreaElement | HTMLButtonElement | null; disabled: boolean }

export default function RejectDialog({
  employeeName,
  isDeciding,
  errorMessage,
  onConfirm,
  onCancel,
}: RejectDialogProps) {
  const t = strings.pages.reviewDetail.rejectDialog
  const [motivation, setMotivation] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const cancelBtnRef = useRef<HTMLButtonElement>(null)
  const confirmBtnRef = useRef<HTMLButtonElement>(null)

  const canConfirm = motivation.trim().length > 0 && !isDeciding

  // Default focus on the textarea (see this file's doc comment).
  useEffect(() => {
    textareaRef.current?.focus()
  }, [])

  // Keyboard: Escape = Cancel; Tab / Shift+Tab trapped within [textarea, Cancel, Confirm].
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onCancel()
        return
      }

      if (e.key !== 'Tab') return

      const candidates: FocusableRef[] = [
        { current: textareaRef.current, disabled: isDeciding },
        { current: cancelBtnRef.current, disabled: isDeciding },
        { current: confirmBtnRef.current, disabled: !canConfirm },
      ]
      const focusable = candidates
        .filter(
          (c): c is FocusableRef & { current: HTMLTextAreaElement | HTMLButtonElement } =>
            c.current !== null && !c.disabled,
        )
        .map((c) => c.current)

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
  }, [onCancel, isDeciding, canConfirm])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center backdrop-blur-sm"
      style={{ backgroundColor: 'rgba(0, 0, 0, 0.6)' }}
      onClick={onCancel}
      data-testid="reject-dialog-modal"
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="reject-dialog-title"
        aria-describedby="reject-dialog-body"
        className="border rounded-lg shadow-2xl w-full max-w-sm mx-4 p-5"
        style={{ backgroundColor: 'var(--ink-soft)', borderColor: 'var(--rule)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <h2
            id="reject-dialog-title"
            className="text-sm font-bold"
            style={{ fontFamily: 'var(--disp)', color: 'var(--text)' }}
          >
            {t.title}
          </h2>
          <button
            onClick={onCancel}
            disabled={isDeciding}
            aria-label={t.cancelAriaLabel}
            className="text-lg leading-none transition-opacity hover:opacity-80 disabled:opacity-40 disabled:cursor-not-allowed"
            style={{ color: 'var(--muted)' }}
          >
            ×
          </button>
        </div>

        <div id="reject-dialog-body" className="text-sm leading-relaxed mb-3" style={{ color: 'var(--text)' }}>
          <p>{t.body(employeeName)}</p>
        </div>

        <div className="flex flex-col gap-1 mb-3">
          <label htmlFor="reject-dialog-motivation" className="text-xs font-medium" style={{ color: 'var(--soft)' }}>
            {t.motivationLabel}
          </label>
          <textarea
            ref={textareaRef}
            id="reject-dialog-motivation"
            required
            aria-required="true"
            rows={3}
            value={motivation}
            disabled={isDeciding}
            onChange={(e) => setMotivation(e.target.value)}
            data-testid="reject-dialog-motivation"
            className="text-sm px-2.5 py-1.5 border rounded resize-y"
            style={{ borderColor: 'var(--rule)', color: 'var(--text)', backgroundColor: 'var(--ink)' }}
          />
          <p className="text-[11px]" style={{ color: 'var(--muted)' }}>
            {t.motivationHelp}
          </p>
        </div>

        {errorMessage && (
          <p className="text-sm mb-3" role="alert" data-testid="reject-dialog-error" style={{ color: 'var(--org)' }}>
            {errorMessage}
          </p>
        )}

        <div className="flex items-center justify-end gap-3">
          <button
            ref={cancelBtnRef}
            onClick={onCancel}
            disabled={isDeciding}
            data-testid="reject-dialog-cancel"
            className="py-2 px-4 text-sm font-medium border transition-opacity hover:opacity-80 disabled:opacity-40 disabled:cursor-not-allowed"
            style={{ borderColor: 'var(--rule)', color: 'var(--muted)' }}
          >
            {t.cancelLabel}
          </button>
          <button
            ref={confirmBtnRef}
            onClick={() => onConfirm(motivation.trim())}
            disabled={!canConfirm}
            data-testid="reject-dialog-confirm"
            className="py-2 px-4 text-sm font-medium border transition-opacity hover:opacity-80 disabled:opacity-40 disabled:cursor-not-allowed"
            style={{ color: 'var(--red)', borderColor: 'var(--red)' }}
          >
            {isDeciding ? (
              <span className="flex items-center gap-2">
                <span
                  className="inline-block w-3 h-3 border-2 rounded-full animate-spin motion-reduce:animate-none"
                  style={{ borderColor: 'var(--red)', borderTopColor: 'transparent' }}
                  aria-hidden="true"
                />
                {t.confirmingLabel}
              </span>
            ) : (
              t.confirmLabel
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
