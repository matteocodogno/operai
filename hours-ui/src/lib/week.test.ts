/**
 * The Week view's calendar arithmetic (specs/20261116-record-hours-in-place T8, T20; AC-5.3, AC-5.4, AC-5.5, AC-5.29; plan § My
 * hours' address). Weeks run Monday to Sunday, all seven days shown (WA1). Everything is arithmetic on days
 * written `YYYY-MM-DD`, in UTC on the date alone, so a time zone or a daylight-saving change cannot move a day;
 * "today" is passed in (`todayZurich()` in the app), never read here.
 */
import { describe, expect, it } from 'vitest'
import { MIN_DAY } from './period'
import { mondayOf, readWeekParam, shiftWeek, weekDays } from './week'

// 2026-11-16 is a Monday: its week is Monday 16 – Sunday 22 November.
const MONDAY = '2026-11-16'

describe('weekDays: the seven days of a week, Monday first (AC-5.3, WA1)', () => {
  it('is seven days, Monday to Sunday', () => {
    expect(weekDays(MONDAY)).toEqual([
      '2026-11-16',
      '2026-11-17',
      '2026-11-18',
      '2026-11-19',
      '2026-11-20',
      '2026-11-21',
      '2026-11-22',
    ])
  })

  it('crosses a month and a year without a gap', () => {
    expect(weekDays('2026-12-28')).toEqual([
      '2026-12-28',
      '2026-12-29',
      '2026-12-30',
      '2026-12-31',
      '2027-01-01',
      '2027-01-02',
      '2027-01-03',
    ])
    expect(weekDays('2028-02-28').slice(0, 3)).toEqual(['2028-02-28', '2028-02-29', '2028-03-01'])
  })

  it('has seven days over a daylight-saving change: the clock does not move a day', () => {
    // Europe/Zurich changes on Sunday 29 March and Sunday 25 October 2026.
    expect(weekDays('2026-03-23')).toHaveLength(7)
    expect(weekDays('2026-03-23')[6]).toBe('2026-03-29')
    expect(weekDays('2026-10-19')[6]).toBe('2026-10-25')
  })

  it('refuses a day that is not a Monday and text that is not a day: a caller bug, never a shifted week', () => {
    expect(() => weekDays('2026-11-18')).toThrow(TypeError) // a Wednesday
    expect(() => weekDays('2026-11-22')).toThrow(TypeError) // a Sunday
    expect(() => weekDays('2026-02-30')).toThrow(TypeError)
    expect(() => weekDays('')).toThrow(TypeError)
    expect(() => weekDays('16.11.2026')).toThrow(TypeError)
  })
})

describe('shiftWeek: the previous and the next week (AC-5.5)', () => {
  it('moves one week either way', () => {
    expect(shiftWeek(MONDAY, 1)).toBe('2026-11-23')
    expect(shiftWeek(MONDAY, -1)).toBe('2026-11-09')
  })

  it('crosses a month and a year, in both directions', () => {
    expect(shiftWeek('2026-11-23', 1)).toBe('2026-11-30')
    expect(shiftWeek('2026-11-30', 1)).toBe('2026-12-07')
    expect(shiftWeek('2026-12-21', 1)).toBe('2026-12-28')
    expect(shiftWeek('2026-12-28', 1)).toBe('2027-01-04')
    expect(shiftWeek('2027-01-04', -1)).toBe('2026-12-28')
    expect(shiftWeek('2026-11-02', -1)).toBe('2026-10-26')
    expect(shiftWeek('2028-02-28', 1)).toBe('2028-03-06') // 2028 is a leap year
    expect(shiftWeek('2026-02-23', 1)).toBe('2026-03-02')
  })

  it('stays on a Monday over a daylight-saving change', () => {
    expect(shiftWeek('2026-03-23', 1)).toBe('2026-03-30')
    expect(shiftWeek('2026-10-19', 1)).toBe('2026-10-26')
    expect(shiftWeek('2026-10-26', -1)).toBe('2026-10-19')
  })

  it('shifts by several weeks, and by none', () => {
    expect(shiftWeek(MONDAY, 5)).toBe('2026-12-21')
    expect(shiftWeek(MONDAY, -46)).toBe('2025-12-29')
    expect(shiftWeek(MONDAY, 0)).toBe(MONDAY)
  })

  it('refuses what is not a Monday, a whole number of weeks, or a week inside the calendar', () => {
    expect(() => shiftWeek('2026-11-18', 1)).toThrow(TypeError)
    expect(() => shiftWeek('2026-02-30', 1)).toThrow(TypeError)
    expect(() => shiftWeek(MONDAY, 0.5)).toThrow(TypeError)
    expect(() => shiftWeek(MONDAY, Number.NaN)).toThrow(TypeError)
    expect(() => shiftWeek('9999-12-27', 1)).toThrow(RangeError)
    expect(() => shiftWeek('0100-01-04', -1)).toThrow(RangeError) // a Monday of the year 100
  })
})

