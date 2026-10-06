/**
 * @vitest-environment jsdom
 *
 * Component tests for FormModal (T25, specs/015-hardware-inventory; the form
 * dialog pattern of admin-ui's AddRateEntryModal — design.md § Component
 * inventory "Form modal pattern", § Accessibility "Dialogs").
 *
 * Covers: the `dialog` landmark (modal, labelled by the title, described by the
 * notice); default focus on the first field; Escape and backdrop cancel; the
 * Tab trap over the REAL focusable set (a disabled submit is excluded); submit
 * through the form (Enter in a field) only when allowed; the in-flight state
 * (fields and buttons disabled, `aria-busy`, not dismissible); the general
 * error alert; focus returned to the trigger on close.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import FormModal from './FormModal'
import type { FormModalProps } from './FormModal'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const renderModal = (props: Partial<FormModalProps> = {}) =>
  render(
    <FormModal
      title="New rule for WellD CH"
      submitting={false}
      generalError={null}
      onSubmit={vi.fn()}
      onCancel={vi.fn()}
      {...props}
    >
      <label htmlFor="f1">First</label>
      <input id="f1" />
      <label htmlFor="f2">Second</label>
      <input id="f2" />
    </FormModal>,
  )

describe('FormModal', () => {
  it('renders a modal dialog labelled by its title', () => {
    renderModal()

    const dialog = screen.getByRole('dialog', { name: 'New rule for WellD CH' })
    expect(dialog.getAttribute('aria-modal')).toBe('true')
  })

  it('describes the dialog by the notice when one is given, and by nothing otherwise', () => {
    const { unmount } = renderModal({ description: 'This entry cannot be edited once saved.' })
    const dialog = screen.getByRole('dialog')
    const describedBy = dialog.getAttribute('aria-describedby')
    expect(describedBy).not.toBeNull()
    expect(document.getElementById(describedBy!)?.textContent).toBe('This entry cannot be edited once saved.')
    unmount()

    renderModal()
    expect(screen.getByRole('dialog').getAttribute('aria-describedby')).toBeNull()
  })

  it('focuses the first field on open', () => {
    renderModal()

    expect(document.activeElement).toBe(screen.getByLabelText('First'))
  })

  it('falls back to Cancel when the body has no field', () => {
    render(
      <FormModal title="T" submitting={false} generalError={null} onSubmit={vi.fn()} onCancel={vi.fn()}>
        <p>Nothing to fill.</p>
      </FormModal>,
    )

    expect(document.activeElement).toBe(screen.getByTestId('form-modal-cancel'))
  })

  it('Escape cancels and never submits', () => {
    const onCancel = vi.fn()
    const onSubmit = vi.fn()
    renderModal({ onCancel, onSubmit })

    fireEvent.keyDown(window, { key: 'Escape' })

    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('the backdrop and × cancel; a click inside the dialog does not', () => {
    const onCancel = vi.fn()
    renderModal({ onCancel })

    fireEvent.click(screen.getByRole('dialog'))
    expect(onCancel).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('form-modal-backdrop'))
    fireEvent.click(screen.getByTestId('form-modal-cancel'))
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onCancel).toHaveBeenCalledTimes(3)
  })

  it('traps Tab over the real focusable set: last wraps to first, Shift+Tab on first wraps to last', () => {
    renderModal()

    const submit = screen.getByTestId('form-modal-submit')
    submit.focus()
    fireEvent.keyDown(window, { key: 'Tab' })
    expect(document.activeElement).not.toBe(submit)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }))

    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(submit)
  })

  it('leaves a disabled submit out of the trap: Cancel is then the last stop', () => {
    renderModal({ canSubmit: false })

    const cancel = screen.getByTestId('form-modal-cancel')
    cancel.focus()
    fireEvent.keyDown(window, { key: 'Tab' })

    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }))
  })

  it('pulls focus back in when Tab is pressed from outside the dialog', () => {
    const outside = document.createElement('button')
    document.body.appendChild(outside)
    renderModal()
    outside.focus()

    fireEvent.keyDown(window, { key: 'Tab' })

    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }))
    outside.remove()
  })

  it('submits through the form when allowed', () => {
    const onSubmit = vi.fn()
    renderModal({ onSubmit })

    fireEvent.submit(screen.getByLabelText('First').closest('form')!)

    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it('does not submit while canSubmit is false, and its submit button is disabled', () => {
    const onSubmit = vi.fn()
    renderModal({ onSubmit, canSubmit: false })

    fireEvent.submit(screen.getByLabelText('First').closest('form')!)

    expect(onSubmit).not.toHaveBeenCalled()
    expect((screen.getByTestId('form-modal-submit') as HTMLButtonElement).disabled).toBe(true)
  })

  it('uses the given submit labels, idle and in flight', () => {
    const { rerender } = renderModal({ submitLabel: 'Add rule', submittingLabel: 'Adding…' })
    expect(screen.getByTestId('form-modal-submit').textContent).toBe('Add rule')

    rerender(
      <FormModal
        title="T"
        submitting={true}
        submitLabel="Add rule"
        submittingLabel="Adding…"
        generalError={null}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      >
        <input aria-label="x" />
      </FormModal>,
    )
    expect(screen.getByTestId('form-modal-submit').textContent).toBe('Adding…')
  })

  describe('in flight', () => {
    const renderInFlight = (onCancel = vi.fn(), onSubmit = vi.fn()) =>
      renderModal({ submitting: true, onCancel, onSubmit })

    it('disables the fields and both buttons and marks the submit button aria-busy', () => {
      renderInFlight()

      // Disabled by its fieldset, so the property stays false: ask the :disabled selector, as the browser does.
      expect(screen.getByLabelText('First').matches(':disabled')).toBe(true)
      expect((screen.getByTestId('form-modal-cancel') as HTMLButtonElement).disabled).toBe(true)
      const submit = screen.getByTestId('form-modal-submit') as HTMLButtonElement
      expect(submit.disabled).toBe(true)
      expect(submit.getAttribute('aria-busy')).toBe('true')
    })

    it('is not dismissible: Escape and the backdrop do nothing', () => {
      const onCancel = vi.fn()
      renderInFlight(onCancel)

      fireEvent.keyDown(window, { key: 'Escape' })
      fireEvent.click(screen.getByTestId('form-modal-backdrop'))

      expect(onCancel).not.toHaveBeenCalled()
    })

    it('does not submit a second time', () => {
      const onSubmit = vi.fn()
      renderInFlight(vi.fn(), onSubmit)

      fireEvent.submit(screen.getByLabelText('First').closest('form')!)

      expect(onSubmit).not.toHaveBeenCalled()
    })
  })

  it('shows a general error as an alert, and keeps the typed values', () => {
    renderModal({ generalError: 'We cannot verify your access right now.' })
    const input = screen.getByLabelText('First') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'typed' } })

    expect(screen.getByRole('alert').textContent).toBe('We cannot verify your access right now.')
    expect(input.value).toBe('typed')
  })

  it('renders no alert when there is no error', () => {
    renderModal()

    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('returns focus to the element that had it when the dialog opened, once it closes', () => {
    const trigger = document.createElement('button')
    document.body.appendChild(trigger)
    trigger.focus()

    const { unmount } = renderModal()
    expect(document.activeElement).toBe(screen.getByLabelText('First'))

    unmount()
    expect(document.activeElement).toBe(trigger)
    trigger.remove()
  })

  it('namespaces its test ids with testIdPrefix', () => {
    renderModal({ testIdPrefix: 'new-rule' })

    expect(screen.getByTestId('new-rule-backdrop')).not.toBeNull()
    expect(screen.getByTestId('new-rule-submit')).not.toBeNull()
    expect(screen.queryByTestId('form-modal-submit')).toBeNull()
  })
})
