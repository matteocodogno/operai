/**
 * @vitest-environment jsdom
 *
 * Component tests for PermissionDenied (T22, specs/004-auth-roles-permissions,
 * design.md Screen E1).
 *
 * Covers:
 *   (A) renders as role="alert" with the heading + body copy.
 *   (B) heading receives focus on mount.
 *   (C) no Retry (or any other) control is rendered — a 403 is not
 *       recoverable by retrying.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import PermissionDenied from './PermissionDenied'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('PermissionDenied', () => {
  it('renders as role="alert" with the heading and body copy', () => {
    render(<PermissionDenied />)

    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('You no longer have admin access.')
    expect(alert.textContent).toContain('If this is unexpected, contact your administrator.')
  })

  it('moves focus to the heading on mount', () => {
    render(<PermissionDenied />)

    const heading = screen.getByTestId('permission-denied-heading')
    expect(document.activeElement).toBe(heading)
    expect(heading.getAttribute('tabindex')).toBe('-1')
  })

  it('renders no controls at all — in particular, no Retry button', () => {
    render(<PermissionDenied />)

    expect(screen.queryAllByRole('button')).toHaveLength(0)
    expect(screen.queryByText(/retry/i)).toBeNull()
  })

  // T11 (specs/009-mileage-rate) — the `message` prop, added for the Mileage
  // Rates screen's first section-level 403 (design.md "Gaps").
  it('renders the default body copy when no message prop is given', () => {
    render(<PermissionDenied />)

    expect(screen.getByRole('alert').textContent).toContain('If this is unexpected, contact your administrator.')
  })

  it('renders a caller-provided message instead of the generic copy', () => {
    render(<PermissionDenied message="You don't have permission to manage mileage rates." />)

    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain("You don't have permission to manage mileage rates.")
    expect(alert.textContent).not.toContain('If this is unexpected, contact your administrator.')
    // The heading stays the same regardless of the message override.
    expect(alert.textContent).toContain('You no longer have admin access.')
  })
})
