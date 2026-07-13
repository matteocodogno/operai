/**
 * @vitest-environment jsdom
 *
 * Component tests for InviteUserModal (T12, specs/006-user-invitations,
 * design.md Modal N1).
 *
 * Covers:
 *   (A) role="dialog" (not alertdialog — inviting isn't destructive),
 *       labelled, default focus on Email.
 *   (B) Submit stays disabled until the email is non-empty and well-formed.
 *   (C) Filling the roles/departments checkboxes calls onToggleRole/
 *       onToggleDepartment.
 *   (D) Submitting a valid form calls onSubmit.
 *   (E) Escape / Cancel / backdrop click call onCancel.
 *   (F) emailError renders under Email with aria-invalid/aria-describedby;
 *       generalError renders as a banner.
 *   (G) Submitting state disables every control and shows "Sending…".
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import InviteUserModal from './InviteUserModal'
import type { Department, Role } from '../lib/adminApi'

afterEach(() => {
  cleanup()
})

const roleAccounting: Role = {
  id: 'role-1',
  name: 'accounting',
  description: null,
  isSystem: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

const deptFinance: Department = {
  id: 'dept-1',
  name: 'Finance',
  description: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

const baseProps = {
  email: '',
  onEmailChange: vi.fn(),
  roles: [roleAccounting],
  departments: [deptFinance],
  selectedRoleIds: new Set<string>(),
  onToggleRole: vi.fn(),
  selectedDepartmentIds: new Set<string>(),
  onToggleDepartment: vi.fn(),
  onSubmit: vi.fn(),
  onCancel: vi.fn(),
  submitting: false,
  emailError: null,
  generalError: null,
}

describe('InviteUserModal', () => {
  it('renders a role="dialog" (not alertdialog) labelled "Invite user", focused on Email', () => {
    render(<InviteUserModal {...baseProps} />)

    const dialog = screen.getByRole('dialog')
    expect(dialog.getAttribute('aria-labelledby')).toBe('invite-user-title')
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(document.activeElement).toBe(screen.getByTestId('invite-user-email'))
  })

  it('disables Submit until the email is non-empty and well-formed', () => {
    const { rerender } = render(<InviteUserModal {...baseProps} email="" />)
    expect(screen.getByTestId('invite-user-submit').hasAttribute('disabled')).toBe(true)

    rerender(<InviteUserModal {...baseProps} email="not-an-email" />)
    expect(screen.getByTestId('invite-user-submit').hasAttribute('disabled')).toBe(true)

    rerender(<InviteUserModal {...baseProps} email="alice@welld.ch" />)
    expect(screen.getByTestId('invite-user-submit').hasAttribute('disabled')).toBe(false)
  })

  it('checking a role/department checkbox calls onToggleRole/onToggleDepartment', () => {
    const onToggleRole = vi.fn()
    const onToggleDepartment = vi.fn()
    render(<InviteUserModal {...baseProps} onToggleRole={onToggleRole} onToggleDepartment={onToggleDepartment} />)

    fireEvent.click(screen.getByTestId('invite-user-role-role-1'))
    expect(onToggleRole).toHaveBeenCalledWith('role-1')

    fireEvent.click(screen.getByTestId('invite-user-department-dept-1'))
    expect(onToggleDepartment).toHaveBeenCalledWith('dept-1')
  })

  it('roles/departments are optional: an empty catalog shows the "not defined yet" message, not an error', () => {
    render(<InviteUserModal {...baseProps} roles={[]} departments={[]} />)

    expect(screen.getByText('No roles defined yet.')).not.toBeNull()
    expect(screen.getByText('No departments defined yet.')).not.toBeNull()
  })

  it('submitting a well-formed email calls onSubmit', () => {
    const onSubmit = vi.fn()
    render(<InviteUserModal {...baseProps} email="alice@welld.ch" onSubmit={onSubmit} />)

    fireEvent.click(screen.getByTestId('invite-user-submit'))

    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it('Escape and Cancel and the backdrop all call onCancel', () => {
    const onCancel = vi.fn()
    render(<InviteUserModal {...baseProps} onCancel={onCancel} />)

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByTestId('invite-user-cancel'))
    expect(onCancel).toHaveBeenCalledTimes(2)

    fireEvent.click(screen.getByTestId('invite-user-modal'))
    expect(onCancel).toHaveBeenCalledTimes(3)
  })

  it('renders emailError under Email with aria-invalid/aria-describedby (409 AC-1.3/1.4 or client-side format)', () => {
    render(<InviteUserModal {...baseProps} emailError="An invitation is already pending for this email." />)

    const input = screen.getByTestId('invite-user-email')
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(input.getAttribute('aria-describedby')).toBe('invite-user-email-error')
    const err = screen.getByTestId('invite-user-email-error')
    expect(err.getAttribute('role')).toBe('alert')
    expect(err.textContent).toBe('An invitation is already pending for this email.')
  })

  it('renders generalError as a banner (422 unknown role/department id)', () => {
    render(<InviteUserModal {...baseProps} generalError="Could not create the invitation. Try again." />)

    const err = screen.getByTestId('invite-user-general-error')
    expect(err.getAttribute('role')).toBe('alert')
    expect(err.textContent).toBe('Could not create the invitation. Try again.')
  })

  it('submitting=true shows "Sending…" and disables the form controls', () => {
    render(<InviteUserModal {...baseProps} email="alice@welld.ch" submitting={true} />)

    expect(screen.getByText('Sending…')).not.toBeNull()
    expect(screen.getByTestId('invite-user-email').hasAttribute('disabled')).toBe(true)
    expect(screen.getByTestId('invite-user-cancel').hasAttribute('disabled')).toBe(true)
    expect(screen.getByTestId('invite-user-submit').hasAttribute('disabled')).toBe(true)
  })
})
