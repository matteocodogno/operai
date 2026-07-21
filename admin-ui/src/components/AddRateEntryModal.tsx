/**
 * AddRateEntryModal — Modal ADM-M1 (T11, specs/009-mileage-rate, design.md
 * Screen ADM-M1: "Add rate entry").
 *
 * NEW component — the closest precedent (`CreateRoleModal`/
 * `CreateDepartmentModal`) doesn't fit: this needs an entity-locked (not
 * editable) header, a positive-decimal rate field, a backdatable/future-dated
 * date field, and framing that this action is irreversible (AC-4.7). It
 * structurally clones `CreateRoleModal.tsx`'s shell (backdrop, `role="dialog"`,
 * header/body/footer, Escape=Cancel, Tab-trap over the field list) — same
 * shell, different fields.
 *
 * Presentational: all data/callbacks arrive via props. `MileageRatesPage.tsx`
 * owns the field state and the `POST /rates` call, and maps a `422` (AC-4.5)
 * onto `rateError`/`validFromError` (see that page's `mapAddRateError`
 * comment for the field-routing rationale — plan.md documents no
 * `fields.*` contract for this endpoint, unlike submit's
 * `fields.offendingLineIds`, so the routing is a best-effort heuristic over
 * the RFC 7807 `detail` text, flagged for the architect/backend-dev to
 * confirm a real contract).
 *
 * A11y (mirrors CreateRoleModal.tsx's contract):
 *   • role="dialog" aria-modal="true" aria-labelledby.
 *   • Focus trap: Tab cycles Rate → Valid-from → Cancel → Add, and back.
 *   • Default focus: the Rate field (this form's natural first control).
 *   • Escape = Cancel; no submit is triggered.
 *   • Every field error is role="alert" + aria-invalid + aria-describedby,
 *     identical to CreateRoleModal.tsx's Name field.
 */

import { useEffect, useRef } from 'react'
import type { MileageRateEntity } from '../lib/ratesApi'

export type AddRateEntryModalProps = {
  entity: MileageRateEntity
  /** Display label for the (read-only) entity header, e.g. "WellD CH". */
  entityLabel: string
  rate: string
  validFrom: string
  onRateChange: (value: string) => void
  onValidFromChange: (value: string) => void
  onSubmit: () => void
  onCancel: () => void
  /** Whether the `POST /rates` request is currently in-flight. */
  submitting: boolean
  /** Field-level error under the Rate field; null = none. */
  rateError: string | null
  /** Field-level error under the Valid-from field; null = none. */
  validFromError: string | null
  /** Non-field error banner (network/500); null = none. */
  generalError: string | null
}

