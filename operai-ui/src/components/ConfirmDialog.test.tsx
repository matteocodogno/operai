import axe from 'axe-core'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ConfirmDialog } from './ConfirmDialog'
import type { ConfirmDialogProps } from './ConfirmDialog'

afterEach(cleanup)

const base = {
  title: 'Save these changes to WellD CH?',
  confirmLabel: 'Save as version 4',
  busyLabel: 'Saving…',
  cancelLabel: 'Cancel',
  closeLabel: 'Close',
  busy: false,
  error: null,
} as const

const props = (over: Partial<ConfirmDialogProps> = {}) => ({
  ...base,
  onConfirm: vi.fn(),
  onCancel: vi.fn(),
  ...over,
})

const confirmButton = () => screen.getByTestId('confirm-dialog-confirm')

/** The declarations of the first rule whose selector is exactly `selector`, in tokens.css. */
function rule(selector: string): string {
  const css = readFileSync(resolve(process.cwd(), 'src/styles/tokens.css'), 'utf8')
  const escaped = selector.replace(/[.>[\]()*+?^$|\\]/g, '\\$&').replace(/ /g, '\\s+')
  const match = new RegExp(`(?:^|[},/\\s])${escaped}\\s*\\{([^}]*)\\}`, 'm').exec(css)
  if (!match) throw new Error(`no rule for ${selector} in tokens.css`)
  return match[1].replace(/\s+/g, ' ').trim()
}

describe('ConfirmDialog — scrollBody (opt-in)', () => {
  const LONG = [
    'A very long legal name '.repeat(6),
    'CHE-123.456.789 MWST CHE-123.456.789 MWST CHE-123.456.789 MWST',
    'CH93 0076 2011 6238 5295 7 '.repeat(5),
  ]
  const longBody = (
    <>
      <p>Check the new values.</p>
      <ul>
        {LONG.map((text) => (
          <li key={text}>{text}</li>
        ))}
      </ul>
    </>
  )

  it('puts the whole body in a scrolling region and the footer outside it, in the dialog column', () => {
    render(<ConfirmDialog {...props({ scrollBody: true })}>{longBody}</ConfirmDialog>)
    const dialog = screen.getByRole('alertdialog')
    const scroll = screen.getByTestId('confirm-dialog-scroll')
    expect(dialog).toHaveClass('dialog', 'dialog-scroll')
    expect(scroll).toHaveClass('dialog-scroll-body')
    for (const text of LONG) expect(scroll).toHaveTextContent(text.trim())
    // The buttons are NOT inside what scrolls, so a long body cannot push them away.
    const footer = confirmButton().closest('.dialog-footer')
    expect(footer).not.toBeNull()
    expect(scroll.contains(footer)).toBe(false)
    expect(footer?.contains(screen.getByTestId('confirm-dialog-cancel'))).toBe(true)
    // The inline error stays above the footer, out of the scroll as well.
    cleanup()
    render(<ConfirmDialog {...props({ scrollBody: true, error: 'Could not save.' })}>{longBody}</ConfirmDialog>)
    expect(screen.getByTestId('confirm-dialog-scroll').contains(screen.getByRole('alert'))).toBe(false)
  })

  it('keeps the description, the focus and the keyboard of a ConfirmDialog', async () => {
    const user = userEvent.setup()
    const onCancel = vi.fn()
    render(<ConfirmDialog {...props({ scrollBody: true, onCancel })}>{longBody}</ConfirmDialog>)
    const dialog = screen.getByRole('alertdialog')
    expect(dialog).toHaveAccessibleDescription(/Check the new values\..*CH93 0076/)
    expect(screen.getByTestId('confirm-dialog-cancel')).toHaveFocus()
    await user.keyboard('{Escape}')
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('the scrolling region is a keyboard stop, so a body without a control can still be scrolled', async () => {
    const user = userEvent.setup()
    render(<ConfirmDialog {...props({ scrollBody: true })}>{longBody}</ConfirmDialog>)
    // Cancel has the focus on open; the region comes just before it in the tab order.
    await user.tab({ shift: true })
    expect(screen.getByTestId('confirm-dialog-scroll')).toHaveFocus()
    await user.tab()
    expect(screen.getByTestId('confirm-dialog-cancel')).toHaveFocus()
  })

  it('has the CSS that keeps the footer in view at 320 px: capped at the viewport, a column, the body scrolls, the footer does not shrink', () => {
    const scrolling = rule('.dialog-scroll')
    expect(scrolling).toContain('display: flex')
    expect(scrolling).toContain('flex-direction: column')
    expect(scrolling).toMatch(/max-height: calc\(100dvh - 32px\)/)
    // The `vh` fallback comes first, for a browser that does not know `dvh`.
    expect(scrolling.indexOf('100vh')).toBeLessThan(scrolling.indexOf('100dvh'))
    const body = rule('.dialog-scroll-body')
    expect(body).toContain('overflow-y: auto')
    expect(body).toContain('min-height: 0')
    expect(rule('.dialog-scroll .dialog-footer')).toContain('flex-shrink: 0')
    expect(rule('.dialog-scroll > form')).toContain('min-height: 0')
    expect(rule('.dialog-scroll > form')).toContain('flex-direction: column')
  })

  it('does not exist for a dialog that does not ask for it: the same markup and classes as before', () => {
    render(<ConfirmDialog {...props()}>{longBody}</ConfirmDialog>)
    const dialog = screen.getByRole('alertdialog')
    expect(dialog.className).toBe('dialog dialog-sm')
    expect(screen.queryByTestId('confirm-dialog-scroll')).toBeNull()
    expect(dialog.querySelector('.dialog-scroll-body')).toBeNull()
    expect(dialog.querySelector('form')?.firstElementChild).toHaveClass('dialog-body')
  })

  it('has no axe violations', async () => {
    const { container } = render(<ConfirmDialog {...props({ scrollBody: true })}>{longBody}</ConfirmDialog>)
    const { violations } = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })
    expect(violations.map((v) => v.id)).toEqual([])
  })
})

