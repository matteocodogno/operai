/**
 * @vitest-environment jsdom
 *
 * Component tests for RequestStatusBadge (T15, specs/007-refund-service,
 * design.md F3 step 2 / AC-3.4).
 *
 * Covers: all four variants render a glyph AND a text label (never
 * color-only), with visually distinct colors, and `submitted` reads
 * "Awaiting decision" — never confusable with approved/rejected (AC-3.4).
 */

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import RequestStatusBadge from './RequestStatusBadge'

afterEach(() => {
  cleanup()
})

describe('RequestStatusBadge', () => {
  it.each([
    ['draft', 'Draft', '✎'],
    ['submitted', 'Awaiting decision', '⏳'],
    ['approved', 'Approved', '✓'],
    ['rejected', 'Rejected', '✕'],
  ] as const)('renders the %s variant with its glyph and label', (status, label, glyph) => {
    render(<RequestStatusBadge status={status} />)

    const badge = screen.getByTestId('request-status-badge')
    expect(badge.textContent).toBe(`${glyph}${label}`)
  })

  it('never labels "submitted" as approved or rejected (AC-3.4)', () => {
    render(<RequestStatusBadge status="submitted" />)

    const badge = screen.getByTestId('request-status-badge')
    expect(badge.textContent).toBe('⏳Awaiting decision')
    expect(badge.textContent?.toLowerCase()).not.toContain('approved')
    expect(badge.textContent?.toLowerCase()).not.toContain('rejected')
  })

  it('the glyph is aria-hidden (label text alone carries the accessible name)', () => {
    render(<RequestStatusBadge status="approved" />)

    const badge = screen.getByTestId('request-status-badge')
    const glyphSpan = badge.querySelector('[aria-hidden="true"]')
    expect(glyphSpan?.textContent).toBe('✓')
  })

  it('uses a different color per variant (never color-only, but distinct anyway)', () => {
    const colors = (['draft', 'submitted', 'approved', 'rejected'] as const).map((status) => {
      const { container } = render(<RequestStatusBadge status={status} />)
      const badge = container.querySelector('[data-testid="request-status-badge"]') as HTMLElement
      const color = badge.style.color
      cleanup()
      return color
    })

    expect(new Set(colors).size).toBe(4)
  })
})
