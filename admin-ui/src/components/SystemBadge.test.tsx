/**
 * @vitest-environment jsdom
 *
 * Component tests for SystemBadge (T15, specs/004-auth-roles-permissions).
 *
 * Covers:
 *   (A) renders both a glyph (aria-hidden, decorative) and the text "System"
 *       — colour is never the only signal.
 *   (B) carries an explanatory title matching the disabled-Delete-button
 *       tooltip copy design.md pairs it with.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import SystemBadge from './SystemBadge'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('SystemBadge', () => {
  it('renders a decorative glyph plus the "System" text', () => {
    render(<SystemBadge />)

    const badge = screen.getByTestId('system-badge')
    expect(badge.textContent).toContain('System')

    const glyph = badge.querySelector('[aria-hidden="true"]')
    expect(glyph).not.toBeNull();
    expect(glyph!.textContent).not.toBe('')
  })

  it('carries an explanatory title', () => {
    render(<SystemBadge />)

    expect(screen.getByTestId('system-badge').getAttribute('title')).toBe(
      "System roles can't be deleted",
    )
  })
})
