/**
 * @vitest-environment jsdom
 *
 * Component tests for TimeListStatusBadge (T32, specs/029-time-tracking, design.md S5): a time-list
 * item is Active or Retired, shown through the library `StatusBadge` — Active → the `active`
 * meaning, Retired → `voided` — with a text label and a decorative icon, so colour is never the
 * only signal.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import TimeListStatusBadge from './TimeListStatusBadge'

afterEach(() => {
  cleanup()
})

describe('TimeListStatusBadge', () => {
  it.each([
    [false, 'Active'],
    [true, 'Retired'],
  ] as const)('retired=%s renders the label %s and a decorative icon', (retired, label) => {
    render(<TimeListStatusBadge retired={retired} />)

    const badge = screen.getByTestId('time-list-status-badge')
    expect(badge.textContent).toBe(label)
    // INC-23/31: the glyph is the status dictionary's SVG icon, never a Unicode character.
    expect(badge.querySelector('[aria-hidden="true"] svg')).not.toBeNull()
  })

  it.each([
    [false, 'badge-success'],
    [true, 'badge-muted'],
  ] as const)(
    'retired=%s takes the tone %s from the status dictionary (lib/statusMeaning.ts)',
    (retired, toneClass) => {
      render(<TimeListStatusBadge retired={retired} />)

      expect(screen.getByTestId('time-list-status-badge').className).toContain(toneClass)
    },
  )
})
