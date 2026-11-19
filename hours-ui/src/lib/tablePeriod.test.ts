/**
 * tablePeriod — what differs by period in the table view of My hours, for the week (specs/20261116-record-hours-in-place
 * T18, T20; plan § `TablePeriod`, decisions 8, 9 and 12; AC-5.3, AC-5.4, AC-5.5, AC-5.28, AC-5.29). Pure arithmetic on `YYYY-MM-DD`: "today" is
 * passed in (`todayZurich()` in the app), never read here, so each case names its day. The boundary days are the ones the
 * plan names: Sunday 1 November 2026 (the last day of a week that is mostly October), the week Monday 30 November –
 * Sunday 6 December 2026 (it straddles two months) and Tuesday 1 September 2026 (a week that begins in August).
 */
import { describe, expect, it } from 'vitest'
import {
  clamp,
  current,
  daysOf,
  firstDayOf,
  hasNext,
  hasPrevious,
  holding,
  isCurrent,
  lastDayOf,
  pickBounds,
  pickedPeriod,
  periodKey,
  referenceDay,
  shift,
  switchTo,
} from './tablePeriod'
import type { TablePeriod } from './tablePeriod'
import { MIN_DAY } from './period'
import { weekDays } from './week'

const week = (monday: string): TablePeriod => ({ kind: 'week', monday })
const month = (key: string): TablePeriod => ({ kind: 'month', month: key })

// 2026-11-01 is a Sunday, 2026-11-30 a Monday, 2026-09-01 a Tuesday.
const SUNDAY_1_NOV = '2026-11-01'
const MONDAY_30_NOV = '2026-11-30'
const TUESDAY_1_SEP = '2026-09-01'

describe('holding: the week a day is in, whichever day of it that is (AC-5.4)', () => {
  it('is the Monday of the week, for a Monday, a middle day and a Sunday', () => {
    expect(holding('week', MONDAY_30_NOV)).toEqual(week('2026-11-30'))
    expect(holding('week', '2026-12-02')).toEqual(week('2026-11-30'))
    expect(holding('week', '2026-12-06')).toEqual(week('2026-11-30'))
  })

  it('puts Sunday 1 November 2026 in the week that began on Monday 26 October', () => {
    expect(holding('week', SUNDAY_1_NOV)).toEqual(week('2026-10-26'))
  })

  it('puts Tuesday 1 September 2026 in the week that began on Monday 31 August', () => {
    expect(holding('week', TUESDAY_1_SEP)).toEqual(week('2026-08-31'))
  })

  it('refuses text that is not a day: a caller bug, never a week', () => {
    expect(() => holding('week', '2026-02-30')).toThrow(TypeError)
    expect(() => holding('week', '')).toThrow(TypeError)
  })
})

describe('daysOf, firstDayOf, lastDayOf: the days a week reads (AC-5.3, AC-5.4)', () => {
  it('is seven days, Monday to Sunday, the first and the last being the period`s span', () => {
    const days = daysOf(week('2026-11-16'))
    expect(days).toEqual([
      '2026-11-16',
      '2026-11-17',
      '2026-11-18',
      '2026-11-19',
      '2026-11-20',
      '2026-11-21',
      '2026-11-22',
    ])
    expect(firstDayOf(week('2026-11-16'))).toBe('2026-11-16')
    expect(lastDayOf(week('2026-11-16'))).toBe('2026-11-22')
  })

  it('runs from Monday 30 November into December without a gap, the Sunday being the 6th', () => {
    expect(daysOf(week(MONDAY_30_NOV))).toEqual([
      '2026-11-30',
      '2026-12-01',
      '2026-12-02',
      '2026-12-03',
      '2026-12-04',
      '2026-12-05',
      '2026-12-06',
    ])
    expect(firstDayOf(week(MONDAY_30_NOV))).toBe('2026-11-30')
    expect(lastDayOf(week(MONDAY_30_NOV))).toBe('2026-12-06')
  })

  it('ends on Sunday 1 November 2026 for the week before it, which began in October', () => {
    expect(firstDayOf(week('2026-10-26'))).toBe('2026-10-26')
    expect(lastDayOf(week('2026-10-26'))).toBe(SUNDAY_1_NOV)
  })

  it('is the days `week.ts` gives, so the read, the fold and the columns agree on one week', () => {
    expect(daysOf(week('2026-08-31'))).toEqual(weekDays('2026-08-31'))
  })

  it('refuses a "monday" that is not a Monday: the span it would read is not the week that was named', () => {
    const wednesday = week('2026-11-18')
    expect(() => daysOf(wednesday)).toThrow(TypeError)
    expect(() => firstDayOf(wednesday)).toThrow(TypeError)
    expect(() => lastDayOf(wednesday)).toThrow(TypeError)
  })
})

