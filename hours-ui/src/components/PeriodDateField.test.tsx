/**
 * @vitest-environment jsdom
 *
 * PeriodDateField — the date field of the table view's toolbar (specs/20261116-record-hours-in-place T23; design F7, S7
 * "Toolbar"; plan decision 14 and R16; AC-5.30, AC-5.31, AC-4.6). A `Field` + `DateInput` that picks a day and shows the
 * week or the month holding it, in the same kind of period: a complete day within the bounds of `pickBounds`, in another
 * period, is reported at once; a day of the period shown, an incomplete or emptied value, a day before the first period and
 * a day after today change nothing and report nothing. While it has focus its text is the person's and no render rewrites
 * it (a controlled value written under a half-typed date wipes it, R16); on blur it shows the reference day of the period
 * again. It holds no period and no address: it is told the period shown and today, and the page writes the address.
 *
 * The cases run for the week and for the month (`describe.each`): the words and the bounds differ, nothing else does. jsdom
 * has no half-typed date (a native date input holds `''` until its date is complete, and a browser keeps the typed
 * segments in a place a script cannot read), so "incomplete" is the `''` that input reports; Chromium typed key by key is
 * checked in the real browser (T24's journey G, and the task's RENDERED line).
 */
import { useEffect, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { holding, pickBounds, referenceDay } from '../lib/tablePeriod'
import type { TablePeriod, TablePeriodKind } from '../lib/tablePeriod'
import { strings } from '../strings'
import PeriodDateField from './PeriodDateField'

afterEach(() => cleanup())

// Today is Thursday 19 November 2026: its week begins on Monday 16 November, its month is November.
const TODAY = '2026-11-19'

type Case = {
  kind: TablePeriodKind
  label: string
  /** The period holding TODAY, and a past one: the month before, or the week before. */
  now: TablePeriod
  past: TablePeriod
  /** A day of `past`, another day of `past`, and a day in neither `past` nor `now`. */
  inPast: string
  alsoInPast: string
  elsewhere: string
  /** The period holding `elsewhere`. */
  elsewherePeriod: TablePeriod
  /** A day of the period shown when it is `now` (not today), and the day after today. */
  inNow: string
}

const WEEK: Case = {
  kind: 'week',
  label: strings.table.week.pick.label,
  now: { kind: 'week', monday: '2026-11-16' },
  past: { kind: 'week', monday: '2026-11-09' },
  inPast: '2026-11-11',
  alsoInPast: '2026-11-15',
  elsewhere: '2026-10-14',
  elsewherePeriod: { kind: 'week', monday: '2026-10-12' },
  inNow: '2026-11-17',
}

const MONTH: Case = {
  kind: 'month',
  label: strings.table.month.pick.label,
  now: { kind: 'month', month: '2026-11' },
  past: { kind: 'month', month: '2026-10' },
  inPast: '2026-10-14',
  alsoInPast: '2026-10-31',
  elsewhere: '2026-09-03',
  elsewherePeriod: { kind: 'month', month: '2026-09' },
  inNow: '2026-11-02',
}

/** What the page does to the field from outside: another control changing the period, and the clock moving on. */
type Outside = { setPeriod: (period: TablePeriod) => void; setToday: (today: string) => void }

/** The field as the toolbar holds it: told the period shown, and the period it reports is the one the page would show next. */
const Harness = ({
  initial,
  today: initialToday,
  onPeriodChange,
  onOutside,
}: {
  initial: TablePeriod
  today: string
  onPeriodChange: (period: TablePeriod) => void
  /** Hands the setters to the test once, so it can do from outside what another control does. */
  onOutside: (outside: Outside) => void
}) => {
  const [period, setPeriod] = useState(initial)
  const [today, setToday] = useState(initialToday)
  useEffect(() => onOutside({ setPeriod, setToday }), [onOutside])
  return (
    <>
      <PeriodDateField
        period={period}
        today={today}
        onPeriodChange={(next) => {
          onPeriodChange(next)
          setPeriod(next)
        }}
      />
      <button type="button" data-testid="elsewhere">
        elsewhere
      </button>
    </>
  )
}

const field = () => screen.getByTestId('hours-period-date') as HTMLInputElement
/** The browser's change of a date input: the value, then an `input`/`change` event. */
const pick = (value: string) => fireEvent.change(field(), { target: { value } })
const focusField = () => act(() => field().focus())
const blurField = () => act(() => field().blur())

describe.each([WEEK, MONTH])('the date field of a $kind', (c) => {
  const renderField = (period: TablePeriod = c.now, today: string = TODAY) => {
    const onPeriodChange = vi.fn()
    let outside: Outside | null = null
    const view = render(
      <Harness
        initial={period}
        today={today}
        onPeriodChange={onPeriodChange}
        onOutside={(setters) => {
          outside = setters
        }}
      />,
    )
    return {
      onPeriodChange,
      /** Another control changes the period (the navigator, the Period switch, an address). */
      setPeriod: (next: TablePeriod) => act(() => outside!.setPeriod(next)),
      /** The clock moves on. */
      setToday: (next: string) => act(() => outside!.setToday(next)),
      ...view,
    }
  }

  describe('the control (AC-5.30, AC-5.31)', () => {
    it(`is a date input labelled for what it does, "${c.label}"`, () => {
      renderField()
      const input = screen.getByLabelText(c.label) as HTMLInputElement
      expect(input).toBe(field())
      expect(input.type).toBe('date')
    })

    it('offers no day after today: `max` is today, and `min` is the first day of the earliest period (pickBounds)', () => {
      renderField()
      const { min, max } = pickBounds(c.kind, TODAY)
      expect(field().max).toBe(TODAY)
      expect(field().max).toBe(max)
      expect(field().min).toBe(min)
      expect(field().min).toBe(c.kind === 'week' ? '2000-01-03' : '2000-01-01')
    })

    it('takes `max` from the today it is given, whatever day that is', () => {
      const { setToday } = renderField(c.now, '2027-03-10')
      expect(field().max).toBe('2027-03-10')
      setToday('2027-03-11')
      expect(field().max).toBe('2027-03-11')
    })

    it('is described by "Up to today.", which is read on focus and not drawn (design F7)', () => {
      renderField()
      const describedBy = field().getAttribute('aria-describedby')
      expect(describedBy).toBeTruthy()
      const hint = document.getElementById(describedBy!)
      expect(hint?.textContent).toBe(strings.table.pick.hint)
      expect(strings.table.pick.hint).toBe('Up to today.')
      // Drawn by no visible text: the hint is the library's visually hidden span, and the field has no `<p>` hint under it.
      expect(hint?.classList.contains('visually-hidden')).toBe(true)
      expect(document.querySelector('.field-hint')).toBeNull()
    })

    it('has no required mark and no error text: a refused day is given back, not scolded (design F7)', () => {
      renderField()
      expect(document.querySelector('.field-required')).toBeNull()
      expect(field().required).toBe(false)
      pick('2999-01-01')
      expect(document.querySelector('.field-error')).toBeNull()
      expect(document.querySelector('[role="alert"]')).toBeNull()
    })

    it('names itself apart from every other instance: two fields on a page are two labels and two descriptions', () => {
      render(
        <>
          <PeriodDateField period={c.now} today={TODAY} onPeriodChange={vi.fn()} />
          <PeriodDateField period={c.now} today={TODAY} onPeriodChange={vi.fn()} />
        </>,
      )
      const inputs = screen.getAllByLabelText(c.label)
      expect(inputs).toHaveLength(2)
      expect(new Set(inputs.map((input) => input.id)).size).toBe(2)
      expect(new Set(inputs.map((input) => input.getAttribute('aria-describedby'))).size).toBe(2)
    })
  })

  describe('the day it shows is the period’s reference day, never state of its own (AC-5.30; G21)', () => {
    it('shows today on the current period', () => {
      renderField(c.now)
      expect(field().value).toBe(TODAY)
    })

    it('shows the first day of a past period', () => {
      renderField(c.past)
      expect(field().value).toBe(referenceDay(c.past, TODAY))
      expect(field().value).toBe(c.kind === 'week' ? '2026-11-09' : '2026-10-01')
    })

    it('shows the new period’s reference day when another control changed the period (the date field has no focus)', () => {
      const { setPeriod } = renderField(c.past)
      setPeriod(c.now)
      expect(field().value).toBe(TODAY)
      setPeriod(c.past)
      expect(field().value).toBe(referenceDay(c.past, TODAY))
    })

    it('stays the same input through a change of period: it is rerendered, never replaced', () => {
      const { setPeriod } = renderField(c.past)
      const before = field()
      setPeriod(c.now)
      expect(field()).toBe(before)
    })
  })

  describe('a day in another period shows that period, at once, in the same kind (AC-5.30)', () => {
    it('reports the period holding the day picked', () => {
      const { onPeriodChange } = renderField(c.now)
      pick(c.elsewhere)
      expect(onPeriodChange).toHaveBeenCalledExactlyOnceWith(c.elsewherePeriod)
      expect(onPeriodChange).toHaveBeenCalledExactlyOnceWith(holding(c.kind, c.elsewhere))
    })

    it('reports a day of the past from the past too, whichever day of its period is picked', () => {
      const { onPeriodChange } = renderField(c.elsewherePeriod)
      pick(c.inPast)
      expect(onPeriodChange).toHaveBeenLastCalledWith(c.past)
      pick(c.alsoInPast)
      expect(onPeriodChange).toHaveBeenLastCalledWith(c.past)
    })

    it('reports today’s period when today is picked from a past one', () => {
      const { onPeriodChange } = renderField(c.past)
      pick(TODAY)
      expect(onPeriodChange).toHaveBeenCalledExactlyOnceWith(c.now)
    })

    it('accepts the first day of the earliest period: the floor’s week on 2000-01-03, its month on 2000-01-01', () => {
      const { onPeriodChange } = renderField(c.now)
      const { min } = pickBounds(c.kind, TODAY)
      pick(min)
      expect(onPeriodChange).toHaveBeenCalledExactlyOnceWith(holding(c.kind, min))
    })

    it('reports a day typed in full, key by key, and only that: nothing is asked for before the date is complete', async () => {
      const { onPeriodChange } = renderField(c.now)
      await userEvent.clear(field())
      await userEvent.type(field(), c.elsewhere)
      expect(onPeriodChange).toHaveBeenCalledExactlyOnceWith(c.elsewherePeriod)
    })
  })

  describe('a day of the period shown, an incomplete or emptied value and a day out of range change nothing (AC-5.30, AC-5.31, R16)', () => {
    it('a day of the period shown reports nothing, today and another day of it alike', () => {
      const { onPeriodChange } = renderField(c.now)
      pick(c.inNow)
      expect(onPeriodChange).not.toHaveBeenCalled()
      pick(TODAY)
      expect(onPeriodChange).not.toHaveBeenCalled()
    })

    it('a day of a past period shown reports nothing', () => {
      const { onPeriodChange } = renderField(c.past)
      pick(c.alsoInPast)
      expect(onPeriodChange).not.toHaveBeenCalled()
    })

    it('an emptied value reports nothing', () => {
      const { onPeriodChange } = renderField(c.now)
      pick('')
      expect(onPeriodChange).not.toHaveBeenCalled()
    })

    it('the day after today reports nothing, and so does the far future', () => {
      const { onPeriodChange } = renderField(c.now)
      pick('2026-11-20')
      pick('2027-01-01')
      pick('9999-12-31')
      expect(onPeriodChange).not.toHaveBeenCalled()
    })

    it('a day before the first period reports nothing: the floor’s Saturday for a week (its week began before it), a day before it for a month', () => {
      const { onPeriodChange } = renderField(c.now)
      pick(c.kind === 'week' ? '2000-01-02' : '1999-12-31')
      expect(onPeriodChange).not.toHaveBeenCalled()
    })

    it('the intermediate days of a year typed digit by digit report nothing, and the complete day then does', () => {
      const { onPeriodChange } = renderField(c.now)
      for (const day of ['0002-10-14', '0020-10-14', '0202-10-14']) pick(day)
      expect(onPeriodChange).not.toHaveBeenCalled()
      pick(c.elsewhere)
      expect(onPeriodChange).toHaveBeenCalledExactlyOnceWith(c.elsewherePeriod)
    })

    it('a year of more than four digits reports nothing', () => {
      const { onPeriodChange } = renderField(c.now)
      pick('20260-10-14')
      pick('275760-09-13')
      expect(onPeriodChange).not.toHaveBeenCalled()
    })

    it('a day that was refused is not remembered: the same day picked after today moves on is reported', () => {
      const { onPeriodChange, setToday } = renderField(c.past, TODAY)
      pick('2026-11-20')
      expect(onPeriodChange).not.toHaveBeenCalled()
      setToday('2026-11-20')
      pick('2026-11-20')
      expect(onPeriodChange).toHaveBeenCalledExactlyOnceWith(holding(c.kind, '2026-11-20'))
    })
  })

  describe('while it has focus its text is the person’s (R16, design F7 4)', () => {
    it('keeps the day just picked through the re-render the navigation causes, and shows the reference day on blur', () => {
      renderField(c.now)
      focusField()
      pick(c.elsewhere)
      // The page showed the period: the reference day is now the period's first day, but the field is being used.
      expect(field().value).toBe(c.elsewhere)
      blurField()
      expect(field().value).toBe(referenceDay(c.elsewherePeriod, TODAY))
      expect(field().value).toBe(c.kind === 'week' ? '2026-10-12' : '2026-09-01')
    })

    it('keeps an emptied value, writes nothing under it, and gives the reference day back on blur', () => {
      renderField(c.past)
      focusField()
      pick('')
      expect(field().value).toBe('')
      blurField()
      expect(field().value).toBe(referenceDay(c.past, TODAY))
    })

    it('keeps a day after today, reports nothing, and gives the reference day back on blur: a refused day is visibly given back', () => {
      const { onPeriodChange } = renderField(c.now)
      focusField()
      pick('2026-12-24')
      expect(field().value).toBe('2026-12-24')
      expect(onPeriodChange).not.toHaveBeenCalled()
      blurField()
      expect(field().value).toBe(TODAY)
    })

    it('keeps a day before the first period the same way', () => {
      const { onPeriodChange } = renderField(c.past)
      focusField()
      pick('0202-10-14')
      expect(field().value).toBe('0202-10-14')
      blurField()
      expect(onPeriodChange).not.toHaveBeenCalled()
      expect(field().value).toBe(referenceDay(c.past, TODAY))
    })

    it('keeps a day of the period shown as it was typed, and gives the reference day on blur', () => {
      const { onPeriodChange } = renderField(c.now)
      focusField()
      pick(c.inNow)
      expect(field().value).toBe(c.inNow)
      expect(onPeriodChange).not.toHaveBeenCalled()
      blurField()
      expect(field().value).toBe(TODAY)
    })

    it('is not rewritten by a render that changes what it would show, as long as it has focus', () => {
      const { setPeriod, setToday } = renderField(c.past)
      focusField()
      pick('')
      setPeriod(c.now)
      expect(field().value).toBe('')
      setPeriod(c.past)
      setToday('2026-11-30')
      expect(field().value).toBe('')
      blurField()
      expect(field().value).toBe(referenceDay(c.past, '2026-11-30'))
    })

    it('goes on from the text it has: another complete day after the first is another navigation', () => {
      const { onPeriodChange } = renderField(c.now)
      focusField()
      pick(c.elsewhere)
      pick(c.inPast)
      expect(onPeriodChange.mock.calls.map(([period]) => period)).toEqual([c.elsewherePeriod, c.past])
      expect(field().value).toBe(c.inPast)
    })

    it('keeps the focus in the field through the navigation (design F7 5)', () => {
      renderField(c.now)
      focusField()
      pick(c.elsewhere)
      expect(document.activeElement).toBe(field())
    })

    it('gives the new reference day to a field that lost focus before the period changed, whoever changed it', () => {
      const { setPeriod } = renderField(c.now)
      focusField()
      pick('')
      blurField()
      expect(field().value).toBe(TODAY)
      setPeriod(c.past)
      expect(field().value).toBe(referenceDay(c.past, TODAY))
    })

    it('puts the reference day back at once when a value is picked while another control has the focus', () => {
      const { onPeriodChange } = renderField(c.now)
      screen.getByTestId('elsewhere').focus()
      pick('2026-12-24')
      expect(onPeriodChange).not.toHaveBeenCalled()
      expect(field().value).toBe(TODAY)
      pick(c.inNow)
      expect(field().value).toBe(TODAY)
    })
  })
})

describe('the words of the field (AC-4.6)', () => {
  it('are the period’s own: "Show the week of" on a week, "Show the month of" on a month', () => {
    const { rerender } = render(<PeriodDateField period={WEEK.now} today={TODAY} onPeriodChange={vi.fn()} />)
    expect(screen.getByLabelText('Show the week of')).toBe(field())
    rerender(<PeriodDateField period={MONTH.now} today={TODAY} onPeriodChange={vi.fn()} />)
    expect(screen.getByLabelText('Show the month of')).toBe(field())
    expect(screen.queryByLabelText('Show the week of')).toBeNull()
  })

  it('keep the one description for both periods, and it is not part of either period’s words', () => {
    expect(Object.keys(strings.table.week.pick)).toEqual(['label'])
    expect(Object.keys(strings.table.month.pick)).toEqual(['label'])
    expect(Object.keys(strings.table.pick)).toEqual(['hint'])
  })
})
