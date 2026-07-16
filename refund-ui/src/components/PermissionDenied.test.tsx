/**
 * @vitest-environment jsdom
 *
 * Component tests for PermissionDenied (T15, specs/007-refund-service,
 * design.md Screen R1/A1 "PD").
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
    expect(alert.textContent).toContain('You no longer have refund access.')
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
})
