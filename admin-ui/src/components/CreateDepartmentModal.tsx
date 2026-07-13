/**
 * CreateDepartmentModal — Modal M2 (design.md "Create-role / Create-department
 * modal (M1/M2)", T19, specs/004-auth-roles-permissions/tasks.md).
 *
 * Small name+description dialog, structurally modeled on
 * `ConfirmDeleteModal`'s dialog shell (backdrop, header/body/footer, Escape)
 * per design.md's component inventory — but genuinely simpler: a plain
 * `role="dialog"` (not `alertdialog`) since creating a department isn't a
 * consequential/destructive action requiring interruption-level ARIA
 * semantics, and a real `<form>` with two fields instead of a single
 * confirm/cancel pair.
 *
 * Presentational: name/description are owned locally (the modal is the only
 * thing that needs them while open); submission and its outcome
 * (isSubmitting / errorMessage — a 409 duplicate-name from
 * `POST /admin/departments`, design.md F3 step 1) are owned by the caller
 * (DepartmentsPage, ../pages/DepartmentsPage.tsx) exactly like
 * ConfirmDeleteModal's idle/deleting/error contract.
 *
 * A11y:
 *   • role="dialog" aria-modal="true" aria-labelledby
 *   • Focus trap across every focusable element inside the FORM (name
 *     input, description textarea, Cancel, Create) — a generalisation of
 *     ConfirmDeleteModal's two-button trap to an arbitrary field count. The
 *     header "×" sits outside the `<form>` and is deliberately excluded
 *     from the ring, exactly like ConfirmDeleteModal's own trap excludes
 *     its header "×" from its two-button cycle.
 *   • Default focus: the Name field (the first thing to fill in).
 *   • Escape = Cancel; backdrop click = Cancel (matches ConfirmDeleteModal).
 *   • Client-side validation (name required) never reaches the network —
 *     the inline error area is shared between that and a 409 from the
 *     server so there is exactly one place errors surface.
 */

import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'

export type CreateDepartmentModalProps = {
  /** Whether the create request is currently in-flight. */
  isSubmitting: boolean
  /** Server-side error (e.g. 409 duplicate name); null = no error. */
  errorMessage: string | null
  /** Called with the trimmed field values once client-side validation passes. */
  onSubmit: (input: { name: string; description?: string }) => void
  /** Called when the user cancels (clicks "Cancel", "×", or presses Escape). */
  onCancel: () => void
}

export default function CreateDepartmentModal({
  isSubmitting,
  errorMessage,
  onSubmit,
  onCancel,
}: CreateDepartmentModalProps) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [validationError, setValidationError] = useState<string | null>(null)

  const nameInputRef = useRef<HTMLInputElement>(null)
  const formRef = useRef<HTMLFormElement>(null)

  // Focus the Name field on mount — the first thing to fill in.
  useEffect(() => {
    nameInputRef.current?.focus()
  }, [])

  // Escape = Cancel; Tab is trapped within every focusable element currently
  // inside the FORM (name input, description textarea, Cancel, Create) —
  // queried live, so it stays correct as fields disable during submission.
  // The header "×" button is deliberately excluded from this ring, mirroring
  // ConfirmDeleteModal's own trap (which only cycles its two footer
  // buttons): a keyboard user closes via Escape, not by tabbing to "×".
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onCancel()
        return
      }

      if (e.key !== 'Tab' || !formRef.current) return

      const focusable = Array.from(
        formRef.current.querySelectorAll<HTMLElement>('input, textarea, button'),
      ).filter((el) => !(el as HTMLButtonElement | HTMLInputElement).disabled)
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

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault()
    const trimmedName = name.trim()
    if (!trimmedName) {
      setValidationError('Name is required.')
      return
    }
    setValidationError(null)
    const trimmedDescription = description.trim()
    onSubmit({ name: trimmedName, description: trimmedDescription || undefined })
  }

  const inlineError = validationError ?? errorMessage

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center backdrop-blur-sm"
      style={{ backgroundColor: 'rgba(0, 0, 0, 0.6)' }}
      onClick={onCancel}
      data-testid="create-department-modal"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-department-title"
        className="border rounded-lg shadow-2xl w-full max-w-sm mx-4 p-5"
        style={{ backgroundColor: 'var(--ink-soft)', borderColor: 'var(--rule)' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-3">
          <h2
            id="create-department-title"
            className="text-sm font-bold"
            style={{ fontFamily: 'var(--disp)', color: 'var(--text)' }}
          >
            New department
          </h2>
          <button
            type="button"
            onClick={onCancel}
            disabled={isSubmitting}
            aria-label="Cancel"
            className="text-lg leading-none transition-opacity hover:opacity-80 disabled:opacity-40 disabled:cursor-not-allowed"
            style={{ color: 'var(--muted)' }}
          >
            ×
          </button>
        </div>

        <form ref={formRef} onSubmit={handleSubmit}>
          <div className="mb-3">
            <label
              htmlFor="create-department-name"
              className="block text-xs font-medium mb-1"
              style={{ color: 'var(--soft)' }}
            >
              Name{' '}
              <span aria-hidden="true" style={{ color: 'var(--red)' }}>
                *
              </span>
              <span className="sr-only">(required)</span>
            </label>
            <input
              ref={nameInputRef}
              id="create-department-name"
              type="text"
              aria-required="true"
              value={name}
              disabled={isSubmitting}
              onChange={(e) => setName(e.target.value)}
              className="w-full text-sm px-3 py-2 border rounded disabled:opacity-60"
              style={{ borderColor: 'var(--rule)', backgroundColor: 'var(--ink)', color: 'var(--text)' }}
              data-testid="create-department-name-input"
            />
          </div>

          <div className="mb-3">
            <label
              htmlFor="create-department-description"
              className="block text-xs font-medium mb-1"
              style={{ color: 'var(--soft)' }}
            >
              Description{' '}
              <span style={{ color: 'var(--muted)', fontWeight: 400 }}>(optional)</span>
            </label>
            <textarea
              id="create-department-description"
              value={description}
              disabled={isSubmitting}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              className="w-full text-sm px-3 py-2 border rounded disabled:opacity-60"
              style={{ borderColor: 'var(--rule)', backgroundColor: 'var(--ink)', color: 'var(--text)' }}
              data-testid="create-department-description-input"
            />
          </div>

          {inlineError && (
            <p
              role="alert"
              className="text-sm mb-3"
              style={{ color: 'var(--org)' }}
              data-testid="create-department-error"
            >
              {inlineError}
            </p>
          )}

          <div className="flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={onCancel}
              disabled={isSubmitting}
              data-testid="create-department-cancel"
              className="py-2 px-4 text-sm font-medium border transition-opacity hover:opacity-80 disabled:opacity-40 disabled:cursor-not-allowed"
              style={{ borderColor: 'var(--rule)', color: 'var(--muted)' }}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              data-testid="create-department-submit"
              className="py-2 px-4 text-sm font-medium border transition-opacity hover:opacity-80 disabled:opacity-40 disabled:cursor-not-allowed"
              style={{ borderColor: 'var(--acc)', color: 'var(--acc)' }}
            >
              {isSubmitting ? 'Creating…' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
