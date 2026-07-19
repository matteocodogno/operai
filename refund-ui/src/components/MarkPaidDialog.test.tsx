/**
 * @vitest-environment jsdom
 *
 * Component tests for MarkPaidDialog (T12, specs/008-refund-monthly-
 * processing/tasks.md). Covers: role="alertdialog" + labelling, default
 * focus on Cancel (not the checkbox — design.md Accessibility), the
 * disabled-until-checked confirm gate, the email-status FYI line (with the
 * extra "you can still mark this batch paid" only on `failed`), Escape =
 * Cancel, the Tab focus trap across [checkbox, Cancel, Confirm], the
 * in-flight/error states, and the batch summary content.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import MarkPaidDialog from './MarkPaidDialog'

afterEach(() => {
  cleanup()
})

const baseProps = {
  requestCount: 3,
  subtotals: [{ currency: 'EUR' as const, approvedCents: 5000 }],
  emailStatus: 'sent' as const,
  isConfirming: false,
  errorMessage: null,
  onConfirm: vi.fn(),
  onCancel: vi.fn(),
}

describe('MarkPaidDialog', () => {
  it('renders as an alertdialog labelled/described, with the request count and subtotals in the body', () => {
    render(<MarkPaidDialog {...baseProps} />)

    const dialog = screen.getByRole('alertdialog')
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(dialog.getAttribute('aria-labelledby')).toBe('mark-paid-dialog-title')
    expect(dialog.getAttribute('aria-describedby')).toBe('mark-paid-dialog-body')
    expect(screen.getByTestId('batch-subtotals-panel')).not.toBeNull()
  })

  it('focuses Cancel by default (not the checkbox — a safe default for a consequential action)', () => {
    render(<MarkPaidDialog {...baseProps} />)
    expect(document.activeElement).toBe(screen.getByTestId('mark-paid-dialog-cancel'))
  })

  it('shows the email status FYI, with the extra reassurance only when the last attempt failed', () => {
    const { rerender } = render(<MarkPaidDialog {...baseProps} emailStatus="sent" />)
    expect(screen.getByTestId('mark-paid-dialog-email-fyi').textContent).toMatch(/sent/i)
    expect(screen.getByTestId('mark-paid-dialog-email-fyi').textContent).not.toMatch(/you can still/i)

    rerender(<MarkPaidDialog {...baseProps} emailStatus="failed" />)
    expect(screen.getByTestId('mark-paid-dialog-email-fyi').textContent).toMatch(/failed/i)
    expect(screen.getByTestId('mark-paid-dialog-email-fyi').textContent).toMatch(/you can still/i)

    rerender(<MarkPaidDialog {...baseProps} emailStatus={null} />)
    expect(screen.getByTestId('mark-paid-dialog-email-fyi').textContent).toMatch(/not yet attempted/i)
  })

  it('Confirm stays disabled until the checkbox is checked', () => {
    render(<MarkPaidDialog {...baseProps} />)

    const confirmBtn = screen.getByTestId('mark-paid-dialog-confirm')
    expect(confirmBtn.hasAttribute('disabled')).toBe(true)

    fireEvent.click(screen.getByTestId('mark-paid-dialog-checkbox'))
    expect(confirmBtn.hasAttribute('disabled')).toBe(false)

    fireEvent.click(screen.getByTestId('mark-paid-dialog-checkbox'))
    expect(confirmBtn.hasAttribute('disabled')).toBe(true)
  })

  it('Escape calls onCancel and never onConfirm', () => {
    const onCancel = vi.fn()
    const onConfirm = vi.fn()
    render(<MarkPaidDialog {...baseProps} onCancel={onCancel} onConfirm={onConfirm} />)

    fireEvent.keyDown(window, { key: 'Escape' })

    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('traps Tab focus across [checkbox, Cancel, Confirm] once Confirm is enabled', () => {
    render(<MarkPaidDialog {...baseProps} />)

    fireEvent.click(screen.getByTestId('mark-paid-dialog-checkbox'))

    const checkbox = screen.getByTestId('mark-paid-dialog-checkbox')
    const cancelBtn = screen.getByTestId('mark-paid-dialog-cancel')
    const confirmBtn = screen.getByTestId('mark-paid-dialog-confirm')

    confirmBtn.focus()
    fireEvent.keyDown(window, { key: 'Tab' })
    expect(document.activeElement).toBe(checkbox)

    checkbox.focus()
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(confirmBtn)

    void cancelBtn
  })

  it('calls onConfirm when Confirm is clicked (checkbox checked)', () => {
    const onConfirm = vi.fn()
    render(<MarkPaidDialog {...baseProps} onConfirm={onConfirm} />)

    fireEvent.click(screen.getByTestId('mark-paid-dialog-checkbox'))
    fireEvent.click(screen.getByTestId('mark-paid-dialog-confirm'))

    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('confirming state: checkbox + both buttons disabled, in-flight label shown', () => {
    render(<MarkPaidDialog {...baseProps} isConfirming={true} />)

    expect(screen.getByTestId('mark-paid-dialog-checkbox').hasAttribute('disabled')).toBe(true)
    expect(screen.getByTestId('mark-paid-dialog-cancel').hasAttribute('disabled')).toBe(true)
    expect(screen.getByTestId('mark-paid-dialog-confirm').hasAttribute('disabled')).toBe(true)
    expect(screen.getByText('Marking as paid…')).not.toBeNull()
  })

  it('shows an inline error, role=alert', () => {
    render(<MarkPaidDialog {...baseProps} errorMessage="Could not mark this batch as paid. Try again." />)

    const err = screen.getByTestId('mark-paid-dialog-error')
    expect(err.getAttribute('role')).toBe('alert')
    expect(err.textContent).toBe('Could not mark this batch as paid. Try again.')
  })

  it('clicking the backdrop calls onCancel', () => {
    const onCancel = vi.fn()
    render(<MarkPaidDialog {...baseProps} onCancel={onCancel} />)

    fireEvent.click(screen.getByTestId('mark-paid-dialog-modal'))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})