describe('ConfirmDialog — size (opt-in)', () => {
  it.each([
    [undefined, 'dialog dialog-sm'],
    ['wide', 'dialog dialog-wide'],
    ['lg', 'dialog dialog-lg'],
  ] as const)('size %s renders %s', (size, classes) => {
    render(<ConfirmDialog {...props({ size })}>Body</ConfirmDialog>)
    expect(screen.getByRole('alertdialog').className).toBe(classes)
  })

  it('is 520 px at the wide size, still shrinking to the viewport (the dialog is width: 100%)', () => {
    expect(rule('.dialog-wide')).toBe('max-width: 32.5rem;')
    expect(rule('.dialog')).toContain('width: 100%')
  })

  it('fields still make it md when no size is given', () => {
    render(<ConfirmDialog {...props({ fields: <input aria-label="Reason" /> })}>Body</ConfirmDialog>)
    expect(screen.getByRole('alertdialog').className).toBe('dialog')
  })
})

describe('ConfirmDialog — confirmDisabledReason (opt-in)', () => {
  const REASON = 'Loading the details of version 3…'

  it('makes Confirm aria-disabled and described by the reason, and leaves it a focus stop', async () => {
    const user = userEvent.setup()
    render(<ConfirmDialog {...props({ confirmDisabledReason: REASON })}>Body</ConfirmDialog>)
    const confirm = confirmButton()
    expect(confirm).toHaveAttribute('aria-disabled', 'true')
    expect(confirm).not.toBeDisabled()
    expect(confirm).toHaveAccessibleDescription(REASON)
    expect(screen.getByTestId('confirm-dialog-confirm-reason')).toHaveClass('sr-only')
    await user.tab()
    expect(confirm).toHaveFocus()
  })

  it('does nothing on a click, on Enter and on a form submit, but Cancel, Escape and × still work', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    render(
      <ConfirmDialog
        {...props({ confirmDisabledReason: REASON, onConfirm, onCancel, fields: <input aria-label="Reason" /> })}
      >
        Body
      </ConfirmDialog>,
    )
    await user.click(confirmButton())
    confirmButton().focus()
    await user.keyboard('{Enter}')
    await user.type(screen.getByLabelText('Reason'), 'x{Enter}')
    expect(onConfirm).not.toHaveBeenCalled()

    expect(screen.getByTestId('confirm-dialog-cancel')).toBeEnabled()
    await user.click(screen.getByTestId('confirm-dialog-cancel'))
    await user.click(screen.getByTestId('confirm-dialog-close'))
    await user.keyboard('{Escape}')
    expect(onCancel).toHaveBeenCalledTimes(3)
  })

  it('confirms again when the reason goes away, and is not described by anything then', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()
    const { rerender } = render(
      <ConfirmDialog {...props({ confirmDisabledReason: REASON, onConfirm })}>Body</ConfirmDialog>,
    )
    rerender(<ConfirmDialog {...props({ confirmDisabledReason: undefined, onConfirm })}>Body</ConfirmDialog>)
    const confirm = confirmButton()
    expect(confirm).not.toHaveAttribute('aria-disabled')
    expect(confirm).not.toHaveAttribute('aria-describedby')
    expect(screen.queryByTestId('confirm-dialog-confirm-reason')).toBeNull()
    await user.click(confirm)
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('an empty reason is no reason', () => {
    render(<ConfirmDialog {...props({ confirmDisabledReason: '' })}>Body</ConfirmDialog>)
    expect(confirmButton()).not.toHaveAttribute('aria-disabled')
    expect(confirmButton()).toBeEnabled()
  })

  it('busy wins: Confirm is natively disabled and busy, Cancel disabled, as always', () => {
    render(<ConfirmDialog {...props({ confirmDisabledReason: REASON, busy: true })}>Body</ConfirmDialog>)
    expect(confirmButton()).toBeDisabled()
    expect(confirmButton()).toHaveAttribute('aria-busy', 'true')
    expect(confirmButton()).not.toHaveAttribute('aria-disabled')
    expect(screen.getByTestId('confirm-dialog-cancel')).toBeDisabled()
  })

  it('an unticked acknowledgement still keeps Confirm disabled, with or without a reason; with both, a tick does not lift the reason', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()
    render(
      <ConfirmDialog {...props({ acknowledgeLabel: 'I understand.', confirmDisabledReason: REASON, onConfirm })}>
        Body
      </ConfirmDialog>,
    )
    await user.click(screen.getByLabelText('I understand.'))
    await user.click(confirmButton())
    expect(onConfirm).not.toHaveBeenCalled()
    expect(confirmButton()).toHaveAttribute('aria-disabled', 'true')
  })

  it('without the prop nothing changes: an enabled Confirm confirms, with no aria-disabled or description', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()
    render(<ConfirmDialog {...props({ onConfirm })}>Body</ConfirmDialog>)
    expect(confirmButton()).not.toHaveAttribute('aria-disabled')
    expect(confirmButton()).not.toHaveAttribute('aria-describedby')
    await user.click(confirmButton())
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('has no axe violations, with the reason and with scrollBody and wide', async () => {
    const { container } = render(
      <ConfirmDialog {...props({ confirmDisabledReason: REASON, scrollBody: true, size: 'wide' })}>Body</ConfirmDialog>,
    )
    const { violations } = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })
    expect(violations.map((v) => v.id)).toEqual([])
  })
})
