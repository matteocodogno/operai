/**
 * GuardrailDialog — acknowledge-only dialog for a server-side guardrail that
 * genuinely blocked an action (T15, specs/004-auth-roles-permissions,
 * design.md Dialog D2: "Guardrail blocked").
 *
 * Fires for the last-admin-removal guard (AC-6.4) and the system-role-delete
 * race (a stale-UI bypass of the disabled-Delete-button guardrail on Screen
 * A2) — both are cases where the `422` means the action is simply not
 * possible right now, there is no "proceed anyway" override. New shape (no
 * existing "blocked, acknowledge-only" dialog in-repo): a single message +
 * a single "OK" acknowledgement, unlike `ConfirmDeleteModal`/Dialog D1 which
 * always has a destructive action to confirm or cancel.
 *
 * Presentational: all data and callbacks arrive via props. The screen that
 * uses this (later tasks, T18/T20) owns the state — it must NOT reset its
 * in-progress edit when this dialog is dismissed (design.md F4: "the
 * in-progress edit is preserved so the admin can adjust and retry").
 *
 * A11y (design.md "Accessibility — Confirmation / guardrail dialogs"):
 *   • role="alertdialog" aria-modal="true" aria-labelledby + aria-describedby
 *   • Full Tab focus trap (kept on the single "OK" button — there is nothing
 *     else to trap between).
 *   • Escape triggers the safe action — here that IS "OK" (D2 has no unsafe
 *     action to escape *to*).
 *   • Default focus on "OK".
 *   • Backdrop click matches Escape's behavior (also acknowledges).
 */

import { useEffect, useRef } from 'react'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GuardrailDialogProps = {
  /** Short dialog title (e.g. "Can't remove the last administrator"). */
  title: string
  /** Explanatory message — why the action was blocked. */
  message: string
  /** Called when the user acknowledges (clicks "OK", presses Escape, or clicks the backdrop). */
  onAcknowledge: () => void
  /** Label for the acknowledge button. Defaults to "OK". */
  acknowledgeLabel?: string
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function GuardrailDialog({
  title,
  message,
  onAcknowledge,
  acknowledgeLabel = 'OK',
}: GuardrailDialogProps) {
  const okBtnRef = useRef<HTMLButtonElement>(null)

  // Focus the (only) action on mount — default focus per design.md.
  useEffect(() => {
    okBtnRef.current?.focus()
  }, [])

  // Escape acknowledges (no unsafe action to escape to); Tab is trapped on
  // the single button since there is nothing else to cycle to.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onAcknowledge()
        return
      }
      if (e.key === 'Tab') {
        e.preventDefault()
        okBtnRef.current?.focus()
      }
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onAcknowledge])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center backdrop-blur-sm"
      style={{ backgroundColor: 'rgba(0, 0, 0, 0.6)' }}
      onClick={onAcknowledge}
      data-testid="guardrail-dialog"
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="guardrail-dialog-title"
        aria-describedby="guardrail-dialog-message"
        className="border rounded-lg shadow-2xl w-full max-w-sm mx-4 p-5"
        style={{ backgroundColor: 'var(--ink-soft)', borderColor: 'var(--rule)' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <h2
          id="guardrail-dialog-title"
          className="text-sm font-bold mb-3"
          style={{ fontFamily: 'var(--disp)', color: 'var(--text)' }}
        >
          {title}
        </h2>

        {/* Body */}
        <p id="guardrail-dialog-message" className="text-sm leading-relaxed mb-4" style={{ color: 'var(--text)' }}>
          {message}
        </p>

        {/* Footer — single acknowledge action, no destructive counterpart */}
        <div className="flex items-center justify-end">
          <button
            ref={okBtnRef}
            onClick={onAcknowledge}
            data-testid="guardrail-dialog-ok"
            className="py-2 px-4 text-sm font-medium border transition-opacity hover:opacity-80"
            style={{ borderColor: 'var(--acc)', color: 'var(--acc)' }}
          >
            {acknowledgeLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
