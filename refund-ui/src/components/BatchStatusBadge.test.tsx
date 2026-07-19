/**
 * @vitest-environment jsdom
 *
 * Component tests for BatchStatusBadge (T10, specs/008-refund-monthly-
 * processing/tasks.md). Covers: all three variants render a glyph AND a
 * text label (never color-only), and `paid` is distinguishable from
 * `compiled`/`discarded` by a non-color signal.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import BatchStatusBadge from './BatchStatusBadge'

afterEach(() => {
  cleanup()
})

describe('BatchStatusBadge', () => {
  it.each([
    ['compiled', 'Compiled', '▤'],
    ['paid', 'Paid', '◆'],
    ['discarded', 'Discarded', '✕'],
  ] as const)('renders the %s variant with its glyph and label', (status, label, glyph) => {
    render(<BatchStatusBadge status={status} />)

    const badge = screen.getByTestId('batch-status-badge')
    expect(badge.textContent).toBe(`${glyph}${label}`)
  })

  it('the glyph is aria-hidden (label text alone carries the accessible name)', () => {
    render(<BatchStatusBadge status="compiled" />)

    const badge = screen.getByTestId('batch-status-badge')
    const glyphSpan = badge.querySelector('[aria-hidden="true"]')
    expect(glyphSpan?.textContent).toBe('▤')
  })

  it('uses a distinct color per variant', () => {
    const colors = (['compiled', 'paid', 'discarded'] as const).map((status) => {
      const { container } = render(<BatchStatusBadge status={status} />)
      const badge = container.querySelector('[data-testid="batch-status-badge"]') as HTMLElement
      const color = badge.style.color
      cleanup()
      return color
    })

    expect(new Set(colors).size).toBe(3)
  })

  it('each variant carries its own glyph, never relying on color alone to disambiguate', () => {
    const glyphs = (['compiled', 'paid', 'discarded'] as const).map((status) => {
      const { container } = render(<BatchStatusBadge status={status} />)
      const glyph = container.querySelector('[aria-hidden="true"]')?.textContent
      cleanup()
      return glyph
    })

    expect(new Set(glyphs).size).toBe(3)
  })
})
