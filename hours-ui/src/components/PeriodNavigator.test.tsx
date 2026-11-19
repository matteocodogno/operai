/**
 * @vitest-environment jsdom
 *
 * PeriodNavigator — previous, this and next period, for a week and for a month (specs/20261116-record-hours-in-place T9,
 * T20, T22; design S7 "Navigator"; AC-5.5, AC-5.28; plan decision 12, R18). It holds no state: it is told the period shown
 * and today, and reports the period asked for. Next is unavailable on the current period and Previous on the first one
 * hours-api answers, each `aria-disabled` rather than `disabled`, so the keyboard stays where it is. Every case runs for the
 * week and for the month (`describe.each`): the words differ, nothing else does.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { TablePeriod } from '../lib/tablePeriod'
import { strings } from '../strings'
import PeriodNavigator from './PeriodNavigator'
import type { PeriodNavigatorProps } from './PeriodNavigator'

afterEach(() => cleanup())

const week = (monday: string): TablePeriod => ({ kind: 'week', monday })
const month = (key: string): TablePeriod => ({ kind: 'month', month: key })

// Today is Wednesday 18 November 2026: its week begins on Monday 16 November, its month is November.
const TODAY = '2026-11-18'

/** What differs between the two periods: the words, and a few periods to start from (the periods are the case's, the rules are not). */
type Case = {
  kind: 'week' | 'month'
  n: (typeof strings.table)['week']['nav']
  /** The period holding `TODAY`. */
  now: TablePeriod
  /** The period just before it, and the one before that. */
  before: TablePeriod
  /** A period far back, and the first period an address accepts, with the one after it. */
  old: TablePeriod
  floor: TablePeriod
  afterFloor: TablePeriod
  /** A period that begins in the last weeks of a year, today in March after it, and the period it steps to. */
  yearEnd: { period: TablePeriod; today: string; next: TablePeriod }
  /** A period just after a month boundary, and the one before it. */
  boundary: { period: TablePeriod; previous: TablePeriod }
}

const WEEK: Case = {
  kind: 'week',
  n: strings.table.week.nav,
  now: week('2026-11-16'),
  before: week('2026-11-09'),
  old: week('2026-10-05'),
  floor: week('2000-01-03'),
  afterFloor: week('2000-01-10'),
  yearEnd: { period: week('2026-12-28'), today: '2027-03-10', next: week('2027-01-04') },
  boundary: { period: week('2026-11-02'), previous: week('2026-10-26') },
}

const MONTH: Case = {
  kind: 'month',
  n: strings.table.month.nav,
  now: month('2026-11'),
  before: month('2026-10'),
  old: month('2026-05'),
  floor: month('2000-01'),
  afterFloor: month('2000-02'),
  yearEnd: { period: month('2026-12'), today: '2027-03-10', next: month('2027-01') },
  boundary: { period: month('2026-01'), previous: month('2025-12') },
}

