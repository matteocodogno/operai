/**
 * @vitest-environment jsdom
 *
 * Component tests for CurrencyBadge (post-close change, specs/007-refund-
 * service — currency split from entity, see `EntityBadge.tsx`'s doc
 * comment). Covers: all four currencies render a glyph AND a text label
 * (never color-only), the glyph is aria-hidden, and each variant is
 * distinctly colored.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import CurrencyBadge from './CurrencyBadge'

afterEach(() => {
  cleanup()
})

describe('CurrencyBadge', () => {
  it.each([
    ['EUR', '€'],
    ['CHF', 'CHF'],
    ['USD', '$'],
    ['GBP', '£'],
  ] as const)('renders the %s variant with its glyph and code label', (currency, glyph) => {
    render(<CurrencyBadge currency={currency} />)

    const badge = screen.getByTestId('currency-badge')
    expect(badge.textContent).toBe(`${glyph}${currency}`)
  })

  it('the glyph is aria-hidden (the code text alone carries the accessible name)', () => {
    render(<CurrencyBadge currency="USD" />)

    const badge = screen.getByTestId('currency-badge')
    const glyphSpan = badge.querySelector('[aria-hidden="true"]')
    expect(glyphSpan?.textContent).toBe('$')
  })

  it('uses a different color per variant (never color-only, but distinct anyway)', () => {
    const colors = (['EUR', 'CHF', 'USD', 'GBP'] as const).map((currency) => {
      const { container } = render(<CurrencyBadge currency={currency} />)
      const badge = container.querySelector('[data-testid="currency-badge"]') as HTMLElement
      const color = badge.style.color
      cleanup()
      return color
    })

    expect(new Set(colors).size).toBe(4)
  })
})
