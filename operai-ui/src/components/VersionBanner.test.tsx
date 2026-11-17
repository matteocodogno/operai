import { afterEach, describe, expect, it, vi } from 'vitest'
import axe from 'axe-core'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Badge } from './Badge'
import { VersionBanner } from './VersionBanner'
import type { VersionBannerProps } from './VersionBanner'

afterEach(cleanup)

function view(props: Partial<VersionBannerProps> = {}) {
  const onBack = vi.fn()
  const onRestore = vi.fn()
  const utils = render(
    <VersionBanner
      title="Viewing version 2 (read-only)"
      backLabel="Back to history"
      onBack={onBack}
      restoreLabel="Restore this version"
      onRestore={onRestore}
      {...props}
    >
      Saved by Ada Rossi on 16.11.2026 10:30. The current version is 3.
    </VersionBanner>,
  )
  return { ...utils, onBack, onRestore }
}

describe('VersionBanner', () => {
  it('moves focus to its heading on mount, at the level asked', () => {
    view({ headingLevel: 4 })
    const heading = screen.getByRole('heading', { level: 4, name: 'Viewing version 2 (read-only)' })
    expect(heading).toHaveFocus()
    expect(heading).toHaveAttribute('tabindex', '-1')
  })

  it('defaults to level 3 and is a static note, not a live region', () => {
    view({ testId: 'vb' })
    expect(screen.getByRole('heading', { level: 3 })).toBeInTheDocument()
    const banner = screen.getByTestId('vb')
    expect(banner).toHaveAttribute('role', 'note')
    expect(banner).not.toHaveAttribute('aria-live')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByTestId('vb-heading')).toHaveFocus()
  })

  it('shows the message and the badge', () => {
    view({ badge: <Badge tone="warning">Not current</Badge> })
    expect(screen.getByText(/Saved by Ada Rossi/)).toBeInTheDocument()
    expect(screen.getByText('Not current')).toBeInTheDocument()
  })

  it('calls onBack and onRestore, and Restore announces a dialog', async () => {
    const { onBack, onRestore } = view()
    const restore = screen.getByRole('button', { name: 'Restore this version' })
    expect(restore).toHaveAttribute('aria-haspopup', 'dialog')
    await userEvent.click(screen.getByRole('button', { name: 'Back to history' }))
    await userEvent.click(restore)
    expect(onBack).toHaveBeenCalledTimes(1)
    expect(onRestore).toHaveBeenCalledTimes(1)
  })

  it('offers no Restore without a restoreLabel and onRestore', () => {
    view({ restoreLabel: undefined })
    expect(screen.queryByRole('button', { name: /Restore/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'Back to history' })).toBeInTheDocument()
  })

  it('keeps a blocked Restore focusable, aria-disabled, described by its reason, and inert', async () => {
    const { onRestore } = view({ restoreBlockedReason: 'This version cannot be restored: the IBAN is missing.' })
    const restore = screen.getByRole('button', { name: 'Restore this version' })
    expect(restore).toHaveAttribute('aria-disabled', 'true')
    expect(restore).not.toBeDisabled()
    expect(restore).not.toHaveAttribute('aria-haspopup')
    expect(restore).toHaveAccessibleDescription('This version cannot be restored: the IBAN is missing.')
    restore.focus()
    expect(restore).toHaveFocus()
    await userEvent.click(restore)
    await userEvent.keyboard('{Enter}')
    expect(onRestore).not.toHaveBeenCalled()
  })

  it('takes focus again when it is remounted for another version', () => {
    const { rerender } = view()
    screen.getByRole('button', { name: 'Back to history' }).focus()
    rerender(
      <VersionBanner key="3" title="Viewing version 1 (read-only)" backLabel="Back" onBack={vi.fn()}>
        x
      </VersionBanner>,
    )
    expect(screen.getByRole('heading', { name: 'Viewing version 1 (read-only)' })).toHaveFocus()
  })

  it.each([
    ['restorable', {}],
    ['blocked', { restoreBlockedReason: 'This version cannot be restored.' }],
    ['read-only', { restoreLabel: undefined }],
  ])('has no axe violations (%s)', async (_name, props) => {
    const { container } = view({ ...props, badge: <Badge tone="warning">Not current</Badge> })
    const { violations } = await axe.run(container)
    expect(violations.map((v) => `${v.id}: ${v.help}`)).toEqual([])
  })
})
