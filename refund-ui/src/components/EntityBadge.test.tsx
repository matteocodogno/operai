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

  // This used to assert TWO distinct colours. An entity is neutral metadata —
  // it is not good, not actionable, just true — so one shared neutral is the
  // point now, and the flag glyph plus entity name tell the variants apart
  // (ConditionChip's precedent: several kinds, one colour).
  it('renders both variants in the same neutral colour', () => {
    const colors = (['welld_it', 'welld_ch'] as const).map((entity) => {
      const { container } = render(<EntityBadge entity={entity} />)
      const badge = container.querySelector('[data-testid="entity-badge"]') as HTMLElement
      const color = badge.style.color
      cleanup()
      return color
    })

    expect(new Set(colors).size).toBe(1)
  })

  // The reason for the change: green MEANS "approved" on these screens, and a
  // WellD CH chip sat on the same row as a green approved figure carrying
  // none of that meaning.
  it('never uses the semantic approved/accent colours', () => {
    for (const entity of ['welld_it', 'welld_ch'] as const) {
      const { container } = render(<EntityBadge entity={entity} />)
      const badge = container.querySelector('[data-testid="entity-badge"]') as HTMLElement
      expect(badge.style.color).not.toContain('--grn')
      expect(badge.style.color).not.toContain('--acc')
      cleanup()
    }
  })
})
