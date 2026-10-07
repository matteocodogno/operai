/**
 * @vitest-environment jsdom
 *
 * Component tests for ScheduleTable (T34, specs/015-hardware-inventory; design.md
 * § T2 ledger region, § Accessibility "Data tables"; refs AC-5.8).
 * Presentation only: every figure arrives from the server and is only formatted.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import type { Ledger } from '../lib/types'
import ScheduleTable from './ScheduleTable'

const ledger = (over: Partial<Ledger> = {}): Ledger => ({
  bookValueCents: 33272,
  rule: {
    id: 'r1',
    effectiveFrom: '2026-01-01',
    usefulLifeYears: 3,
    firstYearShare: 'full',
    lowValueThresholdCents: null,
    residualCents: 100,
  },
  schedule: [
    { year: 2026, depreciationCents: 33272, closingCents: 66543, closed: true },
    { year: 2027, depreciationCents: 33271, closingCents: 33272, closed: false },
    { year: 2028, depreciationCents: 33172, closingCents: 100, closed: false },
  ],
  ...over,
})

afterEach(cleanup)

const rows = () => screen.getAllByRole('row').slice(1)

describe('every schedule year (AC-5.8)', () => {
  it('renders one row per year with its depreciation and year-end book value, each carrying the currency', () => {
    render(<ScheduleTable ledger={ledger()} currency="CHF" disposal={null} />)

    expect(rows()).toHaveLength(3)
    const [first, second, third] = rows().map((row) =>
      within(row)
        .getAllByRole('cell')
        .map((cell) => cell.textContent),
    )
    expect(within(rows()[0]).getByRole('rowheader').textContent).toBe('2026')
    expect(first).toEqual(['332,72 CHF', '665,43 CHF', 'Closed'])
    expect(second).toEqual(['332,71 CHF', '332,72 CHF', 'Open'])
    expect(third).toEqual(['331,72 CHF', '1,00 CHF', 'Open'])
    expect(within(rows()[2]).getByRole('rowheader').textContent).toBe('2028')
  })

  it('uses the euro sign for an EUR asset', () => {
    render(<ScheduleTable ledger={ledger()} currency="EUR" disposal={null} />)
    expect(within(rows()[0]).getAllByRole('cell')[0].textContent).toBe('332,72 €')
  })

  it('is a captioned table with column headers and a keyboard-scrollable region', () => {
    render(<ScheduleTable ledger={ledger()} currency="CHF" disposal={null} />)

    expect(screen.getByRole('table', { name: 'Depreciation schedule' })).not.toBeNull()
    expect(screen.getAllByRole('columnheader').map((header) => header.textContent)).toEqual([
      'Year',
      'Depreciation',
      'Book value at year end',
      'State',
    ])
    const region = screen.getByRole('region', { name: 'Depreciation schedule table' })
    expect(region.getAttribute('tabindex')).toBe('0')
  })

  it('renders an empty schedule as the header only', () => {
    render(<ScheduleTable ledger={ledger({ schedule: [] })} currency="CHF" disposal={null} />)
    expect(screen.queryAllByRole('row')).toHaveLength(1)
  })
})

describe('a disposed asset', () => {
  it('ends with a "Disposed" row showing the server\'s book value (zero) and no depreciation', () => {
    render(
      <ScheduleTable
        ledger={ledger({
          bookValueCents: 0,
          schedule: [{ year: 2026, depreciationCents: 33272, closingCents: 66543, closed: false }],
        })}
        currency="CHF"
        disposal={{ disposedOn: '2026-10-01', reason: 'scrapped', salePriceCents: null }}
      />,
    )

    expect(rows()).toHaveLength(2)
    const last = rows()[1]
    expect(within(last).getByRole('rowheader').textContent).toBe('Disposed 01.10.2026')
    expect(
      within(last)
        .getAllByRole('cell')
        .map((cell) => cell.textContent),
    ).toEqual(['—', '0,00 CHF', 'Disposed'])
  })

  it('has no Disposed row for a live asset', () => {
    render(<ScheduleTable ledger={ledger()} currency="CHF" disposal={null} />)
    expect(screen.queryByText(/^Disposed/)).toBeNull()
  })
})
