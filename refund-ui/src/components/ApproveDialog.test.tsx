/**
 * @vitest-environment jsdom
 *
 * Component tests for ApproveDialog (T18, specs/007-refund-service/
 * tasks.md). Thin wrapper over ConfirmDeleteModal — focus-trap/Escape/
 * confirm behavior is already covered by ConfirmDeleteModal.test.tsx; these
 * tests only assert ApproveDialog's own wiring: the positive tone, the
 * refund-specific copy, the distinct testIdPrefix, and the callbacks.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import ApproveDialog from './ApproveDialog'

afterEach(() => {
  cleanup()
})

describe('ApproveDialog', () => {
  it('renders under the approve-dialog testIdPrefix, recolored --grn, with refund-specific copy', () => {
    render(
      <ApproveDialog
        employeeName="Alice"
        isDeciding={false}
        errorMessage={null}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    )

    expect(screen.getByTestId('approve-dialog-modal')).not.toBeNull()
    expect(screen.getByText('Approve this request?')).not.toBeNull()
    expect(screen.getByText(/Alice is notified immediately/)).not.toBeNull()
    const confirmBtn = screen.getByTestId('approve-dialog-confirm')
    expect(confirmBtn.textContent).toBe('Approve')
    expect(confirmBtn.getAttribute('style')).toContain('var(--grn)')
  })

  it('shows the in-flight label and disables both buttons while deciding', () => {
    render(
      <ApproveDialog
        employeeName="Alice"
        isDeciding={true}
        errorMessage={null}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    )

    expect(screen.getByText('Approving…')).not.toBeNull()
    expect(screen.getByTestId('approve-dialog-cancel').hasAttribute('disabled')).toBe(true)
    expect(screen.getByTestId('approve-dialog-confirm').hasAttribute('disabled')).toBe(true)
  })

  it('shows an inline error and wires onConfirm/onCancel', () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    render(
      <ApproveDialog
        employeeName="Alice"
        isDeciding={false}
        errorMessage="Could not record this decision. Try again."
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    )

    expect(screen.getByTestId('approve-dialog-error').textContent).toBe('Could not record this decision. Try again.')

    fireEvent.click(screen.getByTestId('approve-dialog-confirm'))
    expect(onConfirm).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByTestId('approve-dialog-cancel'))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})
