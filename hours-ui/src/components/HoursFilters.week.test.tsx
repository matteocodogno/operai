/**
 * @vitest-environment jsdom
 *
 * HoursFilters in the Week (specs/20261116-record-hours-in-place T10; design S6 "Filters card in the Week"; WA5,
 * AC-5.21, AC-5.22): the week takes the place of Period, so the card is given `showPeriod={false}` and draws neither
 * Period nor, under a Custom range, From and To — while every other control keeps what it was given.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock('shell/session', async () => (await import('../test-support/fakeSession')).shellSessionMock(apiFetch))

import { strings } from '../strings'
import { fakeApi } from '../test-support/fakeApi'
import { LISTS } from '../test-support/fixtures/myHours'
import HoursFilters from './HoursFilters'
import type { HoursFiltersProps } from './HoursFilters'
import { DEFAULT_FILTERS } from './HoursFiltersState'

const t = strings.filters

beforeEach(() => {
  apiFetch.mockReset()
  apiFetch.mockImplementation(fakeApi())
})
afterEach(() => cleanup())

const renderFilters = (overrides: Partial<HoursFiltersProps> = {}) => {
  const onChange = vi.fn()
  const props: HoursFiltersProps = {
    state: DEFAULT_FILTERS,
    rangeErrors: {},
    project: null,
    deal: null,
    lists: { status: 'loaded', lists: LISTS },
    filtered: false,
    pickerKey: 0,
    onChange,
    onProjectChange: vi.fn(),
    onDealChange: vi.fn(),
    onClear: vi.fn(),
    onRetryLists: vi.fn(),
    ...overrides,
  }
  render(<HoursFilters {...props} />)
  return { onChange }
}

describe('Period (WA5)', () => {
  it('is drawn by default: the List has it', () => {
    renderFilters()
    expect(screen.queryByRole('combobox', { name: t.period.label })).not.toBeNull()
  })

  it('is not drawn when the page says the week takes its place', () => {
    renderFilters({ showPeriod: false })
    expect(screen.queryByRole('combobox', { name: t.period.label })).toBeNull()
    expect(screen.queryByTestId('hours-filter-period')).toBeNull()
  })

  it('takes From and To with it, even for a Custom range held in the address', () => {
    renderFilters({
      showPeriod: false,
      state: { ...DEFAULT_FILTERS, period: 'custom', from: '2026-10-01', to: '2026-10-05' },
    })
    expect(screen.queryByTestId('hours-filter-from')).toBeNull()
    expect(screen.queryByTestId('hours-filter-to')).toBeNull()
  })
})

describe('the other controls in the Week (AC-5.21, AC-5.22)', () => {
  it('Recorded on, Project, Deal, Category and Work type are all there, holding what they were given', () => {
    renderFilters({ showPeriod: false, state: { ...DEFAULT_FILTERS, target: 'deal', categoryId: 'tc-admin' } })
    expect((screen.getByRole('combobox', { name: t.recordedOn.label }) as HTMLSelectElement).value).toBe('deal')
    expect((screen.getByRole('combobox', { name: t.category.label }) as HTMLSelectElement).value).toBe('tc-admin')
    expect(screen.queryByTestId('hours-filter-project-input')).not.toBeNull()
    expect(screen.queryByTestId('hours-filter-deal-input')).not.toBeNull()
    expect(screen.queryByRole('combobox', { name: t.workType.label })).not.toBeNull()
  })

  it('reports a change as a patch, as in the List', async () => {
    const { onChange } = renderFilters({ showPeriod: false })
    await userEvent.selectOptions(screen.getByRole('combobox', { name: t.recordedOn.label }), 'project')
    expect(onChange).toHaveBeenCalledExactlyOnceWith({ target: 'project' })
  })
})
