/**
 * month — the calendar arithmetic of the table view's month (specs/20261116-record-hours-in-place T22; plan § Components,
 * § The address of My hours; AC-5.25, AC-5.29): the days of a calendar month, the month holding a day, the month before
 * and after, and the month an address names. Pure arithmetic on `YYYY-MM` and `YYYY-MM-DD`: "today" is passed in, never
 * read. The boundary months are the plan's: February 2026 (28 days) and 2028 (29), November 2026 (30 days, begins on a
 * Sunday), December 2026 (31) and the turn of a year.
 */
import { describe, expect, it } from 'vitest'
import {
  MIN_MONTH,
  monthDays,
  monthFirstDay,
  monthLastDay,
  monthOf,
  parseMonth,
  readMonthParam,
  shiftMonth,
} from './month'

const TODAY = '2026-11-19'

describe('monthOf: the month a day is in (AC-5.30)', () => {
  it('is the YYYY-MM of the day, for the first day, a middle day and the last', () => {
    expect(monthOf('2026-11-01')).toBe('2026-11')
    expect(monthOf('2026-11-19')).toBe('2026-11')
    expect(monthOf('2026-11-30')).toBe('2026-11')
    expect(monthOf('2026-12-01')).toBe('2026-12')
  })

  it('puts 29 February in its leap year’s month', () => {
    expect(monthOf('2028-02-29')).toBe('2028-02')
  })

  it('refuses text that is not a day: a caller bug, never a month', () => {
    expect(() => monthOf('2026-02-30')).toThrow(TypeError)
    expect(() => monthOf('2026-11')).toThrow(TypeError)
    expect(() => monthOf('')).toThrow(TypeError)
  })
})

describe('monthDays: every day of a calendar month, first to last (AC-5.25)', () => {
  it.each([
    ['February 2026', '2026-02', 28],
    ['February 2028 (a leap year)', '2028-02', 29],
    ['November 2026', '2026-11', 30],
    ['December 2026', '2026-12', 31],
    ['February 2100 (not a leap year)', '2100-02', 28],
  ])('%s (%s) has %i days', (_name, month, count) => {
    const days = monthDays(month)
    expect(days).toHaveLength(count)
    expect(days[0]).toBe(`${month}-01`)
    expect(days.at(-1)).toBe(`${month}-${String(count).padStart(2, '0')}`)
  })

  it('is consecutive, ascending, and every day belongs to the month', () => {
    const days = monthDays('2026-12')
    days.forEach((day, index) => {
      expect(day).toBe(`2026-12-${String(index + 1).padStart(2, '0')}`)
      expect(monthOf(day)).toBe('2026-12')
    })
  })

  it('gives the first and the last day without building the list', () => {
    expect(monthFirstDay('2026-11')).toBe('2026-11-01')
    expect(monthLastDay('2026-11')).toBe('2026-11-30')
    expect(monthLastDay('2028-02')).toBe('2028-02-29')
    expect(monthLastDay('2026-12')).toBe('2026-12-31')
  })

  it('refuses a month that is not written YYYY-MM: a caller bug', () => {
    for (const bad of ['2026-1', '2026-13', '2026-00', '2026-11-05', '202611', '', ' 2026-11']) {
      expect(() => monthDays(bad), bad).toThrow(TypeError)
      expect(() => monthFirstDay(bad), bad).toThrow(TypeError)
      expect(() => monthLastDay(bad), bad).toThrow(TypeError)
    }
  })

  it('refuses a month before the year 100, which no date format here can write: a RangeError', () => {
    expect(() => monthDays('0050-01')).toThrow(RangeError)
  })
})