describe('current and isCurrent: the week holding today (AC-5.4, AC-5.5)', () => {
  it('is the week holding today, for today a Monday, a Sunday and a Tuesday', () => {
    expect(current('week', MONDAY_30_NOV)).toEqual(week('2026-11-30'))
    expect(current('week', SUNDAY_1_NOV)).toEqual(week('2026-10-26'))
    expect(current('week', TUESDAY_1_SEP)).toEqual(week('2026-08-31'))
  })

  it('knows every day of the week holding today, the Monday and the Sunday included, and no day of its neighbours', () => {
    const shown = week('2026-11-30')
    expect(isCurrent(shown, '2026-11-30')).toBe(true)
    expect(isCurrent(shown, '2026-12-03')).toBe(true)
    expect(isCurrent(shown, '2026-12-06')).toBe(true)
    expect(isCurrent(shown, '2026-11-29')).toBe(false)
    expect(isCurrent(shown, '2026-12-07')).toBe(false)
  })

  it('reads a week that holds only a day of last month as the current one when today is that day', () => {
    // Sunday 1 November: the week of Monday 26 October is the one in progress, not the week of Monday 2 November.
    expect(isCurrent(week('2026-10-26'), SUNDAY_1_NOV)).toBe(true)
    expect(isCurrent(week('2026-11-02'), SUNDAY_1_NOV)).toBe(false)
  })

  it('refuses a period that is not a week, and a today that is not a day: caller bugs', () => {
    expect(() => isCurrent(week('2026-11-18'), SUNDAY_1_NOV)).toThrow(TypeError)
    expect(() => isCurrent(week('2026-11-16'), 'today')).toThrow(TypeError)
    expect(() => current('week', '')).toThrow(TypeError)
  })
})

describe('shift: the previous and the next week (AC-5.5)', () => {
  it('moves a whole number of weeks, back and forth, from the week shown and not from today', () => {
    expect(shift(week('2026-11-16'), 1)).toEqual(week('2026-11-23'))
    expect(shift(week('2026-11-16'), -1)).toEqual(week('2026-11-09'))
    expect(shift(week('2026-11-16'), 3)).toEqual(week('2026-12-07'))
    expect(shift(week('2026-11-16'), 0)).toEqual(week('2026-11-16'))
  })

  it('crosses a month, from the week that straddles two, and a year', () => {
    expect(shift(week(MONDAY_30_NOV), 1)).toEqual(week('2026-12-07'))
    expect(shift(week(MONDAY_30_NOV), -1)).toEqual(week('2026-11-23'))
    expect(shift(week('2026-12-28'), 1)).toEqual(week('2027-01-04'))
    expect(shift(week('2027-01-04'), -1)).toEqual(week('2026-12-28'))
  })

  it('steps over the week that ends on Sunday 1 November 2026 and the one that begins in August', () => {
    expect(shift(week('2026-10-26'), 1)).toEqual(week('2026-11-02'))
    expect(shift(week('2026-08-31'), -1)).toEqual(week('2026-08-24'))
  })

  it('does not touch the period it was given', () => {
    const shown = week('2026-11-16')
    shift(shown, 1)
    expect(shown).toEqual(week('2026-11-16'))
  })

  it('refuses a fraction of a week and a period that is not a week: caller bugs', () => {
    expect(() => shift(week('2026-11-16'), 0.5)).toThrow(TypeError)
    expect(() => shift(week('2026-11-18'), 1)).toThrow(TypeError)
  })
})

