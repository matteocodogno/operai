/**
 * @vitest-environment jsdom
 *
 * Component tests for InvitationStatusBadge (T12, specs/006-user-invitations).
 *
 * Covers: all four variants render a glyph AND a text label (never
 * color-only), with visually distinct colors.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import InvitationStatusBadge from './InvitationStatusBadge'

afterEach(() => {
  cleanup()
})

describe('InvitationStatusBadge', () => {
  it.each([
    ['pending', 'Pending', '⏳'],
    ['accepted', 'Accepted', '✓'],
    ['expired', 'Expired', '⌛'],
    ['revoked', 'Revoked', '⊘'],
  ] as const)('renders the %s variant with its glyph and label', (status, label, glyph) => {
    render(<InvitationStatusBadge status={status} />)

    const badge = screen.getByTestId('invitation-status-badge')
    expect(badge.textContent).toBe(`${glyph}${label}`)
  })

  it('uses a different color per variant (never color-only, but distinct anyway)', () => {
    const colors = (['pending', 'accepted', 'expired', 'revoked'] as const).map((status) => {
      const { container } = render(<InvitationStatusBadge status={status} />)
      const badge = container.querySelector('[data-testid="invitation-status-badge"]') as HTMLElement
      const color = badge.style.color
      cleanup()
      return color
    })

    expect(new Set(colors).size).toBe(4)
  })
})
