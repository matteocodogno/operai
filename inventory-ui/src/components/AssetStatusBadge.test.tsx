/**
 * @vitest-environment jsdom
 *
 * Component tests for AssetStatusBadge (T26, specs/015-hardware-inventory;
 * design.md § NEW components and § Accessibility "Badges and chips").
 *
 * Covers: six variants, each readable as text (the label is the accessible
 * name, the glyph is aria-hidden); six DIFFERENT glyphs, so no state is carried
 * by colour alone; every variant carries its status in a data attribute for
 * tests/e2e; an unknown wire value from a newer server degrades to the raw text
 * rather than throwing.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import AssetStatusBadge from './AssetStatusBadge'
import type { AssetStatus } from '../lib/types'

afterEach(() => {
  cleanup()
})

const VARIANTS = [
  ['ordered', 'Ordered', '⇢'],
  ['in_stock', 'In stock', '◆'],
  ['assigned', 'Assigned', '●'],
  ['in_repair', 'In repair', '⚙'],
  ['lost', 'Lost', '⚠'],
  ['disposed', 'Disposed', '⌀'],
] as const satisfies readonly (readonly [AssetStatus, string, string])[]

/** What a screen reader reads: the badge's text with every aria-hidden subtree removed. */
const accessibleText = (badge: HTMLElement): string => {
  const clone = badge.cloneNode(true) as HTMLElement
  clone.querySelectorAll('[aria-hidden="true"]').forEach((node) => node.remove())
  return (clone.textContent ?? '').trim()
}

describe('AssetStatusBadge', () => {
  it.each(VARIANTS)('renders %s with the accessible name "%s"', (status, label) => {
    render(<AssetStatusBadge status={status} />)

    const badge = screen.getByTestId('asset-status-badge')
    expect(accessibleText(badge)).toBe(label)
    expect(badge.getAttribute('data-status')).toBe(status)
  })

  it.each(VARIANTS)('%s shows its glyph, aria-hidden, beside the text', (status, label, glyph) => {
    render(<AssetStatusBadge status={status} />)

    const badge = screen.getByTestId('asset-status-badge')
    const glyphSpan = badge.querySelector('[aria-hidden="true"]')
    expect(glyphSpan?.textContent).toBe(glyph)
    expect(badge.textContent).toBe(`${glyph}${label}`)
  })

  it('uses six different glyphs and six different labels (no state is colour-only)', () => {
    const glyphs = new Set<string>()
    const labels = new Set<string>()
    for (const [status] of VARIANTS) {
      const { container } = render(<AssetStatusBadge status={status} />)
      const badge = container.querySelector('[data-testid="asset-status-badge"]') as HTMLElement
      glyphs.add(badge.querySelector('[aria-hidden="true"]')?.textContent ?? '')
      labels.add(accessibleText(badge))
      cleanup()
    }

    expect(glyphs.size).toBe(6)
    expect(labels.size).toBe(6)
  })

  it('prints the label in the normal text colour (WCAG 1.4.3), never in the status colour', () => {
    for (const [status] of VARIANTS) {
      const { container } = render(<AssetStatusBadge status={status} />)
      const badge = container.querySelector('[data-testid="asset-status-badge"]') as HTMLElement
      expect(badge.style.color).toBe('var(--text)')
      cleanup()
    }
  })

  it('keeps the status colour for the glyph, the border and the tint, all from theme tokens, never a hex literal', () => {
    for (const [status] of VARIANTS) {
      const { container } = render(<AssetStatusBadge status={status} />)
      const badge = container.querySelector('[data-testid="asset-status-badge"]') as HTMLElement
      const glyph = badge.querySelector('[aria-hidden="true"]') as HTMLElement
      const token = glyph.style.color
      expect(token).toMatch(/^var\(--[a-z]+\)$/)
      expect(token).not.toBe('var(--text)')
      expect(badge.style.borderColor).toBe(token)
      expect(badge.getAttribute('style')).toContain(`color-mix(in srgb, ${token} 10%`)
      expect(badge.getAttribute('style')).not.toMatch(/#[0-9a-f]{3,8}/i)
      cleanup()
    }
  })

  it('does not throw on a status a newer server adds: it shows the raw value, without a glyph', () => {
    render(<AssetStatusBadge status={'quarantined' as AssetStatus} />)

    const badge = screen.getByTestId('asset-status-badge')
    expect(badge.textContent).toBe('quarantined')
    expect(badge.querySelector('[aria-hidden="true"]')).toBeNull()
  })
})
