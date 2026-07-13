/**
 * InviteUserModal — Modal N1 (T12, specs/006-user-invitations, design.md
 * "Modal N1 (Invite user)").
 *
 * Structurally: `CreateRoleModal`'s dialog shell (backdrop, `role="dialog"` —
 * not `alertdialog`, since inviting isn't destructive — header/`<form>`/
 * footer, Escape=Cancel, Tab-trap, default focus on Email) plus two checkbox
 * fieldsets ported from `UserDetail.tsx`'s "Direct roles"/"Departments"
 * sections (same `<fieldset><legend>` + per-option `<label><input
 * type="checkbox">` shape, reused as a *pattern* — design.md explicitly frames
 * this as "reused as a pattern, not a shared component," matching how
 * `UserDetail.tsx` itself renders the same shape twice inline). The small
 * local, non-exported `CheckboxFieldset` below avoids literal duplication
 * between the two fieldsets in THIS file without prematurely promoting it to
 * a shared top-level component (design.md: extraction is a judgment call for
 * a third render site, not a requirement here).
 *
 * Presentational: all data/callbacks arrive via props. `InvitationsPage.tsx`
 * owns the field state and the `POST /admin/invitations` call, mapping 409s
 * (AC-1.3/1.4) and 422s onto `emailError`/`generalError` (design.md F1 step 3).
 *
 * A11y (mirrors CreateRoleModal.tsx's contract):
 *   • role="dialog" aria-modal="true" aria-labelledby
 *   • Focus trap across every enabled, currently-rendered focusable element.
 *   • Default focus: the Email field.
 *   • Escape = Cancel; backdrop click = Cancel.
 *   • Submit stays disabled (not hidden) until the email is non-empty and
 *     well-formed (design.md: "a screen-reader user tabbing to it gets a
 *     consistent, explorable control").
 */

import { useEffect, useRef } from 'react'
import type { FormEvent } from 'react'
import type { Department, Role } from '../lib/adminApi'

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// ---------------------------------------------------------------------------
// CheckboxFieldset — local, non-exported (see doc comment above)
// ---------------------------------------------------------------------------

function CheckboxFieldset({
  legend,
  emptyMessage,
  options,
  selectedIds,
  onToggle,
  disabled,
  testIdPrefix,
}: {
  legend: string
  emptyMessage: string
  options: { id: string; name: string }[]
  selectedIds: ReadonlySet<string>
  onToggle: (id: string) => void
  disabled: boolean
  testIdPrefix: string
}) {
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="text-xs font-medium mb-1" style={{ color: 'var(--soft)' }}>
        {legend}
      </legend>
      {options.length === 0 ? (
        <p className="text-xs" style={{ color: 'var(--soft)' }}>
          {emptyMessage}
        </p>
      ) : (
        <div className="flex flex-col gap-1 max-h-32 overflow-y-auto">
          {options.map((option) => (
            <label key={option.id} className="flex items-center gap-2 text-sm" style={{ color: 'var(--text)' }}>
              <input
                type="checkbox"
                checked={selectedIds.has(option.id)}
                disabled={disabled}
                onChange={() => onToggle(option.id)}
                data-testid={`${testIdPrefix}-${option.id}`}
              />
              {option.name}
            </label>
          ))}
        </div>
      )}
    </fieldset>
  )
}

// ---------------------------------------------------------------------------
// InviteUserModal
// ---------------------------------------------------------------------------

export type InviteUserModalProps = {
  email: string
  onEmailChange: (value: string) => void
  roles: Role[]
  departments: Department[]
  selectedRoleIds: ReadonlySet<string>
  onToggleRole: (id: string) => void
  selectedDepartmentIds: ReadonlySet<string>
  onToggleDepartment: (id: string) => void
  onSubmit: () => void
  onCancel: () => void
  /** Whether the `POST /admin/invitations` request is currently in-flight. */
  submitting: boolean
  /** Field-level error under Email — client-side format errors AND 409s (AC-1.3/1.4); null = none. */
  emailError: string | null
  /** Non-field error banner (e.g. 422 unknown role/department id); null = none. */
  generalError: string | null
}