describe('referenceDay: the day the date field shows for a week (AC-5.30, plan § `TablePeriod`)', () => {
  it('is today in the current week, whichever day of it today is', () => {
    expect(referenceDay(week('2026-11-30'), '2026-12-02')).toBe('2026-12-02')
    expect(referenceDay(week('2026-11-30'), MONDAY_30_NOV)).toBe(MONDAY_30_NOV)
    expect(referenceDay(week('2026-10-26'), SUNDAY_1_NOV)).toBe(SUNDAY_1_NOV)
  })

  it('is the Monday of any other week: a past one is shown by its first day', () => {
    expect(referenceDay(week('2026-11-23'), '2026-12-02')).toBe('2026-11-23')
    expect(referenceDay(week('2026-08-24'), TUESDAY_1_SEP)).toBe('2026-08-24')
    expect(referenceDay(week('2026-10-26'), '2026-11-02')).toBe('2026-10-26')
  })

  it('is today again for the week that begins in August once today is its Tuesday 1 September', () => {
    expect(referenceDay(week('2026-08-31'), TUESDAY_1_SEP)).toBe(TUESDAY_1_SEP)
  })
})

describe('hasNext: the next week exists only while the week shown is before the current one (AC-5.5, AC-5.28)', () => {
  it('is false in the current week, whichever day of it today is', () => {
    expect(hasNext(week('2026-11-30'), MONDAY_30_NOV)).toBe(false)
    expect(hasNext(week('2026-11-30'), '2026-12-02')).toBe(false)
    expect(hasNext(week('2026-11-30'), '2026-12-06')).toBe(false)
    expect(hasNext(week('2026-10-26'), SUNDAY_1_NOV)).toBe(false)
  })

  it('is true in any week before the current one, the week just before it included', () => {
    expect(hasNext(week('2026-11-23'), '2026-12-02')).toBe(true)
    expect(hasNext(week('2026-10-26'), '2026-11-02')).toBe(true)
    expect(hasNext(week('2026-08-24'), TUESDAY_1_SEP)).toBe(true)
    expect(hasNext(week('2000-01-03'), '2026-11-18')).toBe(true)
  })

  it('is false in a week after the current one, which no address can show (AC-5.29)', () => {
    expect(hasNext(week('2026-12-07'), '2026-12-02')).toBe(false)
    expect(hasNext(week('9999-12-20'), '2026-11-18')).toBe(false)
  })

  it('moves with today: the week that was current yesterday has a next the day the new week begins', () => {
    expect(hasNext(week('2026-11-23'), '2026-11-29')).toBe(false) // a Sunday
    expect(hasNext(week('2026-11-23'), '2026-11-30')).toBe(true) // the Monday after
  })

  it('refuses a period that is not a week, and a today that is not a day: caller bugs', () => {
    expect(() => hasNext(week('2026-11-18'), SUNDAY_1_NOV)).toThrow(TypeError)
    expect(() => hasNext(week('2026-11-16'), 'today')).toThrow(TypeError)
  })
})

describe('hasPrevious: the previous week exists down to the first day hours-api takes (plan decision 12)', () => {
  it('is true while the week before begins on or after 2000-01-01', () => {
    expect(hasPrevious(week('2026-11-16'))).toBe(true)
    expect(hasPrevious(week('2000-01-10'))).toBe(true) // the week before is Monday 3 January 2000
  })

  it('is false on the first week an address accepts: Monday 3 January 2000, whose week before began in 1999', () => {
    // 2000-01-01 is a Saturday: the week holding it began on Monday 27 December 1999, before the floor, so the first Monday
    // an address accepts is 3 January 2000 (`readWeekParam`).
    expect(hasPrevious(week('2000-01-03'))).toBe(false)
  })

  it('refuses a period that is not a week: a caller bug', () => {
    expect(() => hasPrevious(week('2026-11-18'))).toThrow(TypeError)
  })
})

describe('clamp: a period after the current one is the current one (AC-5.29)', () => {
  it('leaves the current week and every week before it as they are', () => {
    expect(clamp(week('2026-11-30'), '2026-12-02')).toEqual(week('2026-11-30'))
    expect(clamp(week('2026-11-23'), '2026-12-02')).toEqual(week('2026-11-23'))
    expect(clamp(week('2000-01-03'), '2026-12-02')).toEqual(week('2000-01-03'))
  })

  it('gives the current week for the next one, for a week long after, and at the end of the calendar', () => {
    expect(clamp(week('2026-12-07'), '2026-12-02')).toEqual(week('2026-11-30'))
    expect(clamp(week('2027-06-07'), '2026-12-02')).toEqual(week('2026-11-30'))
    expect(clamp(week('9999-12-20'), '2026-12-02')).toEqual(week('2026-11-30'))
  })

  it('moves with today: a Sunday still holds the week that began six days before, the Monday after does not', () => {
    expect(clamp(week('2026-11-30'), '2026-11-29')).toEqual(week('2026-11-23'))
    expect(clamp(week('2026-11-30'), '2026-11-30')).toEqual(week('2026-11-30'))
  })

  it('does not touch the period it was given', () => {
    const shown = week('2026-12-07')
    clamp(shown, '2026-12-02')
    expect(shown).toEqual(week('2026-12-07'))
  })

  it('refuses a period that is not a week, and a today that is not a day: caller bugs', () => {
    expect(() => clamp(week('2026-11-18'), '2026-12-02')).toThrow(TypeError)
    expect(() => clamp(week('2026-11-16'), 'today')).toThrow(TypeError)
  })
})

