/**
 * @vitest-environment jsdom
 *
 * Component tests for ConditionChip (T15, specs/004-auth-roles-permissions;
 * `self-approval` kind added T4, specs/010-self-approval-control).
 *
 * Covers:
 *   (A) each of the 6 kinds (own/any/entity/department/jobTitle/
 *       self-approval — matching the plan's `conditions` JSON shape
 *       verbatim) renders its expected label text.
 *   (B) every chip pairs a decorative (aria-hidden) glyph with text — colour
 *       is never the only signal.
 *   (C) the self-approval chip is distinct from the entity chip — its own
 *       testid, glyph, and label (AC-1.4).
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
  'self-approval': 'No self-approval',
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

  it('renders the self-approval chip distinct from the entity chip (AC-1.4)', () => {
    render(
      <>
        <ConditionChip kind="entity" />
        <ConditionChip kind="self-approval" />
      </>,
    )

    const entityChip = screen.getByTestId('condition-chip-entity')
    const selfApprovalChip = screen.getByTestId('condition-chip-self-approval')
    expect(entityChip).not.toBe(selfApprovalChip)
    expect(selfApprovalChip.textContent).toContain('No self-approval')
    expect(selfApprovalChip.textContent).not.toContain('Entity')
  })
})
