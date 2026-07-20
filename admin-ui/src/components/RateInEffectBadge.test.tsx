/**
 * @vitest-environment jsdom
 *
 * Component tests for RateInEffectBadge (T11, specs/009-mileage-rate).
 */

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import RateInEffectBadge from './RateInEffectBadge'

afterEach(() => {
  cleanup()
})

describe('RateInEffectBadge', () => {
  it('renders a glyph AND visible text — never color-only', () => {
    render(<RateInEffectBadge />)

    const badge = screen.getByTestId('rate-in-effect-badge')
    expect(badge.textContent).toContain('In effect')
    expect(badge.querySelector('[aria-hidden="true"]')).not.toBeNull()
  })
})