describe('the month: the days it reads and the month holding a day (AC-5.25, AC-5.30)', () => {
  it('holds a day in its own calendar month, the first and the last included', () => {
    expect(holding('month', '2026-11-01')).toEqual(month('2026-11'))
    expect(holding('month', '2026-11-19')).toEqual(month('2026-11'))
    expect(holding('month', '2026-11-30')).toEqual(month('2026-11'))
    expect(holding('month', '2026-12-01')).toEqual(month('2026-12'))
  })

  it('refuses text that is not a day: a caller bug, never a month', () => {
    expect(() => holding('month', '2026-02-30')).toThrow(TypeError)
    expect(() => holding('month', '2026-11')).toThrow(TypeError)
  })

  it.each([
    ['February 2026', '2026-02', 28],
    ['February 2028', '2028-02', 29],
    ['November 2026, which begins on a Sunday', '2026-11', 30],
    ['December 2026', '2026-12', 31],
  ])('%s is read from its 1st to its last day, every day between: %s (%i days)', (_name, key, count) => {
    const days = daysOf(month(key))
    expect(days).toHaveLength(count)
    expect(firstDayOf(month(key))).toBe(`${key}-01`)
    expect(lastDayOf(month(key))).toBe(days.at(-1))
    expect(lastDayOf(month(key))).toBe(`${key}-${String(count).padStart(2, '0')}`)
    expect(new Set(days).size).toBe(count)
  })

  it('is the month`s own days, none of the next, so one read and one fold agree on the span', () => {
    expect(daysOf(month('2026-11'))[0]).toBe('2026-11-01')
    expect(daysOf(month('2026-11')).at(-1)).toBe('2026-11-30')
    expect(daysOf(month('2026-11'))).not.toContain('2026-12-01')
  })

  it('refuses a month that is not one: a caller bug, so a span it did not name is never read', () => {
    expect(() => daysOf(month('2026-13'))).toThrow(TypeError)
    expect(() => firstDayOf(month('2026-1'))).toThrow(TypeError)
    expect(() => lastDayOf(month(''))).toThrow(TypeError)
  })
})

describe('the month: current, isCurrent and shift (AC-5.5, AC-5.28)', () => {
  it('the current month is the one holding today, for today the 1st, the last day and a Sunday', () => {
    expect(current('month', '2026-11-01')).toEqual(month('2026-11'))
    expect(current('month', '2026-11-30')).toEqual(month('2026-11'))
    expect(current('month', '2026-12-02')).toEqual(month('2026-12'))
  })

  it('knows every day of the month holding today, and no day of its neighbours', () => {
    expect(isCurrent(month('2026-12'), '2026-12-01')).toBe(true)
    expect(isCurrent(month('2026-12'), '2026-12-31')).toBe(true)
    expect(isCurrent(month('2026-12'), '2026-11-30')).toBe(false)
    expect(isCurrent(month('2026-11'), '2026-12-01')).toBe(false)
  })

  it('shifts by the calendar: December to January and back, from the month shown and not from today', () => {
    expect(shift(month('2026-11'), 1)).toEqual(month('2026-12'))
    expect(shift(month('2026-11'), -1)).toEqual(month('2026-10'))
    expect(shift(month('2026-12'), 1)).toEqual(month('2027-01'))
    expect(shift(month('2027-01'), -1)).toEqual(month('2026-12'))
    expect(shift(month('2026-03'), -1)).toEqual(month('2026-02'))
    expect(shift(month('2026-11'), 0)).toEqual(month('2026-11'))
  })

  it('refuses a fraction of a month and a month that is not one: caller bugs', () => {
    expect(() => shift(month('2026-11'), 0.5)).toThrow(TypeError)
    expect(() => shift(month('2026-13'), 1)).toThrow(TypeError)
  })

  it('does not touch the period it was given', () => {
    const shown = month('2026-11')
    shift(shown, 1)
    expect(shown).toEqual(month('2026-11'))
  })
})

