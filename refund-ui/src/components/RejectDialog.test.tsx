/**
 * @vitest-environment jsdom
 *
 * Component tests for RejectDialog (T18, specs/007-refund-service/
 * tasks.md). Covers: role="alertdialog" + labelling, default focus on the
 * textarea, disabled-until-non-empty confirm (AC-7.3's client-side half),
 * Escape = Cancel, the Tab focus trap across [textarea, Cancel, Confirm],
 * the in-flight/error states, and that onConfirm receives the trimmed
 * motivation.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import RejectDialog from './RejectDialog'

afterEach(() => {
  cleanup()
})

const baseProps = {
  employeeName: 'Alice',
  isDeciding: false,
  errorMessage: null,
  onConfirm: vi.fn(),
  onCancel: vi.fn(),
}

describe('RejectDialog', () => {
  it('renders as an alertdialog labelled/described, with the employee name in the body', () => {
    render(<RejectDialog {...baseProps} />)

    const dialog = screen.getByRole('alertdialog')
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(dialog.getAttribute('aria-labelledby')).toBe('reject-dialog-title')
    expect(dialog.getAttribute('aria-describedby')).toBe('reject-dialog-body')
    expect(screen.getByText(/Alice is notified immediately/)).not.toBeNull()
  })

  it('focuses the motivation textarea by default', () => {
    render(<RejectDialog {...baseProps} />)
    expect(document.activeElement).toBe(screen.getByTestId('reject-dialog-motivation'))
  })

  it('the required motivation textarea carries aria-required', () => {
    render(<RejectDialog {...baseProps} />)
    expect(screen.getByTestId('reject-dialog-motivation').getAttribute('aria-required')).toBe('true')
  })

  it('Confirm stays disabled until the textarea is non-empty', () => {
    render(<RejectDialog {...baseProps} />)

    const confirmBtn = screen.getByTestId('reject-dialog-confirm')
    expect(confirmBtn.hasAttribute('disabled')).toBe(true)

    fireEvent.change(screen.getByTestId('reject-dialog-motivation'), { target: { value: 'Missing receipt.' } })
    expect(confirmBtn.hasAttribute('disabled')).toBe(false)

    fireEvent.change(screen.getByTestId('reject-dialog-motivation'), { target: { value: '   ' } })
    expect(confirmBtn.hasAttribute('disabled')).toBe(true)
  })

  it('Escape calls onCancel and never onConfirm', () => {
    const onCancel = vi.fn()
    const onConfirm = vi.fn()
    render(<RejectDialog {...baseProps} onCancel={onCancel} onConfirm={onConfirm} />)

    fireEvent.keyDown(window, { key: 'Escape' })

    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('traps Tab focus across [textarea, Cancel, Confirm] once Confirm is enabled', () => {
    render(<RejectDialog {...baseProps} />)

    fireEvent.change(screen.getByTestId('reject-dialog-motivation'), { target: { value: 'Missing receipt.' } })

    const textarea = screen.getByTestId('reject-dialog-motivation')
    const cancelBtn = screen.getByTestId('reject-dialog-cancel')
    const confirmBtn = screen.getByTestId('reject-dialog-confirm')

    confirmBtn.focus()
    fireEvent.keyDown(window, { key: 'Tab' })
    expect(document.activeElement).toBe(textarea)

    textarea.focus()
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(confirmBtn)

    void cancelBtn
  })

  it('calls onConfirm with the trimmed motivation', () => {
    const onConfirm = vi.fn()
    render(<RejectDialog {...baseProps} onConfirm={onConfirm} />)

    fireEvent.change(screen.getByTestId('reject-dialog-motivation'), { target: { value: '  Missing receipt.  ' } })
    fireEvent.click(screen.getByTestId('reject-dialog-confirm'))

    expect(onConfirm).toHaveBeenCalledWith('Missing receipt.')
  })

  it('deciding state: both buttons + textarea disabled, in-flight label shown', () => {
    render(<RejectDialog {...baseProps} isDeciding={true} />)

    expect(screen.getByTestId('reject-dialog-motivation').hasAttribute('disabled')).toBe(true)
    expect(screen.getByTestId('reject-dialog-cancel').hasAttribute('disabled')).toBe(true)
    expect(screen.getByTestId('reject-dialog-confirm').hasAttribute('disabled')).toBe(true)
    expect(screen.getByText('Rejecting…')).not.toBeNull()
  })

  it('shows an inline error, role=alert', () => {
    render(<RejectDialog {...baseProps} errorMessage="Could not record this decision. Try again." />)

    const err = screen.getByTestId('reject-dialog-error')
    expect(err.getAttribute('role')).toBe('alert')
    expect(err.textContent).toBe('Could not record this decision. Try again.')
  })

  it('clicking the backdrop calls onCancel', () => {
    const onCancel = vi.fn()
    render(<RejectDialog {...baseProps} onCancel={onCancel} />)

    fireEvent.click(screen.getByTestId('reject-dialog-modal'))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})
