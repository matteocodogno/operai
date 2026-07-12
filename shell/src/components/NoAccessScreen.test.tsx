/**
 * @vitest-environment jsdom
 *
 * Component tests for NoAccessScreen (specs/004-auth-roles-permissions, T25,
 * design.md Screen S1, AC-7.4): the required copy is present, and the
 * heading receives programmatic focus on mount (design.md Accessibility —
 * mirrors ShellLayout's skip-link-target technique).
 */

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import NoAccessScreen from './NoAccessScreen'

afterEach(() => cleanup())

describe('NoAccessScreen (Screen S1)', () => {
  it('renders the "No apps available yet" heading and explanatory copy', () => {
    render(<NoAccessScreen />)

    expect(screen.getByRole('heading', { name: 'No apps available yet' })).toBeDefined()
    expect(
      screen.getByText('Ask your administrator to grant you access to a tool.'),
    ).toBeDefined()
  })

  it('moves focus to the heading on mount so assistive tech announces it immediately', () => {
    render(<NoAccessScreen />)

    const heading = screen.getByRole('heading', { name: 'No apps available yet' })
    expect(document.activeElement).toBe(heading)
    // Focusable via script but not part of the normal tab order (a landmark,
    // not a control) — same contract as ShellLayout's skip-link target.
    expect(heading.getAttribute('tabIndex')).toBe('-1')
  })
})
