/**
 * CreateRoleModal — Modal M1 (T17, specs/004-auth-roles-permissions,
 * design.md Screen A1 / F2 step 2: "'+ New role' → Modal M1 (Create role)
 * (name, description) → `POST /admin/roles`").
 *
 * NEW component (design.md component inventory: "Create-role / Create-
 * department modal (M1/M2) — NEW … structurally simpler than, but modeled
 * on, ConfirmDeleteModal's dialog shell (backdrop, role, header/body/footer,
 * Escape)"). Unlike ConfirmDeleteModal/GuardrailDialog (Dialogs D1/D2), this
 * is a plain `role="dialog"` — design.md restricts `alertdialog` to dialogs
 * that interrupt to demand acknowledgement of something consequential
 * (destructive delete, hard guardrail); a create-entity form has neither, so
 * the ordinary dialog role is correct here.
 *
 * Presentational: all data/callbacks arrive via props. RolesPage.tsx owns
 * the field state and the `POST /admin/roles` call, and maps a `409`
 * (duplicate name) onto `nameError` (design.md F2 step 2: "409 duplicate
 * name → inline field error on the modal, modal stays open").
 *
 * A11y (mirrors ConfirmDeleteModal.tsx's contract):
 *   • role="dialog" aria-modal="true" aria-labelledby + aria-describedby-less
 *     (no single describing paragraph — the form fields ARE the content).
 *   • Focus trap: Tab cycles the Name input → Description input → Cancel →
 *     Create, and back.
 *   • Default focus: the Name field (a create form's natural first control,
 *     unlike a destructive confirm's "safe default is Cancel").
 *   • Escape = Cancel; no submit is triggered.
 */

import { useEffect, useRef } from 'react'

export type CreateRoleModalProps = {
  name: string
  description: string
  onNameChange: (value: string) => void
  onDescriptionChange: (value: string) => void
  onSubmit: () => void
  onCancel: () => void
  /** Whether the `POST /admin/roles` request is currently in-flight. */
  submitting: boolean
  /** Field-level error under the Name input (409 duplicate name); null = none. */
  nameError: string | null
  /** Non-field error banner (any other failure); null = none. */
  generalError: string | null
}

export default function CreateRoleModal({
  name,
  description,
  onNameChange,
  onDescriptionChange,
  onSubmit,
  onCancel,
  submitting,
  nameError,
  generalError,
}: CreateRoleModalProps) {
  const nameInputRef = useRef<HTMLInputElement>(null)
  const descriptionInputRef = useRef<HTMLTextAreaElement>(null)
  const cancelBtnRef = useRef<HTMLButtonElement>(null)
  const submitBtnRef = useRef<HTMLButtonElement>(null)

  // Focus the Name field on mount — the natural first control for a create form.
  useEffect(() => {
    nameInputRef.current?.focus()
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
        nameInputRef.current,
        descriptionInputRef.current,
        cancelBtnRef.current,
        submitBtnRef.current,
      ].filter(
        (el): el is HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement =>
          el !== null && !el.disabled,
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

  const canSubmit = name.trim().length > 0 && !submitting

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center backdrop-blur-sm"
      style={{ backgroundColor: 'rgba(0, 0, 0, 0.6)' }}
      onClick={onCancel}
      data-testid="create-role-modal"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-role-title"
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
          {/* Header */}
          <div className="flex items-center justify-between mb-3">
            <h2
              id="create-role-title"
              className="text-sm font-bold"
              style={{ fontFamily: 'var(--disp)', color: 'var(--text)' }}
            >
              New role
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

          {/* Body */}
          <div className="flex flex-col gap-3 mb-4">
            <div className="flex flex-col gap-1">
              <label htmlFor="create-role-name" className="text-xs font-medium" style={{ color: 'var(--soft)' }}>
                Name
              </label>
              <input
                ref={nameInputRef}
                id="create-role-name"
                type="text"
                value={name}
                onChange={(e) => onNameChange(e.target.value)}
                disabled={submitting}
                required
                aria-invalid={nameError !== null}
                aria-describedby={nameError ? 'create-role-name-error' : undefined}
                data-testid="create-role-name"
                className="text-sm px-2.5 py-1.5 border rounded"
                style={{ borderColor: nameError ? 'var(--red)' : 'var(--rule)', color: 'var(--text)', backgroundColor: 'var(--ink)' }}
              />
              {nameError && (
                <p
                  id="create-role-name-error"
                  role="alert"
                  data-testid="create-role-name-error"
                  className="text-xs"
                  style={{ color: 'var(--red)' }}
                >
                  {nameError}
                </p>
              )}
            </div>

            <div className="flex flex-col gap-1">
              <label
                htmlFor="create-role-description"
                className="text-xs font-medium"
                style={{ color: 'var(--soft)' }}
              >
                Description
              </label>
              <textarea
                ref={descriptionInputRef}
                id="create-role-description"
                value={description}
                onChange={(e) => onDescriptionChange(e.target.value)}
                disabled={submitting}
                rows={2}
                data-testid="create-role-description"
                className="text-sm px-2.5 py-1.5 border rounded resize-none"
                style={{ borderColor: 'var(--rule)', color: 'var(--text)', backgroundColor: 'var(--ink)' }}
              />
            </div>

            {generalError && (
              <p role="alert" data-testid="create-role-general-error" className="text-xs" style={{ color: 'var(--red)' }}>
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
              data-testid="create-role-cancel"
              className="py-2 px-4 text-sm font-medium border transition-opacity hover:opacity-80 disabled:opacity-40 disabled:cursor-not-allowed"
              style={{ borderColor: 'var(--rule)', color: 'var(--muted)' }}
            >
              Cancel
            </button>
            <button
              ref={submitBtnRef}
              type="submit"
              disabled={!canSubmit}
              data-testid="create-role-submit"
              className="py-2 px-4 text-sm font-medium border transition-opacity hover:opacity-80 disabled:opacity-40 disabled:cursor-not-allowed"
              style={{ color: 'var(--acc)', borderColor: 'var(--acc)' }}
            >
              {submitting ? 'Creating…' : 'Create role'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
