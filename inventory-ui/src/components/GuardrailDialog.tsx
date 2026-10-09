/**
 * GuardrailDialog — the single-action conflict acknowledgement (T25,
 * specs/015-hardware-inventory; design.md § Component inventory: "Conflict
 * acknowledgement — refund-ui/src/components/GuardrailDialog.tsx"). Every 409
 * in the error catalogue (`invalid_transition`, `assignment_pending`,
 * `asset_disposed`, `already_closed`) lands here, then the page refetches.
 *
 * Re-authored from refund-ui's component with the same props and behaviour
 * (ADR-0006: no cross-remote imports): an `alertdialog` with one action that is
 * focused on open; Escape and the backdrop acknowledge (there is no unsafe
 * action to escape to); Tab is pinned on the single button. Added: closing
 * returns focus to the element that had it before, when it is still in the page
 * (design.md § Accessibility).
 */

import { useEffect, useRef } from 'react'
import { strings } from '../strings'

export type GuardrailDialogProps = {
  /** Short dialog title (e.g. "This asset changed"). */
  title: string
  /** Explanatory message — why the action was blocked. */
  message: string
  /** Called when the user acknowledges (clicks "OK", presses Escape, or clicks the backdrop). */
  onAcknowledge: () => void
  /** Label for the acknowledge button. Defaults to strings.common.guardrailDialog.defaultAcknowledgeLabel. */
  acknowledgeLabel?: string
}

export default function GuardrailDialog({
  title,
  message,
  onAcknowledge,
  acknowledgeLabel = strings.common.guardrailDialog.defaultAcknowledgeLabel,
}: GuardrailDialogProps) {
  const okBtnRef = useRef<HTMLButtonElement>(null)

  // Remember what had focus (the trigger) and give it back on close. Declared
  // before the focus-OK effect so it reads the trigger, not the dialog.
  useEffect(() => {
    const trigger = document.activeElement
    return () => {
      if (trigger instanceof HTMLElement && trigger !== document.body && trigger.isConnected) trigger.focus()
    }
  }, [])

  // Focus the (only) action on mount — default focus.
  useEffect(() => {
    okBtnRef.current?.focus()
  }, [])

  // Escape acknowledges; Tab is trapped on the single button.
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
        <h2
          id="guardrail-dialog-title"
          className="text-sm font-bold mb-3"
          style={{ fontFamily: 'var(--disp)', color: 'var(--text)' }}
        >
          {title}
        </h2>

        <p id="guardrail-dialog-message" className="text-sm leading-relaxed mb-4" style={{ color: 'var(--text)' }}>
          {message}
        </p>

        {/* Single acknowledge action, no destructive counterpart */}
        <div className="flex items-center justify-end">
          <button
            ref={okBtnRef}
            onClick={onAcknowledge}
            data-testid="guardrail-dialog-ok"
            className="btn btn-primary"
          >
            {acknowledgeLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
