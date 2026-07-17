/**
 * @vitest-environment jsdom
 *
 * Component tests for EntityBadge (T15, specs/007-refund-service, design.md
 * Component inventory: "EntityBadge (WellD Italia·EUR / WellD CH·CHF chip)").
 *
 * Post-close change (specs/007): currency is now a separately-stored,
 * independently-selectable line field, no longer derived from entity — this
 * badge shows the entity ONLY (see `EntityBadge.tsx`'s doc comment and
 * `CurrencyBadge.test.tsx` for the currency chip's own coverage).
 *
 * Covers: both variants render a glyph AND a text label naming the entity,
 * never color-only.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import EntityBadge from './EntityBadge'

afterEach(() => {
  cleanup()
})

describe('EntityBadge', () => {
  it.each([
    ['welld_it', 'WellD Italia', '🇮🇹'],
    ['welld_ch', 'WellD CH', '🇨🇭'],
  ] as const)('renders the %s variant with its glyph and entity-name label, no currency', (entity, label, glyph) => {
    render(<EntityBadge entity={entity} />)

    const badge = screen.getByTestId('entity-badge')
    expect(badge.textContent).toBe(`${glyph}${label}`)
    expect(badge.textContent).not.toMatch(/EUR|CHF|USD|GBP/)
  })

  it('the glyph is aria-hidden (label text alone carries the accessible name)', () => {
    render(<EntityBadge entity="welld_ch" />)

    const badge = screen.getByTestId('entity-badge')
    const glyphSpan = badge.querySelector('[aria-hidden="true"]')
    expect(glyphSpan?.textContent).toBe('🇨🇭')
  })

  it('uses a different color per variant (never color-only, but distinct anyway)', () => {
    const colors = (['welld_it', 'welld_ch'] as const).map((entity) => {
      const { container } = render(<EntityBadge entity={entity} />)
      const badge = container.querySelector('[data-testid="entity-badge"]') as HTMLElement
      const color = badge.style.color
      cleanup()
      return color
    })

    expect(new Set(colors).size).toBe(2)
  })
})