describe('shiftMonth: the previous and the next month, by the calendar (AC-5.5)', () => {
  it('moves a whole number of months, from the month given', () => {
    expect(shiftMonth('2026-11', 1)).toBe('2026-12')
    expect(shiftMonth('2026-11', -1)).toBe('2026-10')
    expect(shiftMonth('2026-11', 3)).toBe('2027-02')
    expect(shiftMonth('2026-11', -11)).toBe('2025-12')
    expect(shiftMonth('2026-11', 0)).toBe('2026-11')
  })

  it('crosses a year: December to January and January to December', () => {
    expect(shiftMonth('2026-12', 1)).toBe('2027-01')
    expect(shiftMonth('2027-01', -1)).toBe('2026-12')
    expect(shiftMonth('2026-01', -1)).toBe('2025-12')
  })

  it('steps through months of 31, 30 and 28 or 29 days without skipping or repeating one', () => {
    let month = '2026-03'
    const seen: string[] = []
    for (let step = 0; step < 4; step += 1) {
      seen.push(month)
      month = shiftMonth(month, 1)
    }
    expect(seen).toEqual(['2026-03', '2026-04', '2026-05', '2026-06'])
    expect(shiftMonth('2026-03', -1)).toBe('2026-02')
    expect(shiftMonth('2028-03', -1)).toBe('2028-02')
  })

  it('refuses a month that is not one, and a fractional number of months: caller bugs', () => {
    expect(() => shiftMonth('2026-13', 1)).toThrow(TypeError)
    expect(() => shiftMonth('2026-11', 1.5)).toThrow(TypeError)
    expect(() => shiftMonth('2026-11', Number.NaN)).toThrow(TypeError)
  })

  it('refuses a month outside the calendar the format writes (before the year 100, after 9999): a RangeError', () => {
    expect(() => shiftMonth('0100-01', -1)).toThrow(RangeError)
    expect(() => shiftMonth('9999-12', 1)).toThrow(RangeError)
  })
})

describe('parseMonth: a YYYY-MM and nothing else', () => {
  it('is the text when it is written YYYY-MM with a month from 01 to 12', () => {
    expect(parseMonth('2026-10')).toBe('2026-10')
    expect(parseMonth('2000-01')).toBe('2000-01')
    expect(parseMonth('9999-12')).toBe('9999-12')
  })

  it.each([
    '2026-1',
    '2026-00',
    '2026-13',
    '2026-11-05',
    '202611',
    '',
    ' 2026-11',
    '2026-11 ',
    'nope',
    202611,
    null,
    undefined,
    ['2026-11'],
    { m: '2026-11' },
  ])('is null for %j', (text) => {
    expect(parseMonth(text)).toBeNull()
  })
})

describe('readMonthParam: the month an address names (AC-5.2, AC-5.29)', () => {
  it('is the month named, from its first month to the current one', () => {
    expect(readMonthParam({ month: '2026-10' }, TODAY)).toBe('2026-10')
    expect(readMonthParam({ month: '2026-11' }, TODAY)).toBe('2026-11')
    expect(readMonthParam({ month: MIN_MONTH }, TODAY)).toBe('2000-01')
  })

  it('is the current month when the address names none', () => {
    expect(readMonthParam({}, TODAY)).toBe('2026-11')
    expect(readMonthParam({ view: 'month' }, TODAY)).toBe('2026-11')
  })

  it('is the current month, not a later one, when the address names a month after it (AC-5.29)', () => {
    expect(readMonthParam({ month: '2026-12' }, TODAY)).toBe('2026-11')
    expect(readMonthParam({ month: '2027-01' }, TODAY)).toBe('2026-11')
    expect(readMonthParam({ month: '9999-12' }, TODAY)).toBe('2026-11')
  })

  it('counts the month that begins today as the current one: the first of the month and the last day of the year', () => {
    expect(readMonthParam({ month: '2026-12' }, '2026-12-01')).toBe('2026-12')
    expect(readMonthParam({ month: '2027-01' }, '2026-12-31')).toBe('2026-12')
  })

  it('is the current month for a month before the first one hours-api answers for', () => {
    expect(readMonthParam({ month: '1999-12' }, TODAY)).toBe('2026-11')
    expect(readMonthParam({ month: '0001-01' }, TODAY)).toBe('2026-11')
  })

  it.each([
    '2026-1',
    '2026-00',
    '2026-13',
    '2026-11-05',
    '202611',
    '',
    ' 2026-11',
    'nope',
    202611,
    null,
    ['2026-10'],
    { month: '2026-10' },
  ])(
    'is the current month for a month that is not a YYYY-MM (%j): a pasted link never reaches the API as a refused request',
    (named) => {
      expect(readMonthParam({ month: named }, TODAY)).toBe('2026-11')
    },
  )

  it('refuses a "today" that is not a day: a caller bug', () => {
    expect(() => readMonthParam({}, '2026-11')).toThrow(TypeError)
    expect(() => readMonthParam({}, 'today')).toThrow(TypeError)
  })

  it('does not change the object it is given', () => {
    const search = { month: '2027-01', view: 'month' }
    readMonthParam(search, TODAY)
    expect(search).toEqual({ month: '2027-01', view: 'month' })
  })
})
