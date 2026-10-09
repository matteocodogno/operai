/**
 * IrreversibleActionDialog — the acknowledged confirm for acts that cannot be
 * undone (T26, specs/015-hardware-inventory; design.md § NEW components:
 * "generalises MarkPaidDialog (checkbox-acknowledged, trapped tab sequence)
 * which is hard-wired to batch subtotals; three acts here need it, plus a form
 * slot"). Dispose, close fiscal year and the like render through it.
 *
 * Presentational: the page owns the request, `isConfirming` and the error, and
 * keeps the dialog mounted on a failure so a form slot's values survive.
 *
 * A11y (design.md § Accessibility "Dialogs"):
 *   - `role="alertdialog"`, `aria-modal`, labelled by the title and described
 *     by the consequence;
 *   - Confirm is disabled until the acknowledgement checkbox is checked; the
 *     checkbox label is the whole sentence (`acknowledgeLabel`);
 *   - default focus on Cancel for a pure confirm, on the first field when a
 *     form slot is present;
 *   - Tab / Shift+Tab are trapped over the REAL focusable set, so a disabled
 *     Confirm is not a stop (as in MarkPaidDialog), and focus that has escaped
 *     is pulled back in;
 *   - Escape and the backdrop cancel — except in flight, when the dialog is
 *     not dismissible, the fields, checkbox and buttons are locked and Confirm
 *     is `aria-busy`;
 *   - closing returns focus to the element that had it when the dialog opened,
 *     if it is still in the page (else the page moves focus to its heading).
 *
 * The focus-trap and focus-return effects are the same ones FormModal carries;
 * a third dialog shell would be the moment to extract them into a hook.
 */

