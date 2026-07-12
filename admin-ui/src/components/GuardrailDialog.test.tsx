/**
 * @vitest-environment jsdom
 *
 * Component tests for GuardrailDialog (T15, specs/004-auth-roles-permissions,
 * design.md Dialog D2).
 *
 * Covers:
 *   (A) role="alertdialog" labelled/described by title/message; renders no
 *       destructive action (only one button, "OK" by default).
 *   (B) default focus lands on the "OK" button.
 *   (C) Escape acknowledges (same effect as clicking OK).
 *   (D) focus trap: Tab keeps focus pinned on the single "OK" button.
 *   (E) backdrop click acknowledges too; clicking inside the dialog does not.
 *   (F) acknowledgeLabel override renders custom button text.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import GuardrailDialog from './GuardrailDialog'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const baseProps = {
  title: "Can't remove the last administrator",
  message:
    'This is the last administrator — removing this role would leave nobody able to manage access. Assign another admin first.',
  onAcknowledge: vi.fn(),
}

describe('GuardrailDialog', () => {
  it('renders as an alertdialog labelled/described by title and message, with a single OK action', () => {
    render(<GuardrailDialog {...baseProps} />)

    const dialog = screen.getByRole('alertdialog')
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(dialog.getAttribute('aria-labelledby')).toBe('guardrail-dialog-title')
    expect(dialog.getAttribute('aria-describedby')).toBe('guardrail-dialog-message')
    expect(screen.getByText(baseProps.title)).not.toBeNull()
    expect(screen.getByText(baseProps.message)).not.toBeNull()
    // No destructive/"proceed anyway" affordance — only one button.
    expect(screen.getAllByRole('button')).toHaveLength(1)
    expect(screen.getByTestId('guardrail-dialog-ok').textContent).toBe('OK')
  })

  it('focuses the OK button by default', () => {
    render(<GuardrailDialog {...baseProps} />)

    expect(document.activeElement).toBe(screen.getByTestId('guardrail-dialog-ok'))
  })

  it('Escape acknowledges', () => {
    const onAcknowledge = vi.fn()
    render(<GuardrailDialog {...baseProps} onAcknowledge={onAcknowledge} />)

    fireEvent.keyDown(window, { key: 'Escape' })

    expect(onAcknowledge).toHaveBeenCalledTimes(1)
  })

  it('traps Tab focus on the single OK button', () => {
    render(<GuardrailDialog {...baseProps} />)

    const okBtn = screen.getByTestId('guardrail-dialog-ok')
    expect(document.activeElement).toBe(okBtn)

    fireEvent.keyDown(window, { key: 'Tab' })

    expect(document.activeElement).toBe(okBtn)
  })

  it('clicking the backdrop acknowledges', () => {
    const onAcknowledge = vi.fn()
    render(<GuardrailDialog {...baseProps} onAcknowledge={onAcknowledge} />)

    fireEvent.click(screen.getByTestId('guardrail-dialog'))

    expect(onAcknowledge).toHaveBeenCalledTimes(1)
  })

  it('clicking inside the dialog body does not acknowledge (event does not bubble to the backdrop)', () => {
    const onAcknowledge = vi.fn()
    render(<GuardrailDialog {...baseProps} onAcknowledge={onAcknowledge} />)

    fireEvent.click(screen.getByText(baseProps.message))

    expect(onAcknowledge).not.toHaveBeenCalled()
  })

  it('clicking OK acknowledges', () => {
    const onAcknowledge = vi.fn()
    render(<GuardrailDialog {...baseProps} onAcknowledge={onAcknowledge} />)

    fireEvent.click(screen.getByTestId('guardrail-dialog-ok'))

    expect(onAcknowledge).toHaveBeenCalledTimes(1)
  })

  it('supports a custom acknowledge label', () => {
    render(<GuardrailDialog {...baseProps} acknowledgeLabel="Got it" />)

    expect(screen.getByTestId('guardrail-dialog-ok').textContent).toBe('Got it')
  })
})