describe("readWeekParam: the week an address names (AC-5.4, AC-5.5; plan § My hours' address)", () => {
  // 2026-11-18 is a Wednesday: this week is Monday 16 – Sunday 22 November.
  const WEDNESDAY = '2026-11-18'

  it('is the Monday of this week when the address names none (AC-5.4)', () => {
    expect(readWeekParam({}, WEDNESDAY)).toBe(MONDAY)
  })

  it('is this Monday when today is a Monday, and the Monday before when today is a Sunday', () => {
    expect(readWeekParam({}, MONDAY)).toBe(MONDAY)
    expect(readWeekParam({}, '2026-11-22')).toBe(MONDAY)
    expect(readWeekParam({}, '2026-11-23')).toBe('2026-11-23')
  })

  it('is the Monday of the week holding the day it names, whichever day of the week that is (AC-5.5)', () => {
    expect(readWeekParam({ week: '2026-11-04' }, WEDNESDAY)).toBe('2026-11-02') // a Wednesday
    expect(readWeekParam({ week: '2026-11-02' }, WEDNESDAY)).toBe('2026-11-02') // the Monday itself
    expect(readWeekParam({ week: '2026-11-08' }, WEDNESDAY)).toBe('2026-11-02') // a Sunday
    expect(readWeekParam({ week: '2026-01-01' }, WEDNESDAY)).toBe('2025-12-29') // a week that begins in the year before
    expect(readWeekParam({ week: '2026-11-16' }, WEDNESDAY)).toBe(MONDAY) // this week's own Monday
    expect(readWeekParam({ week: '2026-11-22' }, WEDNESDAY)).toBe(MONDAY) // this week's Sunday
  })

  it('is this week for a week after it: the future is not shown, whichever day of that week the address names (AC-5.29)', () => {
    expect(readWeekParam({ week: '2026-11-23' }, WEDNESDAY)).toBe(MONDAY) // next week's Monday
    expect(readWeekParam({ week: '2026-11-25' }, WEDNESDAY)).toBe(MONDAY) // a day of next week
    expect(readWeekParam({ week: '2026-11-29' }, WEDNESDAY)).toBe(MONDAY) // next week's Sunday
    expect(readWeekParam({ week: '2027-01-01' }, WEDNESDAY)).toBe(MONDAY) // a week well after
    expect(readWeekParam({ week: '9999-12-26' }, WEDNESDAY)).toBe(MONDAY) // the last week the format holds
  })

  it('moves the line with today: a week is the future until its Monday has come, and next week is this week on that Monday', () => {
    expect(readWeekParam({ week: '2026-11-23' }, '2026-11-22')).toBe(MONDAY) // today is Sunday: 23 November is next week
    expect(readWeekParam({ week: '2026-11-23' }, '2026-11-23')).toBe('2026-11-23') // today is that Monday
  })

  it('ignores the other keys of the address', () => {
    expect(readWeekParam({ view: 'week', period: 'lastMonth', week: '2026-11-04' }, WEDNESDAY)).toBe('2026-11-02')
    expect(readWeekParam({ view: 'week', period: 'lastMonth' }, WEDNESDAY)).toBe(MONDAY)
  })

  it.each([
    ['empty', ''],
    ['text', 'garbage'],
    ['a day that is not on the calendar', '2026-02-30'],
    ['a month that does not exist', '2026-13-01'],
    ['a day without its zero', '2026-11-1'],
    ['a day without its dashes', '20261116'],
    ['a day with a time', '2026-11-16T00:00:00Z'],
    ['a day with a space', ' 2026-11-16'],
    ['a day written as the app shows it', '16.11.2026'],
    ['a number (the router reads a JSON-looking value)', 20261116],
    ['a boolean', true],
    ['null', null],
    ['undefined', undefined],
    ['a list', ['2026-11-25']],
    ['an object', { day: '2026-11-25' }],
  ])('is this week when the week is %s', (_why, week) => {
    expect(readWeekParam({ week }, WEDNESDAY)).toBe(MONDAY)
  })

  it('is this week for a week hours-api would refuse: before the first day it takes, or past the last year the format holds', () => {
    expect(MIN_DAY).toBe('2000-01-01')
    expect(readWeekParam({ week: '1999-12-31' }, WEDNESDAY)).toBe(MONDAY)
    // 2000-01-01 is a Saturday: its week begins on Monday 27 December 1999, before the floor.
    expect(readWeekParam({ week: '2000-01-01' }, WEDNESDAY)).toBe(MONDAY)
    expect(readWeekParam({ week: '2000-01-03' }, WEDNESDAY)).toBe('2000-01-03')
    expect(readWeekParam({ week: '0001-01-01' }, WEDNESDAY)).toBe(MONDAY)
    // 9999-12-31 is a Friday: its Sunday would be in the year 10000.
    expect(readWeekParam({ week: '9999-12-31' }, WEDNESDAY)).toBe(MONDAY)
    // The last whole week the format holds is in the future, so it is this week as well (AC-5.29).
    expect(readWeekParam({ week: '9999-12-26' }, WEDNESDAY)).toBe(MONDAY)
  })

  it('refuses a "today" that is not a day: a caller bug', () => {
    expect(() => readWeekParam({}, 'today')).toThrow(TypeError)
  })
})

describe('mondayOf: the Monday of the week holding a day (AC-5.4)', () => {
  it('is the same Monday for every day of the week, Sunday included', () => {
    for (const day of weekDays(MONDAY)) expect(mondayOf(day), day).toBe(MONDAY)
  })

  it('goes back across a month and a year', () => {
    expect(mondayOf('2026-12-01')).toBe('2026-11-30')
    expect(mondayOf('2027-01-01')).toBe('2026-12-28')
    expect(mondayOf('2028-03-01')).toBe('2028-02-28')
  })

  it('refuses text that is not a day on the calendar', () => {
    expect(() => mondayOf('2026-02-30')).toThrow(TypeError)
    expect(() => mondayOf('nope')).toThrow(TypeError)
  })
})
