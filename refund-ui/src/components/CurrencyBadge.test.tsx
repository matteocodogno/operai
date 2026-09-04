/**
 * @vitest-environment jsdom
 *
 * Component tests for CurrencyBadge (post-close change, specs/007-refund-
 * service — currency split from entity, see `EntityBadge.tsx`'s doc
 * comment). Covers: every currency renders its ISO code as text (never
 * color-only), a decorative glyph is aria-hidden when one exists, and each
 * variant is distinctly colored.
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
    ['USD', '$'],
    ['GBP', '£'],
  ] as const)('renders the %s variant with its glyph and code label', (currency, glyph) => {
    render(<CurrencyBadge currency={currency} />)

    const badge = screen.getByTestId('currency-badge')
    expect(badge.textContent).toBe(`${glyph}${currency}`)
  })

  // Regression: the CHF chip read "CHF CHF" on the request page, because the
  // Swiss franc's `glyph` was the literal string 'CHF' — the same value as its
  // label — so the code was printed twice. This spec previously ASSERTED that
  // duplication (`toBe('CHFCHF')`), which is why the defect shipped; it now
  // pins the opposite.
  it('renders CHF exactly once — it has no glyph distinct from its ISO code', () => {
    render(<CurrencyBadge currency="CHF" />)

    const badge = screen.getByTestId('currency-badge')
    expect(badge.textContent).toBe('CHF')
    expect(badge.textContent).not.toBe('CHFCHF')
    // No empty decorative span left behind in the chip.
    expect(badge.querySelector('[aria-hidden="true"]')).toBeNull()
  })

  it('every currency shows its ISO code as visible text (never color-only)', () => {
    for (const currency of ['EUR', 'CHF', 'USD', 'GBP'] as const) {
      render(<CurrencyBadge currency={currency} />)
      expect(screen.getByTestId('currency-badge').textContent).toContain(currency)
      cleanup()
    }
  })

  it('no variant repeats its ISO code', () => {
    for (const currency of ['EUR', 'CHF', 'USD', 'GBP'] as const) {
      render(<CurrencyBadge currency={currency} />)
      const text = screen.getByTestId('currency-badge').textContent ?? ''
      expect(text.split(currency).length - 1).toBe(1)
      cleanup()
    }
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