export default function InviteUserModal({
  email,
  onEmailChange,
  roles,
  departments,
  selectedRoleIds,
  onToggleRole,
  selectedDepartmentIds,
  onToggleDepartment,
  onSubmit,
  onCancel,
  submitting,
  emailError,
  generalError,
}: InviteUserModalProps) {
  const emailInputRef = useRef<HTMLInputElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)

  // Focus the Email field on mount — the natural first control for this form.
  useEffect(() => {
    emailInputRef.current?.focus()
  }, [])

  // Escape = Cancel; Tab is trapped within every currently-enabled focusable
  // element inside the dialog — queried live (mirrors CreateDepartmentModal.tsx's
  // technique) so it stays correct as fields/checkboxes disable during submission.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onCancel()
        return
      }

      if (e.key !== 'Tab' || !dialogRef.current) return

      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>('input, button'),
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

  const trimmedEmail = email.trim()
  const canSubmit = EMAIL_PATTERN.test(trimmedEmail) && !submitting

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center backdrop-blur-sm"
      style={{ backgroundColor: 'rgba(0, 0, 0, 0.6)' }}
      onClick={onCancel}
      data-testid="invite-user-modal"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="invite-user-title"
        className="border rounded-lg shadow-2xl w-full max-w-sm mx-4 p-5"
        style={{ backgroundColor: 'var(--ink-soft)', borderColor: 'var(--rule)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <form
          onSubmit={(e: FormEvent) => {
            e.preventDefault()
            if (canSubmit) onSubmit()
          }}
        >
          {/* Header */}
          <div className="flex items-center justify-between mb-3">
            <h2
              id="invite-user-title"
              className="text-sm font-bold"
              style={{ fontFamily: 'var(--disp)', color: 'var(--text)' }}
            >
              Invite user
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
          <div className="flex flex-col gap-4 mb-4">
            <div className="flex flex-col gap-1">
              <label htmlFor="invite-user-email" className="text-xs font-medium" style={{ color: 'var(--soft)' }}>
                Email{' '}
                <span aria-hidden="true" style={{ color: 'var(--red)' }}>
                  *
                </span>
                <span className="sr-only">(required)</span>
              </label>
              <input
                ref={emailInputRef}
                id="invite-user-email"
                type="email"
                required
                value={email}
                onChange={(e) => onEmailChange(e.target.value)}
                disabled={submitting}
                aria-invalid={emailError !== null}
                aria-describedby={emailError ? 'invite-user-email-error' : undefined}
                data-testid="invite-user-email"
                className="text-sm px-2.5 py-1.5 border rounded"
                style={{
                  borderColor: emailError ? 'var(--red)' : 'var(--rule)',
                  color: 'var(--text)',
                  backgroundColor: 'var(--ink)',
                }}
              />
              {emailError && (
                <p
                  id="invite-user-email-error"
                  role="alert"
                  data-testid="invite-user-email-error"
                  className="text-xs"
                  style={{ color: 'var(--red)' }}
                >
                  {emailError}
                </p>
              )}
            </div>

            <CheckboxFieldset
              legend="Roles (optional)"
              emptyMessage="No roles defined yet."
              options={roles}
              selectedIds={selectedRoleIds}
              onToggle={onToggleRole}
              disabled={submitting}
              testIdPrefix="invite-user-role"
            />

            <CheckboxFieldset
              legend="Departments (optional)"
              emptyMessage="No departments defined yet."
              options={departments}
              selectedIds={selectedDepartmentIds}
              onToggle={onToggleDepartment}
              disabled={submitting}
              testIdPrefix="invite-user-department"
            />

            {generalError && (
              <p role="alert" data-testid="invite-user-general-error" className="text-xs" style={{ color: 'var(--red)' }}>
                {generalError}
              </p>
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={onCancel}
              disabled={submitting}
              data-testid="invite-user-cancel"
              className="py-2 px-4 text-sm font-medium border transition-opacity hover:opacity-80 disabled:opacity-40 disabled:cursor-not-allowed"
              style={{ borderColor: 'var(--rule)', color: 'var(--muted)' }}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!canSubmit}
              data-testid="invite-user-submit"
              className="py-2 px-4 text-sm font-medium border transition-opacity hover:opacity-80 disabled:opacity-40 disabled:cursor-not-allowed"
              style={{ color: 'var(--acc)', borderColor: 'var(--acc)' }}
            >
              {submitting ? 'Sending…' : 'Send invite'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
