/**
 * @vitest-environment jsdom
 *
 * Tests for AboutModal — shows the app info (name, description), the author
 * (linked), and the version, and closes on Escape / backdrop.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import AboutModal from './AboutModal'
import { APP_NAME, APP_AUTHOR, APP_AUTHOR_URL, APP_VERSION } from '../lib/appInfo'

afterEach(() => cleanup())

describe('AboutModal', () => {
  it('renders the app name, version, and a linked author', () => {
    render(<AboutModal onClose={() => {}} />)
    const dialog = screen.getByRole('dialog', { name: `About ${APP_NAME}` })
    expect(dialog.textContent).toContain(APP_NAME)
    expect(dialog.textContent).toContain(APP_VERSION)

    const authorLink = screen.getByRole('link', { name: APP_AUTHOR }) as HTMLAnchorElement
    expect(authorLink.href).toContain(APP_AUTHOR_URL)
  })

  it('calls onClose when Escape is pressed', () => {
    const onClose = vi.fn()
    render(<AboutModal onClose={onClose} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('calls onClose when the backdrop is clicked but not the panel', () => {
    const onClose = vi.fn()
    render(<AboutModal onClose={onClose} />)

    // Clicking the dialog panel does NOT close.
    fireEvent.click(screen.getByRole('dialog'))
    expect(onClose).not.toHaveBeenCalled()

    // Clicking the close button does.
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