describe('the month: hasNext, hasPrevious and clamp (AC-5.28, AC-5.29, plan decision 12)', () => {
  it('has no next month on the current one, whichever day of it today is, and one on any month before it', () => {
    expect(hasNext(month('2026-12'), '2026-12-01')).toBe(false)
    expect(hasNext(month('2026-12'), '2026-12-31')).toBe(false)
    expect(hasNext(month('2026-11'), '2026-12-01')).toBe(true)
    expect(hasNext(month('2000-01'), '2026-12-02')).toBe(true)
  })

  it('has no next month after the current one, which no address can show', () => {
    expect(hasNext(month('2027-01'), '2026-12-02')).toBe(false)
    expect(hasNext(month('9999-12'), '2026-12-02')).toBe(false)
  })

  it('moves with today: the month that was current yesterday has a next the day the new month begins', () => {
    expect(hasNext(month('2026-11'), '2026-11-30')).toBe(false)
    expect(hasNext(month('2026-11'), '2026-12-01')).toBe(true)
  })

  it('has a previous month down to the first one hours-api answers for: January 2000 has none', () => {
    expect(hasPrevious(month('2026-11'))).toBe(true)
    expect(hasPrevious(month('2000-02'))).toBe(true)
    expect(hasPrevious(month('2000-01'))).toBe(false)
  })

  it('clamps a month after the current one to the current one, and leaves the rest', () => {
    expect(clamp(month('2026-12'), '2026-12-02')).toEqual(month('2026-12'))
    expect(clamp(month('2026-10'), '2026-12-02')).toEqual(month('2026-10'))
    expect(clamp(month('2027-01'), '2026-12-02')).toEqual(month('2026-12'))
    expect(clamp(month('9999-12'), '2026-12-02')).toEqual(month('2026-12'))
    expect(clamp(month('2026-12'), '2026-11-30')).toEqual(month('2026-11'))
  })
})

describe('referenceDay on a month: the day the date field shows (AC-5.30)', () => {
  it('is today in the current month and the 1st of any other', () => {
    expect(referenceDay(month('2026-12'), '2026-12-02')).toBe('2026-12-02')
    expect(referenceDay(month('2026-11'), '2026-12-02')).toBe('2026-11-01')
    expect(referenceDay(month('2026-12'), '2026-12-01')).toBe('2026-12-01')
  })
})

describe('periodKey: one key for a period, never shown, so a kind and a day cannot be mistaken for each other', () => {
  it('names the kind and the week’s Monday or the month', () => {
    expect(periodKey(week('2026-11-16'))).toBe('week:2026-11-16')
    expect(periodKey(month('2026-11'))).toBe('month:2026-11')
  })

  it('differs between a week and the month that begins on its Monday', () => {
    expect(periodKey(week('2026-06-01'))).not.toBe(periodKey(month('2026-06')))
  })

  it('refuses a period that is not one: a caller bug', () => {
    expect(() => periodKey(week('2026-11-18'))).toThrow(TypeError)
    expect(() => periodKey(month('2026-13'))).toThrow(TypeError)
  })
})

