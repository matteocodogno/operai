/**
 * @vitest-environment jsdom
 *
 * PeriodSwitch — Week | Month, the table view's Period (specs/20261116-record-hours-in-place T22; design S7 "Toolbar",
 * decision 2; AC-5.26, AC-5.27, AC-4.6). A `RadioGroupField` of two native radios, applied at once, one tab stop, the arrow
 * keys select. It holds no state and no address: it is told the kind shown and reports the kind asked for; the page decides
 * which period that is (`switchTo`) and writes the address.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { TablePeriodKind } from '../lib/tablePeriod'
import { strings } from '../strings'
import PeriodSwitch from './PeriodSwitch'

afterEach(() => cleanup())

// jsdom has no `CSS`, which user-event reads to find the other radios of a group when an arrow key moves between them.
beforeAll(() => {
  if (typeof CSS === 'undefined')
    vi.stubGlobal('CSS', { escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, '\\$&') })
})

const t = strings.table.period

const renderSwitch = (value: TablePeriodKind = 'week') => {
  const onChange = vi.fn()
  const view = render(<PeriodSwitch value={value} onChange={onChange} />)
  return { onChange, ...view }
}

const group = () => screen.getByRole('radiogroup', { name: t.label })
const radio = (name: string) => within(group()).getByRole('radio', { name })

describe('the control (AC-5.26, AC-5.27)', () => {
  it('is a radio group named "Period" holding two radios, Week then Month', () => {
    renderSwitch()
    expect(
      within(group())
        .getAllByRole('radio')
        .map((input) => input.closest('label')?.textContent),
    ).toEqual([t.week, t.month])
  })

  it('has the week selected on a week and the month on a month, never both', () => {
    const { rerender, onChange } = renderSwitch('week')
    expect((radio(t.week) as HTMLInputElement).checked).toBe(true)
    expect((radio(t.month) as HTMLInputElement).checked).toBe(false)
    rerender(<PeriodSwitch value="month" onChange={onChange} />)
    expect((radio(t.week) as HTMLInputElement).checked).toBe(false)
    expect((radio(t.month) as HTMLInputElement).checked).toBe(true)
  })

  it('is one group of native radios sharing a name: a single tab stop, and the selected radio is it', () => {
    renderSwitch('month')
    const names = new Set(
      within(group())
        .getAllByRole('radio')
        .map((input) => input.getAttribute('name')),
    )
    expect(names.size).toBe(1)
    expect([...names][0]).toBeTruthy()
  })

  it('names itself apart from every other instance: two switches on a page are two groups', () => {
    render(
      <>
        <PeriodSwitch value="week" onChange={vi.fn()} />
        <PeriodSwitch value="month" onChange={vi.fn()} />
      </>,
    )
    const names = screen.getAllByRole('radio').map((input) => input.getAttribute('name'))
    expect(new Set(names).size).toBe(2)
  })
})

describe('choosing a period reports the kind asked for, once, at once', () => {
  it('Month on a week asks for the month', async () => {
    const { onChange } = renderSwitch('week')
    await userEvent.click(radio(t.month))
    expect(onChange).toHaveBeenCalledExactlyOnceWith('month')
  })

  it('Week on a month asks for the week', async () => {
    const { onChange } = renderSwitch('month')
    await userEvent.click(radio(t.week))
    expect(onChange).toHaveBeenCalledExactlyOnceWith('week')
  })

  it('the one already selected asks for nothing', async () => {
    const { onChange } = renderSwitch('week')
    await userEvent.click(radio(t.week))
    expect(onChange).not.toHaveBeenCalled()
  })

  it('the arrow keys select the other radio and apply it at once, the focus staying in the group', async () => {
    const { onChange } = renderSwitch('week')
    radio(t.week).focus()
    await userEvent.keyboard('{ArrowRight}')
    expect(onChange).toHaveBeenCalledExactlyOnceWith('month')
    expect(document.activeElement).toBe(radio(t.month))
  })

  it('and back, with the left arrow', async () => {
    const { onChange } = renderSwitch('month')
    radio(t.month).focus()
    await userEvent.keyboard('{ArrowLeft}')
    expect(onChange).toHaveBeenCalledExactlyOnceWith('week')
  })

  it('keeps the focus on the radio it was reached with when the page then re-renders it', async () => {
    const { onChange, rerender } = renderSwitch('week')
    await userEvent.click(radio(t.month))
    rerender(<PeriodSwitch value="month" onChange={onChange} />)
    expect(document.activeElement).toBe(radio(t.month))
  })
})
