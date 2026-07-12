/**
 * @vitest-environment jsdom
 *
 * Component tests for ConditionChip (T15, specs/004-auth-roles-permissions).
 *
 * Covers:
 *   (A) each of the 5 kinds (own/any/entity/department/jobTitle — matching
 *       the plan's `conditions` JSON shape verbatim) renders its expected
 *       label text.
 *   (B) every chip pairs a decorative (aria-hidden) glyph with text — colour
 *       is never the only signal.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import ConditionChip, { type ConditionChipKind } from './ConditionChip'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const expectedLabels: Record<ConditionChipKind, string> = {
  own: 'Own records',
  any: 'Any records',
  entity: 'Entity',
  department: 'Department',
  jobTitle: 'Job title',
}

describe('ConditionChip', () => {
  it.each(Object.keys(expectedLabels) as ConditionChipKind[])(
    'renders the "%s" chip with its expected label',
    (kind) => {
      render(<ConditionChip kind={kind} />)

      const chip = screen.getByTestId(`condition-chip-${kind}`)
      expect(chip.textContent).toContain(expectedLabels[kind])
    },
  )

  it('pairs a decorative glyph with text (colour is never the only signal)', () => {
    render(<ConditionChip kind="own" />)

    const chip = screen.getByTestId('condition-chip-own')
    const glyph = chip.querySelector('[aria-hidden="true"]')
    expect(glyph).not.toBeNull()
    expect(glyph!.textContent).not.toBe('')
    expect(chip.textContent).toContain('Own records')
  })
})
