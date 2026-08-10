/**
 * @vitest-environment jsdom
 *
 * Component tests for CreateDepartmentModal — Modal M2 (T19,
 * specs/004-auth-roles-permissions).
 *
 * Covers:
 *   (A) role="dialog" labelled by the title; default focus on the Name field.
 *   (B) Escape calls onCancel.
 *   (C) focus trap: Tab from the last focusable (Create) wraps to the first
 *       (Name input); Shift+Tab from the first wraps to the last.
 *   (D) client-side validation: empty name blocks submit (no onSubmit call)
 *       and shows an inline error; never disables Cancel.
 *   (E) valid submit calls onSubmit with the trimmed name/description,
 *       omitting `description` entirely when blank.
 *   (F) isSubmitting disables all fields/buttons and shows "Creating…".
 *   (G) server errorMessage (e.g. 409) renders inline; a subsequent local
 *       validation error would take precedence only if re-triggered (not
 *       tested here beyond confirming the prop renders as expected).
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import CreateDepartmentModal from './CreateDepartmentModal'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const baseProps = {
  isSubmitting: false,
  errorMessage: null,
  onSubmit: vi.fn(),
  onCancel: vi.fn(),
}

describe('CreateDepartmentModal', () => {
  it('renders as a dialog labelled by its title, focused on the Name field', () => {
    render(<CreateDepartmentModal {...baseProps} />)

    const dialog = screen.getByRole('dialog')
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(dialog.getAttribute('aria-labelledby')).toBe('create-department-title')
    expect(screen.getByText('New department')).not.toBeNull()
    expect(document.activeElement).toBe(screen.getByTestId('create-department-name-input'))
  })

  it('Escape calls onCancel', () => {
    const onCancel = vi.fn()
    render(<CreateDepartmentModal {...baseProps} onCancel={onCancel} />)

    fireEvent.keyDown(window, { key: 'Escape' })

    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('traps Tab from the last focusable (Create) back to the first (Name input)', () => {
    render(<CreateDepartmentModal {...baseProps} />)

    const nameInput = screen.getByTestId('create-department-name-input')
    const createBtn = screen.getByTestId('create-department-submit')
    createBtn.focus()
    expect(document.activeElement).toBe(createBtn)

    fireEvent.keyDown(window, { key: 'Tab' })

    expect(document.activeElement).toBe(nameInput)
  })

  it('traps Shift+Tab from the first focusable (Name input) to the last (Create)', () => {
    render(<CreateDepartmentModal {...baseProps} />)

    const nameInput = screen.getByTestId('create-department-name-input')
    const createBtn = screen.getByTestId('create-department-submit')
    nameInput.focus()
    expect(document.activeElement).toBe(nameInput)

    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true })

    expect(document.activeElement).toBe(createBtn)
  })

  it('blocks submit with an inline error when Name is empty', () => {
    const onSubmit = vi.fn()
    render(<CreateDepartmentModal {...baseProps} onSubmit={onSubmit} />)

    fireEvent.click(screen.getByTestId('create-department-submit'))

    expect(onSubmit).not.toHaveBeenCalled()
    const error = screen.getByTestId('create-department-error')
    expect(error.getAttribute('role')).toBe('alert')
    expect(error.textContent).toBe('Name is required.')
    expect(screen.getByTestId('create-department-cancel').hasAttribute('disabled')).toBe(false)
  })

  it('submits trimmed name+description on valid input', () => {
    const onSubmit = vi.fn()
    render(<CreateDepartmentModal {...baseProps} onSubmit={onSubmit} />)

    fireEvent.change(screen.getByTestId('create-department-name-input'), {
      target: { value: '  Accounting  ' },
    })
    fireEvent.change(screen.getByTestId('create-department-description-input'), {
      target: { value: '  Finance & billing  ' },
    })
    fireEvent.click(screen.getByTestId('create-department-submit'))

    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit).toHaveBeenCalledWith({ name: 'Accounting', description: 'Finance & billing' })
  })

  it('omits description when left blank', () => {
    const onSubmit = vi.fn()
    render(<CreateDepartmentModal {...baseProps} onSubmit={onSubmit} />)

    fireEvent.change(screen.getByTestId('create-department-name-input'), {
      target: { value: 'HR' },
    })
    fireEvent.click(screen.getByTestId('create-department-submit'))

    expect(onSubmit).toHaveBeenCalledWith({ name: 'HR', description: undefined })
  })

  it('isSubmitting disables fields/buttons and shows "Creating…"', () => {
    render(<CreateDepartmentModal {...baseProps} isSubmitting={true} />)

    expect(screen.getByTestId('create-department-name-input').hasAttribute('disabled')).toBe(true)
    expect(screen.getByTestId('create-department-description-input').hasAttribute('disabled')).toBe(true)
    expect(screen.getByTestId('create-department-cancel').hasAttribute('disabled')).toBe(true)
    expect(screen.getByTestId('create-department-submit').hasAttribute('disabled')).toBe(true)
    expect(screen.getByText('Creating…')).not.toBeNull()
  })

  it('renders a server errorMessage (e.g. 409 duplicate name) inline', () => {
    render(<CreateDepartmentModal {...baseProps} errorMessage='A department named "HR" already exists' />)

    const error = screen.getByTestId('create-department-error')
    expect(error.textContent).toContain('already exists')
  })

  it('clicking Cancel or the "×" calls onCancel', () => {
    const onCancel = vi.fn()
    render(<CreateDepartmentModal {...baseProps} onCancel={onCancel} />)

    fireEvent.click(screen.getByTestId('create-department-cancel'))
    expect(onCancel).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByLabelText('Cancel'))
    expect(onCancel).toHaveBeenCalledTimes(2)
  })
})
