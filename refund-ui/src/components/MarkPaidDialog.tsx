/**
 * MarkPaidDialog — the irreversible, money-moving confirm for marking a
 * compiled batch as paid (T12, specs/008-refund-monthly-processing/tasks.md,
 * design.md F4 step 2, Component inventory, Accessibility).
 *
 * Genuinely NEW (not a `ConfirmDeleteModal` extension) for the same
 * structural reason `RejectDialog` couldn't be one either — the tab sequence
 * has THREE stops (checkbox, Cancel, Confirm), not two —
 * `ConfirmDeleteModal`'s trap is hardcoded to exactly two buttons. Ports
 * `RejectDialog`'s disabled-until-valid technique, generalized from a
 * required textarea to a required acknowledgement checkbox.
 *
 * Shows the batch's request count + per-currency totals (`BatchSubtotalsPanel`,
 * reused) so the user isn't confirming blind, the current email delivery
 * status as an FYI line (AC-4.2's "provided they can see that status to act
 * with full information"), explicit consequence copy, and the required
 * acknowledgement checkbox gating Confirm.
 *
 * A11y (design.md "## Accessibility" — "Mark-as-paid confirm"):
 *   - role="alertdialog", aria-modal, aria-labelledby/aria-describedby
 *     covering the consequence copy AND the batch-summary/email-status body.
 *   - Full Tab focus trap across exactly [checkbox, Cancel, Confirm] (Confirm
 *     excluded while disabled, the same `.filter(!el.disabled)` technique
 *     `ConfirmDeleteModal`/`RejectDialog` use), Escape = Cancel.
 *   - Default focus on **Cancel** (not the checkbox) — unlike `RejectDialog`'s
 *     textarea default, a checkbox's very next action (Space) is exactly
 *     what an accidental stray keypress right after the dialog opens could
 *     trigger; defaulting to the safe, inert Cancel avoids that.
 *   - Confirm stays disabled until the checkbox is checked (client-side only
 *     — a purely UI safeguard, not a server-validated field, unlike
 *     `RejectDialog`'s motivation).
 *   - The checkbox's label is the full acknowledgement sentence, not a terse
 *     "Confirm" — a screen-reader user tabbing to it hears the complete
 *     commitment being made.
 */

import { useEffect, useRef, useState } from 'react'
import { strings } from '../strings'
import type { BatchEmailStatus, BatchSubtotal } from '../lib/batchesApi'
import BatchSubtotalsPanel from './BatchSubtotalsPanel'

export type MarkPaidDialogProps = {
  requestCount: number
  subtotals: readonly BatchSubtotal[]
  emailStatus: BatchEmailStatus
  isConfirming: boolean
  errorMessage: string | null
  onConfirm: () => void
  onCancel: () => void
}

type FocusableRef = { current: HTMLInputElement | HTMLButtonElement | null; disabled: boolean }