import { useEffect, useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { strings } from '../strings'

export type IrreversibleActionDialogProps = {
  /** The dialog's accessible name and heading, e.g. "Close fiscal year 2025?". */
  title: string
  /** What happens and that it cannot be undone; the dialog's description. */
  consequence: ReactNode
  /** The acknowledgement sentence, used whole as the checkbox label. */
  acknowledgeLabel: string
  confirmLabel: string
  /** Confirm button label in flight, e.g. "Closing…". */
  confirmingLabel: string
  /** Whether the request is currently in flight. */
  isConfirming: boolean
  /** Inline error from the last attempt (503, conflict, network); null = none. */
  errorMessage: string | null
  onConfirm: () => void
  /** Called on Cancel, ×, the backdrop and Escape — never while `isConfirming`. */
  onCancel: () => void
  /** Form slot: fields the act needs (e.g. disposal date and reason), disabled in flight. */
  children?: ReactNode
  /** Namespaces the `data-testid`s. Defaults to `'irreversible-dialog'`. */
  testIdPrefix?: string
}

const FOCUSABLE = 'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])'

export default function IrreversibleActionDialog({
  title,
  consequence,
  acknowledgeLabel,
  confirmLabel,
  confirmingLabel,
  isConfirming,
  errorMessage,
  onConfirm,
  onCancel,
  children,
  testIdPrefix = 'irreversible-dialog',
}: IrreversibleActionDialogProps) {
  const t = strings.common.formModal
  const baseId = useId()
  const titleId = `${baseId}-title`
  const bodyId = `${baseId}-body`
  const checkboxId = `${baseId}-ack`
  const [acknowledged, setAcknowledged] = useState(false)
  const dialogRef = useRef<HTMLDivElement>(null)
  const slotRef = useRef<HTMLFieldSetElement>(null)
  const cancelBtnRef = useRef<HTMLButtonElement>(null)

  const canConfirm = acknowledged && !isConfirming

  // Remember what had focus (the trigger) and give it back on close. Declared
  // before the default-focus effect so it reads the trigger, not the dialog.
  useEffect(() => {
    const trigger = document.activeElement
    return () => {
      if (trigger instanceof HTMLElement && trigger !== document.body && trigger.isConnected) trigger.focus()
    }
  }, [])

  // Default focus: the first field of a form slot, else Cancel (the safe default).
  useEffect(() => {
    const field = slotRef.current?.querySelector<HTMLElement>(
      '[data-autofocus]:not(:disabled), input:not([type="hidden"]):not(:disabled), select:not(:disabled), textarea:not(:disabled)',
    )
    ;(field ?? cancelBtnRef.current)?.focus()
  }, [])

  // Keyboard: Escape = Cancel (unless in flight); Tab trapped over the real focusable set.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        if (!isConfirming) onCancel()
        return
      }

      if (e.key !== 'Tab') return

      const dialog = dialogRef.current
      if (!dialog) return
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => !el.matches(':disabled') && !(el instanceof HTMLInputElement && el.type === 'hidden'),
      )
      if (focusable.length === 0) return

      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const active = document.activeElement

      if (!(active instanceof Node) || !dialog.contains(active)) {
        e.preventDefault()
        first.focus()
      } else if (e.shiftKey) {
        if (active === first) {
          e.preventDefault()
          last.focus()
        }
      } else if (active === last) {
        e.preventDefault()
        first.focus()
      }
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel, isConfirming])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center backdrop-blur-sm"
      style={{ backgroundColor: 'rgba(0, 0, 0, 0.6)' }}
      onClick={() => {
        if (!isConfirming) onCancel()
      }}
      data-testid={`${testIdPrefix}-backdrop`}
    >
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        className="border rounded-lg shadow-2xl w-full max-w-md mx-4 p-5 max-h-[90vh] overflow-y-auto"
        style={{ backgroundColor: 'var(--ink-soft)', borderColor: 'var(--rule)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (canConfirm) onConfirm()
          }}
        >
          <div className="flex items-center justify-between mb-3">
            <h2 id={titleId} className="text-sm font-bold" style={{ fontFamily: 'var(--disp)', color: 'var(--text)' }}>
              {title}
            </h2>
            <button
              type="button"
              onClick={onCancel}
              disabled={isConfirming}
              aria-label={t.closeAriaLabel}
              className="btn btn-ghost btn-icon"
            >
              ×
            </button>
          </div>

          <div id={bodyId} className="text-sm leading-relaxed mb-3" style={{ color: 'var(--text)' }}>
            {consequence}
          </div>

          {children !== undefined && children !== null && (
            <fieldset
              ref={slotRef}
              disabled={isConfirming}
              className="m-0 mb-3 flex min-w-0 flex-col gap-3 border-0 p-0"
            >
              {children}
            </fieldset>
          )}

          <div className="flex items-start gap-2 mb-3">
            <input
              id={checkboxId}
              type="checkbox"
              checked={acknowledged}
              disabled={isConfirming}
              onChange={(e) => setAcknowledged(e.target.checked)}
              data-testid={`${testIdPrefix}-checkbox`}
              className="mt-0.5"
            />
            <label htmlFor={checkboxId} className="text-sm" style={{ color: 'var(--text)' }}>
              {acknowledgeLabel}
            </label>
          </div>

          {errorMessage && (
            <p
              className="text-sm mb-3"
              role="alert"
              data-testid={`${testIdPrefix}-error`}
              style={{ color: 'var(--org)' }}
            >
              {errorMessage}
            </p>
          )}

          <div className="flex items-center justify-end gap-3">
            <button
              ref={cancelBtnRef}
              type="button"
              onClick={onCancel}
              disabled={isConfirming}
              data-testid={`${testIdPrefix}-cancel`}
              className="btn btn-ghost"
            >
              {t.cancelLabel}
            </button>
            <button
              type="submit"
              disabled={!canConfirm}
              aria-busy={isConfirming || undefined}
              data-testid={`${testIdPrefix}-confirm`}
              className="btn btn-danger"
            >
              {isConfirming ? (
                <span className="flex items-center gap-2">
                  <span
                    className="inline-block w-3 h-3 border-2 rounded-full animate-spin motion-reduce:animate-none"
                    style={{ borderColor: 'currentColor', borderTopColor: 'transparent' }}
                    aria-hidden="true"
                  />
                  {confirmingLabel}
                </span>
              ) : (
                confirmLabel
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
