/**
 * @vitest-environment jsdom
 *
 * Component tests for ConfirmDialog (T25, specs/015-hardware-inventory,
 * design.md § Component inventory: "Confirm dialogs (return, lost, cancel
 * assignment, decline)"). Carried over from refund-ui's ConfirmDeleteModal
 * (same props, same behaviour), plus the two rules design.md § Accessibility
 * adds for every dialog: in flight it is not dismissible and its confirm
 * button is aria-busy; closing returns focus to the trigger.
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
import ConfirmDialog from './ConfirmDialog'

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

describe('ConfirmDialog', () => {
  it('renders as an alertdialog labelled and described by the title/body', () => {
    render(<ConfirmDialog {...baseProps} />)

    const dialog = screen.getByRole('alertdialog')
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(dialog.getAttribute('aria-labelledby')).toBe('confirm-delete-title')
    expect(dialog.getAttribute('aria-describedby')).toBe('confirm-delete-body')
    expect(screen.getByText('Delete request?')).not.toBeNull()
    expect(screen.getByText(/Draft request from 2026-07-01/)).not.toBeNull()
  })

  it('focuses Cancel by default (safe default, not Delete)', () => {
    render(<ConfirmDialog {...baseProps} />)

    expect(document.activeElement).toBe(screen.getByTestId('confirm-delete-cancel'))
  })

  it('Escape calls onCancel and never onConfirm', () => {
    const onCancel = vi.fn()
    const onConfirm = vi.fn()
    render(<ConfirmDialog {...baseProps} onCancel={onCancel} onConfirm={onConfirm} />)

    fireEvent.keyDown(window, { key: 'Escape' })

    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('traps Tab focus: from Delete (last), Tab wraps to Cancel (first)', () => {
    render(<ConfirmDialog {...baseProps} />)

    const cancelBtn = screen.getByTestId('confirm-delete-cancel')
    const deleteBtn = screen.getByTestId('confirm-delete-confirm')
    deleteBtn.focus()
    expect(document.activeElement).toBe(deleteBtn)

    fireEvent.keyDown(window, { key: 'Tab' })

    expect(document.activeElement).toBe(cancelBtn)
  })

  it('traps Shift+Tab focus: from Cancel (first), Shift+Tab wraps to Delete (last)', () => {
    render(<ConfirmDialog {...baseProps} />)

    const cancelBtn = screen.getByTestId('confirm-delete-cancel')
    const deleteBtn = screen.getByTestId('confirm-delete-confirm')
    cancelBtn.focus()
    expect(document.activeElement).toBe(cancelBtn)

    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true })

    expect(document.activeElement).toBe(deleteBtn)
  })

  it('idle state: both buttons enabled, no error text', () => {
    render(<ConfirmDialog {...baseProps} />)

    expect(screen.getByTestId('confirm-delete-cancel').hasAttribute('disabled')).toBe(false)
    expect(screen.getByTestId('confirm-delete-confirm').hasAttribute('disabled')).toBe(false)
    expect(screen.queryByTestId('confirm-delete-error')).toBeNull()
  })

  it('deleting state: both buttons disabled and a spinner + "Deleting…" text shown', () => {
    render(<ConfirmDialog {...baseProps} isDeleting={true} />)

    expect(screen.getByTestId('confirm-delete-cancel').hasAttribute('disabled')).toBe(true)
    expect(screen.getByTestId('confirm-delete-confirm').hasAttribute('disabled')).toBe(true)
    expect(screen.getByText('Deleting…')).not.toBeNull()
  })

  it('error state: inline role="alert" message shown, buttons re-enabled', () => {
    render(<ConfirmDialog {...baseProps} errorMessage="Delete failed. Try again." />)

    const err = screen.getByTestId('confirm-delete-error')
    expect(err.getAttribute('role')).toBe('alert')
    expect(err.textContent).toBe('Delete failed. Try again.')
    expect(screen.getByTestId('confirm-delete-cancel').hasAttribute('disabled')).toBe(false)
    expect(screen.getByTestId('confirm-delete-confirm').hasAttribute('disabled')).toBe(false)
  })

  it('clicking Delete calls onConfirm; clicking Cancel calls onCancel', () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    render(<ConfirmDialog {...baseProps} onConfirm={onConfirm} onCancel={onCancel} />)

    fireEvent.click(screen.getByTestId('confirm-delete-confirm'))
    expect(onConfirm).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByTestId('confirm-delete-cancel'))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('clicking the backdrop calls onCancel', () => {
    const onCancel = vi.fn()
    render(<ConfirmDialog {...baseProps} onCancel={onCancel} />)

    fireEvent.click(screen.getByTestId('confirm-delete-modal'))

    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('falls back to "Untitled" when itemName is empty', () => {
    render(<ConfirmDialog {...baseProps} itemName="" />)

    expect(screen.getByText(/Untitled/)).not.toBeNull()
  })

  it('renders the default hard-delete copy verbatim when `body` is omitted (backward compatibility)', () => {
    render(<ConfirmDialog {...baseProps} />)

    expect(screen.getByText(/Draft request from 2026-07-01/)).not.toBeNull()
    expect(screen.getByText(/will be permanently deleted\. This cannot be undone\./)).not.toBeNull()
  })

  it('tone="positive" recolors the confirm button and spinner to --grn instead of --red', () => {
    render(<ConfirmDialog {...baseProps} tone="positive" isDeleting={true} />)

    const confirmBtn = screen.getByTestId('confirm-delete-confirm')
    expect(confirmBtn.getAttribute('style')).toContain('var(--grn)')
    expect(confirmBtn.getAttribute('style')).not.toContain('var(--red)')
  })

  it('title/confirmLabel/confirmingLabel override the default Delete copy', () => {
    render(
      <ConfirmDialog
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

  it('testIdPrefix namespaces every testid/internal id this dialog renders', () => {
    render(<ConfirmDialog {...baseProps} testIdPrefix="approve-dialog" />)

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
      <ConfirmDialog
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

  it('in flight, Escape and the backdrop do not dismiss (design.md § Accessibility: "dialog not dismissible")', () => {
    const onCancel = vi.fn()
    render(<ConfirmDialog {...baseProps} onCancel={onCancel} isDeleting={true} />)

    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.click(screen.getByTestId('confirm-delete-modal'))

    expect(onCancel).not.toHaveBeenCalled()
  })

  it('in flight, the confirm button is aria-busy; idle it is not', () => {
    const { rerender } = render(<ConfirmDialog {...baseProps} />)
    expect(screen.getByTestId('confirm-delete-confirm').getAttribute('aria-busy')).toBeNull()

    rerender(<ConfirmDialog {...baseProps} isDeleting={true} />)
    expect(screen.getByTestId('confirm-delete-confirm').getAttribute('aria-busy')).toBe('true')
  })

  it('returns focus to the element that had it when the dialog opened, once it closes', () => {
    const trigger = document.createElement('button')
    document.body.appendChild(trigger)
    trigger.focus()

    const { unmount } = render(<ConfirmDialog {...baseProps} />)
    expect(document.activeElement).toBe(screen.getByTestId('confirm-delete-cancel'))

    unmount()
    expect(document.activeElement).toBe(trigger)
    trigger.remove()
  })

  it('does not throw when the trigger is gone by the time the dialog closes', () => {
    const trigger = document.createElement('button')
    document.body.appendChild(trigger)
    trigger.focus()

    const { unmount } = render(<ConfirmDialog {...baseProps} />)
    trigger.remove()

    expect(() => unmount()).not.toThrow()
  })
})