export default function MarkPaidDialog({
  requestCount,
  subtotals,
  emailStatus,
  isConfirming,
  errorMessage,
  onConfirm,
  onCancel,
}: MarkPaidDialogProps) {
  const t = strings.components.markPaidDialog
  const emailLabels = strings.pages.batchDetail.email
  const [acknowledged, setAcknowledged] = useState(false)
  const checkboxRef = useRef<HTMLInputElement>(null)
  const cancelBtnRef = useRef<HTMLButtonElement>(null)
  const confirmBtnRef = useRef<HTMLButtonElement>(null)

  const canConfirm = acknowledged && !isConfirming

  // Default focus on Cancel — see this file's doc comment on why (unlike
  // RejectDialog, whose next required action IS typing into the textarea).
  useEffect(() => {
    cancelBtnRef.current?.focus()
  }, [])

  // Keyboard: Escape = Cancel; Tab / Shift+Tab trapped within [checkbox, Cancel, Confirm].
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onCancel()
        return
      }

      if (e.key !== 'Tab') return

      const candidates: FocusableRef[] = [
        { current: checkboxRef.current, disabled: isConfirming },
        { current: cancelBtnRef.current, disabled: isConfirming },
        { current: confirmBtnRef.current, disabled: !canConfirm },
      ]
      const focusable = candidates
        .filter(
          (c): c is FocusableRef & { current: HTMLInputElement | HTMLButtonElement } =>
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
  }, [onCancel, isConfirming, canConfirm])

  const emailLabel = emailLabels[emailStatus ?? 'notAttempted']

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center backdrop-blur-sm"
      style={{ backgroundColor: 'rgba(0, 0, 0, 0.6)' }}
      onClick={onCancel}
      data-testid="mark-paid-dialog-modal"
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="mark-paid-dialog-title"
        aria-describedby="mark-paid-dialog-body"
        className="border rounded-lg shadow-2xl w-full max-w-sm mx-4 p-5"
        style={{ backgroundColor: 'var(--ink-soft)', borderColor: 'var(--rule)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <h2
            id="mark-paid-dialog-title"
            className="text-sm font-bold"
            style={{ fontFamily: 'var(--disp)', color: 'var(--text)' }}
          >
            {t.title}
          </h2>
          <button
            onClick={onCancel}
            disabled={isConfirming}
            aria-label={t.cancelAriaLabel}
            className="text-lg leading-none transition-opacity hover:opacity-80 disabled:opacity-40 disabled:cursor-not-allowed"
            style={{ color: 'var(--muted)' }}
          >
            ×
          </button>
        </div>

        <div
          id="mark-paid-dialog-body"
          className="text-sm leading-relaxed mb-3 flex flex-col gap-3"
          style={{ color: 'var(--text)' }}
        >
          <p>{t.requestCountLabel(requestCount)}</p>
          <BatchSubtotalsPanel subtotals={subtotals} />
          <p className="text-xs" style={{ color: 'var(--muted)' }} data-testid="mark-paid-dialog-email-fyi">
            {emailLabel}
            {emailStatus === 'failed' ? ` — ${t.emailFailedFyi}` : ''}
          </p>
          <p>{t.consequence(requestCount)}</p>
        </div>

        <div className="flex items-start gap-2 mb-3">
          <input
            ref={checkboxRef}
            id="mark-paid-dialog-checkbox"
            type="checkbox"
            checked={acknowledged}
            disabled={isConfirming}
            onChange={(e) => setAcknowledged(e.target.checked)}
            data-testid="mark-paid-dialog-checkbox"
            className="mt-0.5"
          />
          <label htmlFor="mark-paid-dialog-checkbox" className="text-sm" style={{ color: 'var(--text)' }}>
            {t.acknowledgeLabel}
          </label>
        </div>

        {errorMessage && (
          <p className="text-sm mb-3" role="alert" data-testid="mark-paid-dialog-error" style={{ color: 'var(--org)' }}>
            {errorMessage}
          </p>
        )}

        <div className="flex items-center justify-end gap-3">
          <button
            ref={cancelBtnRef}
            onClick={onCancel}
            disabled={isConfirming}
            data-testid="mark-paid-dialog-cancel"
            className="py-2 px-4 text-sm font-medium border transition-opacity hover:opacity-80 disabled:opacity-40 disabled:cursor-not-allowed"
            style={{ borderColor: 'var(--rule)', color: 'var(--muted)' }}
          >
            {t.cancelLabel}
          </button>
          <button
            ref={confirmBtnRef}
            onClick={onConfirm}
            disabled={!canConfirm}
            data-testid="mark-paid-dialog-confirm"
            className="py-2 px-4 text-sm font-medium border transition-opacity hover:opacity-80 disabled:opacity-40 disabled:cursor-not-allowed"
            style={{ color: 'var(--grn)', borderColor: 'var(--grn)' }}
          >
            {isConfirming ? (
              <span className="flex items-center gap-2">
                <span
                  className="inline-block w-3 h-3 border-2 rounded-full animate-spin motion-reduce:animate-none"
                  style={{ borderColor: 'var(--grn)', borderTopColor: 'transparent' }}
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