describe.each([WEEK, MONTH])(
  'the navigator of a $kind',
  ({ kind, n, now, before, old, floor, afterFloor, yearEnd, boundary }) => {
    const renderNavigator = (props: Partial<PeriodNavigatorProps> = {}) => {
      const onPeriodChange = vi.fn()
      const view = render(<PeriodNavigator period={now} today={TODAY} onPeriodChange={onPeriodChange} {...props} />)
      return { onPeriodChange, ...view }
    }
    const rerenderWith = (view: ReturnType<typeof renderNavigator>, period: TablePeriod, today: string = TODAY) =>
      view.rerender(<PeriodNavigator period={period} today={today} onPeriodChange={view.onPeriodChange} />)

    const previous = () => screen.getByRole('button', { name: n.previous })
    const next = () => screen.getByRole('button', { name: n.next })
    const current = () => screen.getByRole('button', { name: n.current })

    describe('the controls (AC-5.5)', () => {
      it(`is one group named for the ${kind} with Previous, This ${kind} and Next, in that order`, () => {
        renderNavigator()
        const group = screen.getByRole('group', { name: n.label })
        expect(
          within(group)
            .getAllByRole('button')
            .map((button) => button.getAttribute('aria-label') ?? button.textContent),
        ).toEqual([n.previous, n.current, n.next])
      })

      it('names the icon-only buttons by their label, and shows no word on them', () => {
        renderNavigator()
        expect(previous().textContent).toBe('')
        expect(next().textContent).toBe('')
        expect(current().textContent).toBe(n.current)
      })

      it('says nothing of the other period: no word of the other kind is on it', () => {
        renderNavigator()
        const other = strings.table[kind === 'week' ? 'month' : 'week'].nav
        expect(screen.queryByRole('button', { name: other.previous })).toBeNull()
        expect(screen.queryByRole('group', { name: other.label })).toBeNull()
      })
    })

    describe('previous and next call back with the shifted period (AC-5.5)', () => {
      it('Previous asks for the period just before the one shown', async () => {
        const { onPeriodChange } = renderNavigator()
        await userEvent.click(previous())
        expect(onPeriodChange).toHaveBeenCalledExactlyOnceWith(before)
      })

      it('Next asks for the period just after, from a period before the current one', async () => {
        const { onPeriodChange } = renderNavigator({ period: before })
        await userEvent.click(next())
        expect(onPeriodChange).toHaveBeenCalledExactlyOnceWith(now)
      })

      it('shifts from the period shown, not from today, over a month boundary and a year', async () => {
        const view = renderNavigator({ period: yearEnd.period, today: yearEnd.today })
        await userEvent.click(next())
        expect(view.onPeriodChange).toHaveBeenLastCalledWith(yearEnd.next)
        rerenderWith(view, boundary.period)
        await userEvent.click(previous())
        expect(view.onPeriodChange).toHaveBeenLastCalledWith(boundary.previous)
      })

      it('works from the keyboard, with Enter on the focused button', async () => {
        const { onPeriodChange } = renderNavigator()
        previous().focus()
        await userEvent.keyboard('{Enter}')
        expect(onPeriodChange).toHaveBeenCalledExactlyOnceWith(before)
      })
    })

    describe(`Next is unavailable on the current ${kind}: the future is not browsed (AC-5.5, AC-5.28)`, () => {
      it('is aria-disabled on the current period, still a button in the tab order and not `disabled`', () => {
        renderNavigator()
        expect(next().getAttribute('aria-disabled')).toBe('true')
        expect(next()).toHaveProperty('disabled', false)
      })

      it('is aria-disabled on the current period whichever day of it today is, the first and the last included', () => {
        const view = renderNavigator({ today: kind === 'week' ? '2026-11-16' : '2026-11-01' })
        expect(next().getAttribute('aria-disabled')).toBe('true')
        rerenderWith(view, now, kind === 'week' ? '2026-11-22' : '2026-11-30')
        expect(next().getAttribute('aria-disabled')).toBe('true')
      })

      it('is available on the period before the current one, and on every period before it', () => {
        const view = renderNavigator({ period: before })
        expect(next().getAttribute('aria-disabled')).toBeNull()
        rerenderWith(view, floor)
        expect(next().getAttribute('aria-disabled')).toBeNull()
      })

      it('asks for nothing when pressed, by pointer or by keyboard, and keeps the focus it has', async () => {
        const { onPeriodChange } = renderNavigator()
        next().focus()
        await userEvent.keyboard('{Enter}')
        await userEvent.keyboard(' ')
        await userEvent.click(next())
        expect(onPeriodChange).not.toHaveBeenCalled()
        expect(document.activeElement).toBe(next())
      })

      it('keeps the focus on Next when a press of it reaches the current period, so the keyboard does not fall to the page (R18)', async () => {
        const view = renderNavigator({ period: before })
        next().focus()
        await userEvent.keyboard('{Enter}')
        expect(view.onPeriodChange).toHaveBeenCalledExactlyOnceWith(now)
        rerenderWith(view, now)
        expect(document.activeElement).toBe(next())
        expect(next().getAttribute('aria-disabled')).toBe('true')
        // A second press, now unavailable, does nothing.
        await userEvent.keyboard('{Enter}')
        expect(view.onPeriodChange).toHaveBeenCalledOnce()
      })

      it('keeps the focus on the button once a step back has been made, so a second step needs no new Tab', async () => {
        const view = renderNavigator()
        await userEvent.click(previous())
        rerenderWith(view, before)
        expect(document.activeElement).toBe(previous())
      })

      it('does not take the label away: unavailable is said by aria-disabled, the name stays the same', () => {
        renderNavigator()
        expect(next().getAttribute('aria-label')).toBe(n.next)
      })
    })

    describe(`Previous is unavailable on the first ${kind} hours-api answers (plan decision 12)`, () => {
      it('is available on the current period and on the second one of 2000', () => {
        const view = renderNavigator()
        expect(previous().getAttribute('aria-disabled')).toBeNull()
        rerenderWith(view, afterFloor)
        expect(previous().getAttribute('aria-disabled')).toBeNull()
      })

      it('is aria-disabled on the first period an address names, and asks for nothing', async () => {
        const { onPeriodChange } = renderNavigator({ period: floor })
        expect(previous().getAttribute('aria-disabled')).toBe('true')
        expect(previous()).toHaveProperty('disabled', false)
        previous().focus()
        await userEvent.keyboard('{Enter}')
        await userEvent.click(previous())
        expect(onPeriodChange).not.toHaveBeenCalled()
        expect(document.activeElement).toBe(previous())
        // …and Next is still there to leave it.
        expect(next().getAttribute('aria-disabled')).toBeNull()
      })
    })

    describe(`This ${kind} returns to the current ${kind} (AC-5.5)`, () => {
      it('asks for the period holding today from any other period', async () => {
        const { onPeriodChange } = renderNavigator({ period: old })
        expect(current().getAttribute('aria-disabled')).toBeNull()
        await userEvent.click(current())
        expect(onPeriodChange).toHaveBeenCalledExactlyOnceWith(now)
      })

      it('is aria-disabled while the current period is shown, still a button that keeps focus, and asks for nothing', async () => {
        const { onPeriodChange } = renderNavigator()
        const button = current()
        expect(button.getAttribute('aria-disabled')).toBe('true')
        expect(button).toHaveProperty('disabled', false)
        await userEvent.click(button)
        expect(onPeriodChange).not.toHaveBeenCalled()
        expect(document.activeElement).toBe(button)
      })

      it('does not ask for the period it is already on from the keyboard either', async () => {
        const { onPeriodChange } = renderNavigator()
        current().focus()
        await userEvent.keyboard('{Enter}')
        await userEvent.keyboard(' ')
        expect(onPeriodChange).not.toHaveBeenCalled()
      })
    })
  },
)

