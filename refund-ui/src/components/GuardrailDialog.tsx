/**
 * GuardrailDialog — acknowledge-only dialog for a server-side guardrail that
 * genuinely blocked an action (T15, specs/007-refund-service/tasks.md,
 * design.md F2 steps 2/6, F6 step 6: "409 on either action … GuardrailDialog";
 * Component inventory: "GuardrailDialog — Reuse (ported pattern) —
 * admin-ui/src/components/GuardrailDialog.tsx — 409-race, genuinely-blocked
 * cases").
 *
 * Ported pattern: `refund-ui` cannot import admin-ui's source across the
 * Module Federation boundary (ADR-0006), so this is a near-verbatim
 * re-authoring of `admin-ui/src/components/GuardrailDialog.tsx` — same
 * props shape, same acknowledge-only contract.
 *
 * Fires for every 409-race case this feature's design names: withdraw after
 * a decision (F2 step 2), a stale-UI submit/edit/delete attempt on an
 * already-decided request (F2 step 3), and an accounting decision race
 * (F6 step 6) — all cases where the response means the action is simply not
 * possible right now; there is no "proceed anyway" override. Unlike
 * `ConfirmDeleteModal`, there is only a single acknowledgement, no
 * confirm/cancel pair.
 *
 * Presentational: all data and callbacks arrive via props. The screen that
 * uses this (T16/T18) owns the state — it must NOT discard in-progress edits
 * when this dialog is dismissed; it should reload the record so the screen
 * reflects the real, current (decided, read-only) state (design.md F2 step 2).
 *
 * Copy sourced from `strings.ts` for the one static default
 * (`acknowledgeLabel`) — `title`/`message` are always caller-supplied,
 * dialog-specific text (different for withdraw-race vs. decision-race), so
 * they arrive as props exactly as the source component already does.
 *
 * A11y:
 *   • role="alertdialog" aria-modal="true" aria-labelledby + aria-describedby
 *   • Full Tab focus trap (kept on the single "OK" button — there is nothing
 *     else to trap between).
 *   • Escape triggers the safe action — here that IS "OK".
 *   • Default focus on "OK".
 *   • Backdrop click matches Escape's behavior (also acknowledges).
 */

import { useEffect, useRef } from 'react'
import { strings } from '../strings'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GuardrailDialogProps = {
  /** Short dialog title (e.g. "This request was already decided"). */
  title: string
  /** Explanatory message — why the action was blocked. */
  message: string
  /** Called when the user acknowledges (clicks "OK", presses Escape, or clicks the backdrop). */
  onAcknowledge: () => void
  /** Label for the acknowledge button. Defaults to strings.components.guardrailDialog.defaultAcknowledgeLabel. */
  acknowledgeLabel?: string
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function GuardrailDialog({
  title,
  message,
  onAcknowledge,
  acknowledgeLabel = strings.components.guardrailDialog.defaultAcknowledgeLabel,
}: GuardrailDialogProps) {
  const okBtnRef = useRef<HTMLButtonElement>(null)

  // Focus the (only) action on mount — default focus.
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