export default function AddRateEntryModal({
  entity,
  entityLabel,
  rate,
  validFrom,
  onRateChange,
  onValidFromChange,
  onSubmit,
  onCancel,
  submitting,
  rateError,
  validFromError,
  generalError,
}: AddRateEntryModalProps) {
  const rateInputRef = useRef<HTMLInputElement>(null)
  const validFromInputRef = useRef<HTMLInputElement>(null)
  const cancelBtnRef = useRef<HTMLButtonElement>(null)
  const submitBtnRef = useRef<HTMLButtonElement>(null)

  // Focus the Rate field on mount — the form's natural first control.
  useEffect(() => {
    rateInputRef.current?.focus()
  }, [])

  // Keyboard: Escape = Cancel; Tab / Shift+Tab trapped within the 4 controls.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onCancel()
        return
      }

      if (e.key !== 'Tab') return

      const focusable = [
        rateInputRef.current,
        validFromInputRef.current,
        cancelBtnRef.current,
        submitBtnRef.current,
      ].filter(
        (el): el is HTMLInputElement | HTMLButtonElement => el !== null && !el.disabled,
      )
      if (focusable.length === 0) return

      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (!first || !last) return

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

  const canSubmit = rate.trim().length > 0 && validFrom.trim().length > 0 && !submitting

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center backdrop-blur-sm"
      style={{ backgroundColor: 'rgba(0, 0, 0, 0.6)' }}
      onClick={onCancel}
      data-testid={`add-rate-modal-${entity}`}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-rate-title"
        className="border rounded-lg shadow-2xl w-full max-w-sm mx-4 p-5"
        style={{ backgroundColor: 'var(--ink-soft)', borderColor: 'var(--rule)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (canSubmit) onSubmit()
          }}
        >
          {/* Header — entity is shown read-only, never editable (design.md F5 step 3). */}
          <div className="flex items-center justify-between mb-3">
            <h2
              id="add-rate-title"
              className="text-sm font-bold"
              style={{ fontFamily: 'var(--disp)', color: 'var(--text)' }}
            >
              Add rate entry — {entityLabel}
            </h2>
            <button
              type="button"
              onClick={onCancel}
              disabled={submitting}
              className="text-lg leading-none transition-opacity hover:opacity-80 disabled:opacity-40 disabled:cursor-not-allowed"
              style={{ color: 'var(--muted)' }}
              aria-label="Cancel"
            >
              ×
            </button>
          </div>

          {/* Irreversibility notice — AC-4.7: a rate entry can never be edited or deleted. */}
          <p className="text-xs mb-3" style={{ color: 'var(--soft)' }}>
            This entry cannot be edited or deleted once saved — a correction is always a new entry.
          </p>

          {/* Body */}
          <div className="flex flex-col gap-3 mb-4">
            <div className="flex flex-col gap-1">
              <label htmlFor="add-rate-value" className="text-xs font-medium" style={{ color: 'var(--soft)' }}>
                Rate per km{' '}
                <span aria-hidden="true" style={{ color: 'var(--red)' }}>
                  *
                </span>
                <span className="sr-only">(required)</span>
              </label>
              <input
                ref={rateInputRef}
                id="add-rate-value"
                type="number"
                inputMode="decimal"
                step="0.01"
                min="0"
                value={rate}
                onChange={(e) => onRateChange(e.target.value)}
                disabled={submitting}
                required
                aria-invalid={rateError !== null}
                aria-describedby={rateError ? 'add-rate-value-error' : undefined}
                data-testid="add-rate-value"
                className="text-sm px-2.5 py-1.5 border rounded"
                style={{ borderColor: rateError ? 'var(--red)' : 'var(--rule)', color: 'var(--text)', backgroundColor: 'var(--ink)' }}
              />
              {rateError && (
                <p
                  id="add-rate-value-error"
                  role="alert"
                  data-testid="add-rate-value-error"
                  className="text-xs"
                  style={{ color: 'var(--red)' }}
                >
                  {rateError}
                </p>
              )}
            </div>

            <div className="flex flex-col gap-1">
              <label htmlFor="add-rate-valid-from" className="text-xs font-medium" style={{ color: 'var(--soft)' }}>
                Valid from{' '}
                <span aria-hidden="true" style={{ color: 'var(--red)' }}>
                  *
                </span>
                <span className="sr-only">(required)</span>
              </label>
              <input
                ref={validFromInputRef}
                id="add-rate-valid-from"
                type="date"
                value={validFrom}
                onChange={(e) => onValidFromChange(e.target.value)}
                disabled={submitting}
                required
                aria-invalid={validFromError !== null}
                aria-describedby={validFromError ? 'add-rate-valid-from-error' : undefined}
                data-testid="add-rate-valid-from"
                className="text-sm px-2.5 py-1.5 border rounded"
                style={{ borderColor: validFromError ? 'var(--red)' : 'var(--rule)', color: 'var(--text)', backgroundColor: 'var(--ink)', colorScheme: 'dark' }}
              />
              {validFromError && (
                <p
                  id="add-rate-valid-from-error"
                  role="alert"
                  data-testid="add-rate-valid-from-error"
                  className="text-xs"
                  style={{ color: 'var(--red)' }}
                >
                  {validFromError}
                </p>
              )}
              <p className="text-xs" style={{ color: 'var(--muted)' }}>
                Past, present, or future dates are all accepted.
              </p>
            </div>

            {generalError && (
              <p role="alert" data-testid="add-rate-general-error" className="text-xs" style={{ color: 'var(--red)' }}>
                {generalError}
              </p>
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-end gap-3">
            <button
              ref={cancelBtnRef}
              type="button"
              onClick={onCancel}
              disabled={submitting}
              data-testid="add-rate-cancel"
              className="py-2 px-4 text-sm font-medium border transition-opacity hover:opacity-80 disabled:opacity-40 disabled:cursor-not-allowed"
              style={{ borderColor: 'var(--rule)', color: 'var(--muted)' }}
            >
              Cancel
            </button>
            <button
              ref={submitBtnRef}
              type="submit"
              disabled={!canSubmit}
              data-testid="add-rate-submit"
              className="py-2 px-4 text-sm font-medium border transition-opacity hover:opacity-80 disabled:opacity-40 disabled:cursor-not-allowed"
              style={{ color: 'var(--acc)', borderColor: 'var(--acc)' }}
            >
              {submitting ? 'Adding…' : 'Add rate entry'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
