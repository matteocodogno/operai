/**
 * @vitest-environment jsdom
 *
 * Component tests for ConfirmDeleteModal (T15, specs/007-refund-service,
 * design.md F1 step 7: "Delete request").
 *
 * Covers:
 *   (A) role="alertdialog" + labelled/described by the title/body.
 *   (B) default focus lands on Cancel (safe default), not Delete.
 *   (C) Escape triggers onCancel, never onConfirm.
 *   (D) focus trap: Tab from Delete (last) wraps to Cancel (first) and
 *       Shift+Tab from Cancel (first) wraps to Delete (last).
 *   (E) idle → deleting → error state rendering (spinner + disabled buttons;
 *       inline role="alert" error text).
 *   (F) onConfirm / onCancel wired to the respective buttons.
 *   (G) an overriding `body` renders instead of the default copy.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import ConfirmDeleteModal from './ConfirmDeleteModal'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const baseProps = {
  entityLabel: 'request',
  itemName: 'Draft request from 2026-07-01',
  isDeleting: false,
  errorMessage: null,
  onConfirm: vi.fn(),
  onCancel: vi.fn(),
}

describe('ConfirmDeleteModal', () => {
  it('renders as an alertdialog labelled and described by the title/body', () => {
    render(<ConfirmDeleteModal {...baseProps} />)

    const dialog = screen.getByRole('alertdialog')
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(dialog.getAttribute('aria-labelledby')).toBe('confirm-delete-title')
    expect(dialog.getAttribute('aria-describedby')).toBe('confirm-delete-body')
    expect(screen.getByText('Delete request?')).not.toBeNull()
    expect(screen.getByText(/Draft request from 2026-07-01/)).not.toBeNull()
  })

  it('focuses Cancel by default (safe default, not Delete)', () => {
    render(<ConfirmDeleteModal {...baseProps} />)

    expect(document.activeElement).toBe(screen.getByTestId('confirm-delete-cancel'))
  })

  it('Escape calls onCancel and never onConfirm', () => {
    const onCancel = vi.fn()
    const onConfirm = vi.fn()
    render(<ConfirmDeleteModal {...baseProps} onCancel={onCancel} onConfirm={onConfirm} />)

    fireEvent.keyDown(window, { key: 'Escape' })

    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('traps Tab focus: from Delete (last), Tab wraps to Cancel (first)', () => {
    render(<ConfirmDeleteModal {...baseProps} />)

    const cancelBtn = screen.getByTestId('confirm-delete-cancel')
    const deleteBtn = screen.getByTestId('confirm-delete-confirm')
    deleteBtn.focus()
    expect(document.activeElement).toBe(deleteBtn)

    fireEvent.keyDown(window, { key: 'Tab' })

    expect(document.activeElement).toBe(cancelBtn)
  })

  it('traps Shift+Tab focus: from Cancel (first), Shift+Tab wraps to Delete (last)', () => {
    render(<ConfirmDeleteModal {...baseProps} />)

    const cancelBtn = screen.getByTestId('confirm-delete-cancel')
    const deleteBtn = screen.getByTestId('confirm-delete-confirm')
    cancelBtn.focus()
    expect(document.activeElement).toBe(cancelBtn)

    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true })

    expect(document.activeElement).toBe(deleteBtn)
  })

  it('idle state: both buttons enabled, no error text', () => {
    render(<ConfirmDeleteModal {...baseProps} />)

    expect(screen.getByTestId('confirm-delete-cancel').hasAttribute('disabled')).toBe(false)
    expect(screen.getByTestId('confirm-delete-confirm').hasAttribute('disabled')).toBe(false)
    expect(screen.queryByTestId('confirm-delete-error')).toBeNull()
  })

  it('deleting state: both buttons disabled and a spinner + "Deleting…" text shown', () => {
    render(<ConfirmDeleteModal {...baseProps} isDeleting={true} />)

    expect(screen.getByTestId('confirm-delete-cancel').hasAttribute('disabled')).toBe(true)
    expect(screen.getByTestId('confirm-delete-confirm').hasAttribute('disabled')).toBe(true)
    expect(screen.getByText('Deleting…')).not.toBeNull()
  })

  it('error state: inline role="alert" message shown, buttons re-enabled', () => {
    render(<ConfirmDeleteModal {...baseProps} errorMessage="Delete failed. Try again." />)

    const err = screen.getByTestId('confirm-delete-error')
    expect(err.getAttribute('role')).toBe('alert')
    expect(err.textContent).toBe('Delete failed. Try again.')
    expect(screen.getByTestId('confirm-delete-cancel').hasAttribute('disabled')).toBe(false)
    expect(screen.getByTestId('confirm-delete-confirm').hasAttribute('disabled')).toBe(false)
  })

  it('clicking Delete calls onConfirm; clicking Cancel calls onCancel', () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    render(<ConfirmDeleteModal {...baseProps} onConfirm={onConfirm} onCancel={onCancel} />)

    fireEvent.click(screen.getByTestId('confirm-delete-confirm'))
    expect(onConfirm).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByTestId('confirm-delete-cancel'))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('clicking the backdrop calls onCancel', () => {
    const onCancel = vi.fn()
    render(<ConfirmDeleteModal {...baseProps} onCancel={onCancel} />)

    fireEvent.click(screen.getByTestId('confirm-delete-modal'))

    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('falls back to "Untitled" when itemName is empty', () => {
    render(<ConfirmDeleteModal {...baseProps} itemName="" />)

    expect(screen.getByText(/Untitled/)).not.toBeNull()
  })

  it('renders the default hard-delete copy verbatim when `body` is omitted (backward compatibility)', () => {
    render(<ConfirmDeleteModal {...baseProps} />)

    expect(screen.getByText(/Draft request from 2026-07-01/)).not.toBeNull()
    expect(screen.getByText(/will be permanently deleted\. This cannot be undone\./)).not.toBeNull()
  })

  it('T18: tone="positive" recolors the confirm button and spinner to --grn instead of --red', () => {
    render(<ConfirmDeleteModal {...baseProps} tone="positive" isDeleting={true} />)

    const confirmBtn = screen.getByTestId('confirm-delete-confirm')
    expect(confirmBtn.getAttribute('style')).toContain('var(--grn)')
    expect(confirmBtn.getAttribute('style')).not.toContain('var(--red)')
  })

  it('T18: title/confirmLabel/confirmingLabel override the default Delete copy', () => {
    render(
      <ConfirmDeleteModal
        {...baseProps}
        title="Approve this request?"
        confirmLabel="Approve"
        confirmingLabel="Approving…"
        isDeleting={true}
      />,
    )

    expect(screen.getByText('Approve this request?')).not.toBeNull()
    expect(screen.getByText('Approving…')).not.toBeNull()
    expect(screen.queryByText('Delete request?')).toBeNull()
  })

  it('T18: testIdPrefix namespaces every testid/internal id this dialog renders', () => {
    render(<ConfirmDeleteModal {...baseProps} testIdPrefix="approve-dialog" />)

    expect(screen.getByTestId('approve-dialog-modal')).not.toBeNull()
    expect(screen.getByTestId('approve-dialog-cancel')).not.toBeNull()
    expect(screen.getByTestId('approve-dialog-confirm')).not.toBeNull()
    expect(screen.queryByTestId('confirm-delete-modal')).toBeNull()

    const dialog = screen.getByRole('alertdialog')
    expect(dialog.getAttribute('aria-labelledby')).toBe('approve-dialog-title')
    expect(dialog.getAttribute('aria-describedby')).toBe('approve-dialog-body')
  })

  it('renders an overriding `body` instead of the default copy, still inside aria-describedby', () => {
    render(
      <ConfirmDeleteModal
        {...baseProps}
        body={
          <>
            <p>Delete this draft request and its 2 expense line(s)? This cannot be undone.</p>
            <ul>
              <li>Line 1</li>
              <li>Line 2</li>
            </ul>
          </>
        }
      />,
    )

    expect(screen.getByText(/its 2 expense line\(s\)/)).not.toBeNull()
    expect(screen.queryByText(/permanently deleted/)).toBeNull()

    const dialog = screen.getByRole('alertdialog')
    const describedById = dialog.getAttribute('aria-describedby')
    expect(describedById).toBe('confirm-delete-body')
    expect(document.getElementById(describedById!)?.querySelector('ul')).not.toBeNull()
  })
})