describe('This week and This month know which day belongs to which period (AC-5.5)', () => {
  it('knows a Sunday belongs to the week that began six days before', async () => {
    const onPeriodChange = vi.fn()
    render(<PeriodNavigator period={week('2026-11-02')} today="2026-11-22" onPeriodChange={onPeriodChange} />)
    await userEvent.click(screen.getByRole('button', { name: strings.table.week.nav.current }))
    expect(onPeriodChange).toHaveBeenCalledExactlyOnceWith(week('2026-11-16'))
  })

  it('knows the last day of a month belongs to that month, and the first of the next to the next', async () => {
    const onPeriodChange = vi.fn()
    const { rerender } = render(
      <PeriodNavigator period={month('2026-10')} today="2026-11-30" onPeriodChange={onPeriodChange} />,
    )
    await userEvent.click(screen.getByRole('button', { name: strings.table.month.nav.current }))
    expect(onPeriodChange).toHaveBeenLastCalledWith(month('2026-11'))
    rerender(<PeriodNavigator period={month('2026-11')} today="2026-12-01" onPeriodChange={onPeriodChange} />)
    await userEvent.click(screen.getByRole('button', { name: strings.table.month.nav.current }))
    expect(onPeriodChange).toHaveBeenLastCalledWith(month('2026-12'))
  })
})