describe('switchTo, week to month: the month in view (AC-5.26, D25)', () => {
  it('is the month holding the Monday of a past week that is inside one month', () => {
    expect(switchTo(week('2026-11-09'), 'month', '2026-11-19')).toEqual(month('2026-11'))
    expect(switchTo(week('2026-11-02'), 'month', '2026-12-02')).toEqual(month('2026-11'))
  })

  it('is the current month from the current week, also when the week straddles two months (D25)', () => {
    // Monday 30 November – Sunday 6 December 2026, today Wednesday 2 December: December, the month holding today.
    expect(switchTo(week('2026-11-30'), 'month', '2026-12-02')).toEqual(month('2026-12'))
    expect(switchTo(week('2026-11-30'), 'month', '2026-11-30')).toEqual(month('2026-11'))
    expect(switchTo(week('2026-11-30'), 'month', '2026-12-06')).toEqual(month('2026-12'))
  })

  it('is the month of the Monday from that same week once it is a past week: November, today Wednesday 9 December', () => {
    expect(switchTo(week('2026-11-30'), 'month', '2026-12-09')).toEqual(month('2026-11'))
  })

  it('is today`s month from the current week that ends on Sunday 1 November, and October from it once it is past', () => {
    expect(switchTo(week('2026-10-26'), 'month', '2026-11-01')).toEqual(month('2026-11'))
    expect(switchTo(week('2026-10-26'), 'month', '2026-11-02')).toEqual(month('2026-10'))
  })

  it('is the month of a week that begins in August, Tuesday 1 September being today: September from the current week, August once past', () => {
    expect(switchTo(week('2026-08-31'), 'month', '2026-09-01')).toEqual(month('2026-09'))
    expect(switchTo(week('2026-08-31'), 'month', '2026-09-08')).toEqual(month('2026-08'))
  })

  it('never gives a month after the current one', () => {
    for (const monday of ['2026-11-30', '2026-11-23', '2026-10-26', '2000-01-03']) {
      const shown = switchTo(week(monday), 'month', '2026-12-02')
      expect(firstDayOf(shown) <= '2026-12-02', monday).toBe(true)
    }
  })

  it('stays where it is when the kind is the kind shown', () => {
    const shown = week('2026-11-16')
    expect(switchTo(shown, 'week', '2026-11-19')).toBe(shown)
    const shownMonth = month('2026-10')
    expect(switchTo(shownMonth, 'month', '2026-11-19')).toBe(shownMonth)
  })
})

describe('switchTo, month to week: the week left, else the current week, else the first one that begins in the month (AC-5.27, D26)', () => {
  it('is the week left when it has a day in the month: Monday 12 – Sunday 18 October 2026, and Monday 28 September – Sunday 4 October', () => {
    expect(switchTo(month('2026-10'), 'week', '2026-12-02', '2026-10-12')).toEqual(week('2026-10-12'))
    expect(switchTo(month('2026-10'), 'week', '2026-12-02', '2026-09-28')).toEqual(week('2026-09-28'))
  })

  it('counts a week as in the month when any of its seven days is, the last one or the first one included', () => {
    // Monday 26 October – Sunday 1 November: November holds only its Sunday.
    expect(switchTo(month('2026-11'), 'week', '2026-12-02', '2026-10-26')).toEqual(week('2026-10-26'))
    // Monday 30 November – Sunday 6 December: November holds only its Monday.
    expect(switchTo(month('2026-11'), 'week', '2026-12-09', '2026-11-30')).toEqual(week('2026-11-30'))
  })

  it('goes round: week, month, week lands on the week left, for a past week, a week that straddles and the current week', () => {
    for (const [monday, today] of [
      ['2026-10-12', '2026-12-02'],
      ['2026-11-30', '2026-12-09'],
      ['2026-10-26', '2026-12-02'],
      ['2026-11-30', '2026-12-02'],
      ['2026-11-16', '2026-11-19'],
    ] as const) {
      const shownMonth = switchTo(week(monday), 'month', today)
      expect(switchTo(shownMonth, 'week', today, monday), `${monday} on ${today}`).toEqual(week(monday))
    }
  })

  it('is the current week when the week left has no day in the month, and the current week has one', () => {
    // The month before the current one, reached from a week long past; the current week Monday 26 October – Sunday 1
    // November 2026 reaches into October.
    expect(switchTo(month('2026-10'), 'week', '2026-11-01', '2026-03-02')).toEqual(week('2026-10-26'))
    // No week left in the address at all: the current week stands for it.
    expect(switchTo(month('2026-10'), 'week', '2026-11-01')).toEqual(week('2026-10-26'))
    expect(switchTo(month('2026-11'), 'week', '2026-11-19')).toEqual(week('2026-11-16'))
  })

  it('is the current week from the current month, whichever week was left, and with none left', () => {
    expect(switchTo(month('2026-11'), 'week', '2026-11-19', '2026-09-07')).toEqual(week('2026-11-16'))
    expect(switchTo(month('2026-12'), 'week', '2026-12-02')).toEqual(week('2026-11-30'))
  })

  it('is the first week whose Monday is in the month when neither has a day in it: Monday 2 November, not Monday 26 October', () => {
    // November 2026 begins on a Sunday: the week holding the 1st is mostly October.
    expect(switchTo(month('2026-11'), 'week', '2026-12-09', '2026-03-02')).toEqual(week('2026-11-02'))
    expect(switchTo(month('2026-11'), 'week', '2026-12-09')).toEqual(week('2026-11-02'))
    // September 2026 begins on a Tuesday: its first Monday is the 7th.
    expect(switchTo(month('2026-09'), 'week', '2026-12-02', '2026-03-02')).toEqual(week('2026-09-07'))
    // A month that begins on a Monday: that Monday.
    expect(switchTo(month('2026-06'), 'week', '2026-12-02')).toEqual(week('2026-06-01'))
  })

  it('never gives a week after the current one: a week left that is after it is not the week left', () => {
    // Next week, Monday 7 December, has December days, but is not shown: the current week is.
    expect(switchTo(month('2026-12'), 'week', '2026-12-02', '2026-12-07')).toEqual(week('2026-11-30'))
  })

  it('refuses a week left that is not a Monday: a caller bug', () => {
    expect(() => switchTo(month('2026-10'), 'week', '2026-12-02', '2026-10-14')).toThrow(TypeError)
  })

  it('always gives a week that has a day in the month, and never a month it was not asked for', () => {
    for (const key of ['2026-02', '2026-09', '2026-10', '2026-11', '2027-01']) {
      const shown = switchTo(month(key), 'week', '2027-01-20')
      expect(shown.kind).toBe('week')
      const days = daysOf(shown)
      expect(
        days.some((day) => day.startsWith(key)),
        key,
      ).toBe(true)
    }
  })
})

