/**
 * @vitest-environment jsdom
 *
 * Component tests for EntityBadge (T15, specs/007-refund-service, design.md
 * Component inventory: "EntityBadge (WellD Italia·EUR / WellD CH·CHF chip)").
 *
 * Covers: both variants render a glyph AND a text label that spells out both
 * the entity name and its derived currency (never color-only, never
 * currency-only-inferred-from-color).
 */

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import EntityBadge from './EntityBadge'

afterEach(() => {
  cleanup()
})

describe('EntityBadge', () => {
  it.each([
    ['welld_it', 'WellD Italia · EUR', '🇮🇹'],
    ['welld_ch', 'WellD CH · CHF', '🇨🇭'],
  ] as const)('renders the %s variant with its glyph and Entity · Currency label', (entity, label, glyph) => {
    render(<EntityBadge entity={entity} />)

    const badge = screen.getByTestId('entity-badge')
    expect(badge.textContent).toBe(`${glyph}${label}`)
  })

  it('always spells out the currency in text, never leaves it color-only', () => {
    render(<EntityBadge entity="welld_it" />)
    expect(screen.getByTestId('entity-badge').textContent).toContain('EUR')

    cleanup()

    render(<EntityBadge entity="welld_ch" />)
    expect(screen.getByTestId('entity-badge').textContent).toContain('CHF')
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
