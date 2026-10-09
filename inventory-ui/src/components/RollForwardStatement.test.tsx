/**
 * @vitest-environment jsdom
 *
 * Component tests for RollForwardStatement (T38, specs/015-hardware-inventory;
 * design.md T6, § Accessibility "Data tables"; refs AC-8.1).
 */

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import RollForwardStatement from './RollForwardStatement'

afterEach(cleanup)

const ROLL = {
  openingCents: 2168900,
  disposalsCents: 53000,
  purchasesCents: 1829589,
  depreciationCents: 2245831,
  closingCents: 1699658,
}

const renderStatement = (currency: 'CHF' | 'EUR' = 'CHF', roll = ROLL) =>
  render(<RollForwardStatement rollForward={roll} currency={currency} entity="welld_ch" year={2026} />)

const lineOf = (name: RegExp) => screen.getByRole('rowheader', { name }).closest('tr') as HTMLTableRowElement

describe('RollForwardStatement', () => {
  it('is a labelled table with a caption and row headers', () => {
    renderStatement()
    expect(screen.getByRole('table', { name: /roll-forward of fiscal year 2026 for WellD CH/i })).not.toBeNull()
    expect(screen.getAllByRole('rowheader')).toHaveLength(5)
  })

  it('shows the five lines in order, each with its figure and currency', () => {
    renderStatement()
    const rows = screen.getAllByRole('rowheader').map((header) => header.closest('tr') as HTMLTableRowElement)
    expect(rows.map((row) => within(row).getAllByRole('cell')[0].textContent)).toEqual([
      '21689,00 CHF',
      '530,00 CHF',
      '18295,89 CHF',
      '22458,31 CHF',
      '16996,58 CHF',
    ])
  })

  it('names every line with words as well as signs', () => {
    renderStatement()
    expect(lineOf(/^Opening book value$/).textContent).not.toMatch(/[−+=]/)
    expect(lineOf(/^Less disposals$/).textContent).toContain('−')
    expect(lineOf(/^Plus purchases$/).textContent).toContain('+')
    expect(lineOf(/^Less depreciation$/).textContent).toContain('−')
    expect(lineOf(/^Closing book value$/).textContent).toContain('=')
  })

  it('keeps the sign glyph out of the accessible name (the word carries the meaning)', () => {
    renderStatement()
    const glyph = lineOf(/^Less disposals$/).querySelector('[aria-hidden="true"]')
    expect(glyph?.textContent).toBe('−')
  })

  it('uses the entity currency: EUR figures carry the euro sign', () => {
    renderStatement('EUR')
    expect(within(lineOf(/^Closing book value$/)).getAllByRole('cell')[0].textContent).toBe('16996,58 €')
  })

  it('shows a negative closing figure instead of hiding it', () => {
    renderStatement('CHF', { ...ROLL, closingCents: -500 })
    expect(within(lineOf(/^Closing book value$/)).getAllByRole('cell')[0].textContent).toBe('-5,00 CHF')
  })
})
