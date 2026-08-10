/**
 * @vitest-environment jsdom
 *
 * Tests for WarningBadge — the health-warning icon with an explanatory tooltip.
 *
 * The warnings used to render as a bare icon with only a native `title`
 * (short label, no reason, easy to miss). WarningBadge now shows the title AND
 * the reason on hover/focus, and always exposes both to assistive tech via
 * aria-label — so users no longer need to open the Shift+H modal to understand
 * a warning.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import WarningBadge from './WarningBadge'
import { WARNING_META } from '../lib/healthWarnings'

afterEach(() => cleanup())

describe('WarningBadge', () => {
  it('exposes the title and reason to assistive tech via aria-label', () => {
    render(<WarningBadge code="high-risk" />)
    const icon = screen.getByRole('img')
    expect(icon.getAttribute('aria-label')).toContain(WARNING_META['high-risk'].title)
    expect(icon.getAttribute('aria-label')).toContain(WARNING_META['high-risk'].description)
  })

  it('shows a tooltip with the explanation on hover and hides it on leave', () => {
    render(<WarningBadge code="no-profile" />)
    const icon = screen.getByRole('img')

    // No tooltip until interaction.
    expect(screen.queryByRole('tooltip')).toBeNull()

    fireEvent.mouseEnter(icon)
    const tip = screen.getByRole('tooltip')
    expect(tip.textContent).toContain(WARNING_META['no-profile'].title)
    expect(tip.textContent).toContain(WARNING_META['no-profile'].description)

    fireEvent.mouseLeave(icon)
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('shows the tooltip on keyboard focus and hides it on blur (a11y)', () => {
    render(<WarningBadge code="wide-range" />)
    const icon = screen.getByRole('img')

    fireEvent.focus(icon)
    expect(screen.getByRole('tooltip').textContent).toContain(WARNING_META['wide-range'].description)

    fireEvent.blur(icon)
    expect(screen.queryByRole('tooltip')).toBeNull()
  })
})
