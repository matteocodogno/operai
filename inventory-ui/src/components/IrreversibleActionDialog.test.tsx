/**
 * @vitest-environment jsdom
 *
 * Component tests for IrreversibleActionDialog (T26, specs/015-hardware-
 * inventory; design.md § NEW components — "generalises MarkPaidDialog
 * (checkbox-acknowledged, trapped tab sequence) … plus a form slot" — and
 * § Accessibility "Dialogs"). Used for dispose, close year and the other acts
 * that cannot be undone.
 *
 * Covers: the `alertdialog` landmark (modal, labelled by the title, described by
 * the consequence); the confirm button disabled until the acknowledgement
 * checkbox is checked (the label is the whole sentence); default focus on Cancel
 * (a pure confirm) or on the first field (a form slot); the Tab trap over the
 * real focusable set (a disabled Confirm is excluded); Escape cancels and
 * returns focus to the trigger; the in-flight state (aria-busy, fields locked,
 * not dismissible); the inline error; Enter in a field confirms only once
 * acknowledged.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import IrreversibleActionDialog from './IrreversibleActionDialog'
import type { IrreversibleActionDialogProps } from './IrreversibleActionDialog'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const baseProps: IrreversibleActionDialogProps = {
  title: 'Close fiscal year 2025?',
  consequence: 'Closing 2025 for WellD CH cannot be undone.',
  acknowledgeLabel: 'I understand that closing 2025 cannot be undone.',
  confirmLabel: 'Close year',
  confirmingLabel: 'Closing…',
  isConfirming: false,
  errorMessage: null,
  onConfirm: vi.fn(),
  onCancel: vi.fn(),
}

const renderDialog = (props: Partial<IrreversibleActionDialogProps> = {}) =>
  render(<IrreversibleActionDialog {...baseProps} onConfirm={vi.fn()} onCancel={vi.fn()} {...props} />)

const confirmButton = () => screen.getByTestId('irreversible-dialog-confirm') as HTMLButtonElement
const checkbox = () => screen.getByRole('checkbox') as HTMLInputElement

describe('IrreversibleActionDialog', () => {
  it('renders as a modal alertdialog labelled by the title and described by the consequence', () => {
    renderDialog()

    const dialog = screen.getByRole('alertdialog', { name: 'Close fiscal year 2025?' })
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    const describedBy = dialog.getAttribute('aria-describedby')
    expect(describedBy).not.toBeNull()
    expect(document.getElementById(describedBy!)?.textContent).toContain('cannot be undone')
  })

  it('labels the checkbox with the whole acknowledgement sentence', () => {
    renderDialog()

    expect(screen.getByLabelText('I understand that closing 2025 cannot be undone.')).toBe(checkbox())
  })

  describe('the acknowledgement gate', () => {
    it('starts unchecked with Confirm disabled', () => {
      renderDialog()

      expect(checkbox().checked).toBe(false)
      expect(confirmButton().disabled).toBe(true)
    })

    it('enables Confirm only once the checkbox is checked, and disables it again when unchecked', () => {
      renderDialog()

      fireEvent.click(checkbox())
      expect(confirmButton().disabled).toBe(false)

      fireEvent.click(checkbox())
      expect(confirmButton().disabled).toBe(true)
    })

    it('does not confirm from a click while unacknowledged', () => {
      const onConfirm = vi.fn()
      renderDialog({ onConfirm })

      fireEvent.click(confirmButton())

      expect(onConfirm).not.toHaveBeenCalled()
    })

    it('confirms once acknowledged', () => {
      const onConfirm = vi.fn()
      renderDialog({ onConfirm })

      fireEvent.click(checkbox())
      fireEvent.click(confirmButton())

      expect(onConfirm).toHaveBeenCalledTimes(1)
    })

    it('does not confirm on form submit (Enter in a field) until acknowledged', () => {
      const onConfirm = vi.fn()
      renderDialog({ onConfirm, children: <input aria-label="Disposal date" /> })
      const form = screen.getByLabelText('Disposal date').closest('form')!

      fireEvent.submit(form)
      expect(onConfirm).not.toHaveBeenCalled()

      fireEvent.click(checkbox())
      fireEvent.submit(form)
      expect(onConfirm).toHaveBeenCalledTimes(1)
    })
  })

  describe('default focus', () => {
    it('lands on Cancel for a pure confirm', () => {
      renderDialog()

      expect(document.activeElement).toBe(screen.getByTestId('irreversible-dialog-cancel'))
    })

    it('lands on the first field when the dialog carries a form slot', () => {
      renderDialog({ children: <input aria-label="Disposal date" /> })

      expect(document.activeElement).toBe(screen.getByLabelText('Disposal date'))
    })
  })

  describe('the form slot', () => {
    it('renders the caller fields inside the dialog', () => {
      renderDialog({ children: <input aria-label="Disposal date" /> })

      expect(screen.getByRole('alertdialog').contains(screen.getByLabelText('Disposal date'))).toBe(true)
    })

    it('keeps the typed values when the dialog re-renders with an error', () => {
      const Harness = () => {
        const [error, setError] = useState<string | null>(null)
        return (
          <IrreversibleActionDialog {...baseProps} errorMessage={error} onConfirm={() => setError('Failed.')}>
            <input aria-label="Disposal date" />
          </IrreversibleActionDialog>
        )
      }
      render(<Harness />)
      const input = screen.getByLabelText('Disposal date') as HTMLInputElement
      fireEvent.change(input, { target: { value: '2026-10-01' } })
      fireEvent.click(checkbox())

      fireEvent.click(confirmButton())

      expect(screen.getByRole('alert').textContent).toBe('Failed.')
      expect(input.value).toBe('2026-10-01')
      expect(checkbox().checked).toBe(true)
    })
  })

  describe('keyboard', () => {
    it('Escape cancels and never confirms', () => {
      const onCancel = vi.fn()
      const onConfirm = vi.fn()
      renderDialog({ onCancel, onConfirm })

      fireEvent.keyDown(window, { key: 'Escape' })

      expect(onCancel).toHaveBeenCalledTimes(1)
      expect(onConfirm).not.toHaveBeenCalled()
    })

    it('traps Tab over the real focusable set: with Confirm disabled, Cancel is the last stop and wraps to the first', () => {
      renderDialog()

      screen.getByTestId('irreversible-dialog-cancel').focus()
      fireEvent.keyDown(window, { key: 'Tab' })

      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }))
    })

    it('once acknowledged, Confirm joins the sequence as the last stop', () => {
      renderDialog()
      fireEvent.click(checkbox())

      confirmButton().focus()
      fireEvent.keyDown(window, { key: 'Tab' })
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }))

      fireEvent.keyDown(window, { key: 'Tab', shiftKey: true })
      expect(document.activeElement).toBe(confirmButton())
    })

    it('pulls focus back in when Tab is pressed from outside the dialog', () => {
      const outside = document.createElement('button')
      document.body.appendChild(outside)
      renderDialog()
      outside.focus()

      fireEvent.keyDown(window, { key: 'Tab' })

      expect(screen.getByRole('alertdialog').contains(document.activeElement)).toBe(true)
      outside.remove()
    })
  })

  describe('focus return', () => {
    it('Escape closes it and focus returns to the trigger', () => {
      const trigger = document.createElement('button')
      document.body.appendChild(trigger)
      trigger.focus()

      const Harness = () => {
        const [open, setOpen] = useState(true)
        return open ? <IrreversibleActionDialog {...baseProps} onCancel={() => setOpen(false)} /> : null
      }
      render(<Harness />)
      expect(document.activeElement).toBe(screen.getByTestId('irreversible-dialog-cancel'))

      fireEvent.keyDown(window, { key: 'Escape' })

      expect(screen.queryByRole('alertdialog')).toBeNull()
      expect(document.activeElement).toBe(trigger)
      trigger.remove()
    })

    it('does not throw when the trigger is gone by the time the dialog closes', () => {
      const trigger = document.createElement('button')
      document.body.appendChild(trigger)
      trigger.focus()
      const { unmount } = renderDialog()
      trigger.remove()

      expect(() => unmount()).not.toThrow()
    })
  })

  describe('backdrop and ×', () => {
    it('the backdrop and × cancel; a click inside the dialog does not', () => {
      const onCancel = vi.fn()
      renderDialog({ onCancel })

      fireEvent.click(screen.getByRole('alertdialog'))
      expect(onCancel).not.toHaveBeenCalled()

      fireEvent.click(screen.getByTestId('irreversible-dialog-backdrop'))
      fireEvent.click(screen.getByRole('button', { name: 'Close' }))
      expect(onCancel).toHaveBeenCalledTimes(2)
    })
  })

  describe('in flight', () => {
    const renderInFlight = (props: Partial<IrreversibleActionDialogProps> = {}) =>
      renderDialog({ isConfirming: true, children: <input aria-label="Disposal date" />, ...props })

    it('shows the confirming label, marks Confirm aria-busy, and locks the fields and every button', () => {
      renderInFlight()

      expect(confirmButton().textContent).toContain('Closing…')
      expect(confirmButton().getAttribute('aria-busy')).toBe('true')
      expect(confirmButton().disabled).toBe(true)
      expect((screen.getByTestId('irreversible-dialog-cancel') as HTMLButtonElement).disabled).toBe(true)
      expect(screen.getByLabelText('Disposal date').matches(':disabled')).toBe(true)
      expect(checkbox().disabled).toBe(true)
    })

    it('is not dismissible: Escape and the backdrop do nothing', () => {
      const onCancel = vi.fn()
      renderInFlight({ onCancel })

      fireEvent.keyDown(window, { key: 'Escape' })
      fireEvent.click(screen.getByTestId('irreversible-dialog-backdrop'))

      expect(onCancel).not.toHaveBeenCalled()
    })

    it('does not confirm a second time, even when acknowledged', () => {
      const onConfirm = vi.fn()
      renderInFlight({ onConfirm })

      fireEvent.submit(screen.getByLabelText('Disposal date').closest('form')!)

      expect(onConfirm).not.toHaveBeenCalled()
    })
  })

  describe('error', () => {
    it('shows the error as an inline alert and leaves the dialog actionable', () => {
      renderDialog({ errorMessage: 'We cannot verify your access right now.' })

      expect(screen.getByRole('alert').textContent).toBe('We cannot verify your access right now.')
      expect(screen.getByTestId('irreversible-dialog-cancel')).not.toBeNull()
    })

    it('renders no alert without an error', () => {
      renderDialog()

      expect(screen.queryByRole('alert')).toBeNull()
    })
  })

  it('namespaces its test ids with testIdPrefix', () => {
    renderDialog({ testIdPrefix: 'close-year' })

    expect(screen.getByTestId('close-year-backdrop')).not.toBeNull()
    expect(screen.getByTestId('close-year-confirm')).not.toBeNull()
    expect(screen.queryByTestId('irreversible-dialog-confirm')).toBeNull()
  })
})
