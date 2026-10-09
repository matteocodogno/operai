/**
 * FormModal — the form `dialog` shell (T25, specs/015-hardware-inventory;
 * design.md § Component inventory: "Form modal pattern —
 * admin-ui/src/components/AddRateEntryModal.tsx"). The Assign, Edit, new-rule
 * and dispose dialogs render their fields inside it.
 *
 * Re-authored from admin-ui's AddRateEntryModal's shell (backdrop,
 * `role="dialog"`, header / body / footer, Escape = Cancel) and made generic:
 * the entity-specific props become `title`, `description`, `children`, the
 * submit labels and `generalError`. Presentational — the page owns the field
 * state and the request, and maps a 422 onto its own field errors; the
 * dialog stays open with every typed value on a failure (design.md § Screens
 * & states), because it never unmounts the children itself.
 *
 * A11y (design.md § Accessibility "Dialogs"):
 *   - `role="dialog"`, `aria-modal`, labelled by the title and, when a notice
 *     is given, described by it (an irreversible-action notice belongs there);
 *   - default focus on the first field (`data-autofocus` wins when a child sets
 *     it; Cancel when the body has no field);
 *   - Tab / Shift+Tab are trapped over the REAL focusable set, so a disabled
 *     submit is not a stop, and focus that has escaped is pulled back in;
 *   - Escape and the backdrop cancel — except in flight, when the dialog is
 *     not dismissible, the fields and buttons are disabled and the submit
 *     button is `aria-busy`;
 *   - a `generalError` is a `role="alert"` above the footer;
 *   - closing returns focus to the element that had it when the dialog opened,
 *     if it is still in the page.
 */

import { useEffect, useId, useRef } from 'react'
import type { ReactNode } from 'react'
import { strings } from '../strings'

export type FormModalProps = {
  /** The dialog's accessible name and heading. */
  title: string
  /** A notice shown under the heading and used as the dialog's description (e.g. "cannot be edited once saved"). */
  description?: ReactNode
  /** The fields. They are disabled as a group while `submitting`. */
  children: ReactNode
  /** Label of the submit button. Defaults to strings.common.formModal.defaultSubmitLabel. */
  submitLabel?: string
  /** Label of the submit button in flight. Defaults to strings.common.formModal.defaultSubmittingLabel. */
  submittingLabel?: string
  /** Whether the request is currently in flight. */
  submitting: boolean
  /** False keeps the submit button disabled (a required field is empty). Defaults to true. */
  canSubmit?: boolean
  /** A non-field error (503, network, a conflict banner); null = none. */
  generalError: string | null
  onSubmit: () => void
  /** Called on Cancel, ×, the backdrop and Escape — never while `submitting`. */
  onCancel: () => void
  /** Namespaces the `data-testid`s. Defaults to `'form-modal'`. */
  testIdPrefix?: string
}

const FOCUSABLE = 'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])'

export default function FormModal({
  title,
  description,
  children,
  submitLabel,
  submittingLabel,
  submitting,
  canSubmit = true,
  generalError,
  onSubmit,
  onCancel,
  testIdPrefix = 'form-modal',
}: FormModalProps) {
  const t = strings.common.formModal
  const baseId = useId()
  const titleId = `${baseId}-title`
  const descriptionId = `${baseId}-description`
  const dialogRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLFieldSetElement>(null)
  const cancelBtnRef = useRef<HTMLButtonElement>(null)

  // Remember what had focus (the trigger) and give it back on close. Declared
  // before the focus-first-field effect so it reads the trigger, not the dialog.
  useEffect(() => {
    const trigger = document.activeElement
    return () => {
      if (trigger instanceof HTMLElement && trigger !== document.body && trigger.isConnected) trigger.focus()
    }
  }, [])

  // Default focus: the first field (or the one marked data-autofocus), else Cancel.
  useEffect(() => {
    const body = bodyRef.current
    const field =
      body?.querySelector<HTMLElement>('[data-autofocus]:not(:disabled)') ??
      body?.querySelector<HTMLElement>(
        'input:not([type="hidden"]):not(:disabled), select:not(:disabled), textarea:not(:disabled)',
      )
    ;(field ?? cancelBtnRef.current)?.focus()
  }, [])

  // Keyboard: Escape = Cancel (unless in flight); Tab trapped over the real focusable set.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        if (!submitting) onCancel()
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
  }, [onCancel, submitting])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center backdrop-blur-sm"
      style={{ backgroundColor: 'rgba(0, 0, 0, 0.6)' }}
      onClick={() => {
        if (!submitting) onCancel()
      }}
      data-testid={`${testIdPrefix}-backdrop`}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        className="border rounded-lg shadow-2xl w-full max-w-md mx-4 p-5 max-h-[90vh] overflow-y-auto"
        style={{ backgroundColor: 'var(--ink-soft)', borderColor: 'var(--rule)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (canSubmit && !submitting) onSubmit()
          }}
        >
          <div className="flex items-center justify-between mb-3">
            <h2 id={titleId} className="text-sm font-bold" style={{ fontFamily: 'var(--disp)', color: 'var(--text)' }}>
              {title}
            </h2>
            <button
              type="button"
              onClick={onCancel}
              disabled={submitting}
              className="btn btn-ghost btn-icon"
              aria-label={t.closeAriaLabel}
            >
              ×
            </button>
          </div>

          {description && (
            <div id={descriptionId} className="text-xs mb-3" style={{ color: 'var(--soft)' }}>
              {description}
            </div>
          )}

          <fieldset ref={bodyRef} disabled={submitting} className="m-0 mb-4 flex min-w-0 flex-col gap-3 border-0 p-0">
            {children}
          </fieldset>

          {generalError && (
            <p
              role="alert"
              data-testid={`${testIdPrefix}-error`}
              className="text-xs mb-3"
              style={{ color: 'var(--red)' }}
            >
              {generalError}
            </p>
          )}

          <div className="flex items-center justify-end gap-3">
            <button
              ref={cancelBtnRef}
              type="button"
              onClick={onCancel}
              disabled={submitting}
              data-testid={`${testIdPrefix}-cancel`}
              className="btn btn-ghost"
            >
              {t.cancelLabel}
            </button>
            <button
              type="submit"
              disabled={!canSubmit || submitting}
              aria-busy={submitting || undefined}
              data-testid={`${testIdPrefix}-submit`}
              className="btn btn-primary"
            >
              {submitting ? (submittingLabel ?? t.defaultSubmittingLabel) : (submitLabel ?? t.defaultSubmitLabel)}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