describe('pickBounds: the days the period date field offers (AC-5.31, D20)', () => {
  it('offers no day after today, for the week and for the month', () => {
    expect(pickBounds('week', '2026-11-19').max).toBe('2026-11-19')
    expect(pickBounds('month', '2026-11-19').max).toBe('2026-11-19')
    // Sunday 1 November 2026 and the 1st of a month are today like any other day.
    expect(pickBounds('week', SUNDAY_1_NOV).max).toBe(SUNDAY_1_NOV)
    expect(pickBounds('month', TUESDAY_1_SEP).max).toBe(TUESDAY_1_SEP)
  })

  it('starts the week at the first Monday on or after the floor, 2000-01-03, and the month at the floor’s month, 2000-01-01', () => {
    expect(pickBounds('week', '2026-11-19').min).toBe('2000-01-03')
    expect(pickBounds('month', '2026-11-19').min).toBe('2000-01-01')
  })

  it('names a first day whose period begins on or after the floor, and no earlier day does', () => {
    // 2000-01-01 is a Saturday: its week begins on 1999-12-27, before the floor hours-api answers for, so the week's
    // `min` is the next Monday; the month of the floor begins on the floor. A day below `min` would name a period the
    // address would refuse (the current one shown instead).
    for (const kind of ['week', 'month'] as const) {
      const { min } = pickBounds(kind, '2026-11-19')
      expect(firstDayOf(holding(kind, min)) >= MIN_DAY, `${kind}: min is in a period on or after the floor`).toBe(true)
      expect(hasPrevious(holding(kind, min)), `${kind}: min is in the first period`).toBe(false)
      const before = new Date(Date.parse(`${min}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10)
      expect(
        firstDayOf(holding(kind, before)) < MIN_DAY,
        `${kind}: the day before min is in a period that begins before the floor`,
      ).toBe(true)
    }
  })

  it('moves only `max` with today: the floor is the same on any day', () => {
    expect(pickBounds('week', '2027-03-10').min).toBe('2000-01-03')
    expect(pickBounds('month', '2027-03-10').min).toBe('2000-01-01')
  })

  it('treats a today that is not a day as a caller bug', () => {
    expect(() => pickBounds('week', '2026-11')).toThrow(TypeError)
    expect(() => pickBounds('month', 'today')).toThrow(TypeError)
  })
})

describe('pickedPeriod: only a complete day within the bounds names a period (AC-5.30, AC-5.31, R16)', () => {
  const TODAY = '2026-11-19'

  it('is the week or the month holding a complete day within the bounds', () => {
    expect(pickedPeriod('week', '2026-10-14', TODAY)).toEqual(week('2026-10-12'))
    expect(pickedPeriod('month', '2026-10-14', TODAY)).toEqual(month('2026-10'))
    // A Sunday belongs to the week that began six days before; the 1st and the last day to their own month.
    expect(pickedPeriod('week', SUNDAY_1_NOV, TODAY)).toEqual(week('2026-10-26'))
    expect(pickedPeriod('month', SUNDAY_1_NOV, TODAY)).toEqual(month('2026-11'))
    expect(pickedPeriod('month', '2026-10-31', TODAY)).toEqual(month('2026-10'))
  })

  it('accepts today and the floor, the two ends of the bounds', () => {
    expect(pickedPeriod('week', TODAY, TODAY)).toEqual(week('2026-11-16'))
    expect(pickedPeriod('month', TODAY, TODAY)).toEqual(month('2026-11'))
    expect(pickedPeriod('week', '2000-01-03', TODAY)).toEqual(week('2000-01-03'))
    expect(pickedPeriod('month', '2000-01-01', TODAY)).toEqual(month('2000-01'))
  })

  it('names nothing for an emptied value, which is what a date input holds until its date is complete', () => {
    expect(pickedPeriod('week', '', TODAY)).toBeNull()
    expect(pickedPeriod('month', '', TODAY)).toBeNull()
  })

  it('names nothing for a day after today, tomorrow and the far future alike (AC-5.31)', () => {
    expect(pickedPeriod('week', '2026-11-20', TODAY)).toBeNull()
    expect(pickedPeriod('month', '2026-11-20', TODAY)).toBeNull()
    expect(pickedPeriod('week', '2027-01-01', TODAY)).toBeNull()
    expect(pickedPeriod('month', '9999-12-31', TODAY)).toBeNull()
  })

  it('names nothing for a day before the first the period offers: the floor’s Saturday for a week, a day before the floor for a month', () => {
    expect(pickedPeriod('week', '2000-01-02', TODAY)).toBeNull()
    expect(pickedPeriod('week', '2000-01-01', TODAY)).toBeNull()
    expect(pickedPeriod('month', '1999-12-31', TODAY)).toBeNull()
    // The month offers the floor itself, which a week does not.
    expect(pickedPeriod('month', '2000-01-01', TODAY)).toEqual(month('2000-01'))
  })

  it('names nothing for the intermediate days of a date typed digit by digit: the years 0002, 0020 and 0202 are below the floor', () => {
    for (const day of ['0002-11-19', '0020-11-19', '0202-11-19']) {
      expect(pickedPeriod('week', day, TODAY), day).toBeNull()
      expect(pickedPeriod('month', day, TODAY), day).toBeNull()
    }
    // … and 2026 is the first of them to be a day worth showing.
    expect(pickedPeriod('week', '2026-11-19', TODAY)).toEqual(week('2026-11-16'))
  })

  it('names nothing for a year of more than four digits, which a date input also holds', () => {
    for (const day of ['20260-11-19', '10000-01-01', '275760-09-13']) {
      expect(pickedPeriod('week', day, TODAY), day).toBeNull()
      expect(pickedPeriod('month', day, TODAY), day).toBeNull()
    }
  })

  it('names nothing for text that is not a real day, and does not throw on it', () => {
    for (const text of [
      '2026-02-30',
      '2026-13-01',
      '2026-11-00',
      '2026-11',
      '2026-1-5',
      '19.11.2026',
      'garbage',
      ' 2026-11-19',
      '2026-11-19 ',
    ]) {
      expect(() => pickedPeriod('week', text, TODAY), text).not.toThrow()
      expect(pickedPeriod('week', text, TODAY), text).toBeNull()
      expect(pickedPeriod('month', text, TODAY), text).toBeNull()
    }
  })

  it('treats a today that is not a day as a caller bug, not as a reason to name nothing', () => {
    expect(() => pickedPeriod('week', '2026-10-14', 'today')).toThrow(TypeError)
    expect(() => pickedPeriod('month', '2026-10-14', '2026-11')).toThrow(TypeError)
  })

  it('moves the upper bound with today: a day that is the future on one day is the past on the next', () => {
    expect(pickedPeriod('week', '2026-11-20', '2026-11-19')).toBeNull()
    expect(pickedPeriod('week', '2026-11-20', '2026-11-20')).toEqual(week('2026-11-16'))
  })
})
