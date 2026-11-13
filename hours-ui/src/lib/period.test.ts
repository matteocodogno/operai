/**
 * The Period filter's arithmetic (specs/029-time-tracking T24, AC-4.4; design S1 "Period"): the presets
 * as `from`/`to`, weeks starting on Monday, and the Custom range's two rules (To not before From, at
 * most 366 days). Dates are `YYYY-MM-DD` and the arithmetic is on calendar days, so no time zone or
 * daylight-saving change can move a boundary.
 */
import { describe, expect, it } from 'vitest'
import { PERIODS, presetRange, rangeErrors, rangeOf, spanDays } from './period'

// 2026-11-13 is a Friday: its week is Monday 9 – Sunday 15 November.
const FRIDAY = '2026-11-13'

describe('presetRange: the preset periods as from/to (AC-4.4)', () => {
  it('This week runs Monday to Sunday around today', () => {
    expect(presetRange('thisWeek', FRIDAY)).toEqual({ from: '2026-11-09', to: '2026-11-15' })
  })

  it('weeks start on Monday: on a Sunday the week is the one that ends today, on a Monday the one that starts', () => {
    expect(presetRange('thisWeek', '2026-11-15')).toEqual({ from: '2026-11-09', to: '2026-11-15' })
    expect(presetRange('thisWeek', '2026-11-09')).toEqual({ from: '2026-11-09', to: '2026-11-15' })
    expect(presetRange('thisWeek', '2026-11-16')).toEqual({ from: '2026-11-16', to: '2026-11-22' })
  })

  it('Last week is the Monday-to-Sunday week before', () => {
    expect(presetRange('lastWeek', FRIDAY)).toEqual({ from: '2026-11-02', to: '2026-11-08' })
  })

  it('a week can straddle a month and a year', () => {
    expect(presetRange('thisWeek', '2026-12-31')).toEqual({ from: '2026-12-28', to: '2027-01-03' })
    expect(presetRange('lastWeek', '2027-01-04')).toEqual({ from: '2026-12-28', to: '2027-01-03' })
  })

  it('This month and Last month are whole calendar months', () => {
    expect(presetRange('thisMonth', FRIDAY)).toEqual({ from: '2026-11-01', to: '2026-11-30' })
    expect(presetRange('lastMonth', FRIDAY)).toEqual({ from: '2026-10-01', to: '2026-10-31' })
  })

  it('the month lengths are right: February in a leap year and in a common one, a 31-day month', () => {
    expect(presetRange('thisMonth', '2028-02-10')).toEqual({ from: '2028-02-01', to: '2028-02-29' })
    expect(presetRange('thisMonth', '2026-02-10')).toEqual({ from: '2026-02-01', to: '2026-02-28' })
    expect(presetRange('lastMonth', '2026-03-05')).toEqual({ from: '2026-02-01', to: '2026-02-28' })
    expect(presetRange('thisMonth', '2026-12-31')).toEqual({ from: '2026-12-01', to: '2026-12-31' })
  })

  it('Last month in January is December of the year before', () => {
    expect(presetRange('lastMonth', '2027-01-15')).toEqual({ from: '2026-12-01', to: '2026-12-31' })
  })

  it('This year is 1 January to 31 December', () => {
    expect(presetRange('thisYear', FRIDAY)).toEqual({ from: '2026-01-01', to: '2026-12-31' })
  })

  it('every preset, in a leap year too, is a span the server accepts (366 days at most)', () => {
    for (const today of ['2026-11-13', '2028-02-29', '2028-12-31']) {
      for (const period of PERIODS.filter((p) => p !== 'custom')) {
        const { from, to } = presetRange(period, today)
        expect(spanDays(from, to), `${period} on ${today}`).toBeLessThanOrEqual(366)
      }
    }
    expect(spanDays('2028-01-01', '2028-12-31')).toBe(366)
  })
})

describe('spanDays', () => {
  it('counts the days of a range, both ends included', () => {
    expect(spanDays('2026-11-13', '2026-11-13')).toBe(1)
    expect(spanDays('2026-11-01', '2026-11-30')).toBe(30)
    expect(spanDays('2026-02-28', '2026-03-01')).toBe(2)
  })
})

describe('rangeErrors: the Custom range (AC-4.4: nothing is sent while it is invalid)', () => {
  it('a range with To on or after From, up to 366 days, has no error', () => {
    expect(rangeErrors('2026-11-01', '2026-11-30')).toEqual({})
    expect(rangeErrors('2026-11-13', '2026-11-13')).toEqual({})
    expect(rangeErrors('2025-11-13', '2026-11-13')).toEqual({}) // 366 days, both ends counted
  })

  it('To before From is an error on To', () => {
    expect(rangeErrors('2026-11-13', '2026-11-12')).toEqual({ to: 'before-from' })
  })

  it('over 366 days is an error on To', () => {
    expect(rangeErrors('2025-11-12', '2026-11-13')).toEqual({ to: 'too-long' }) // 367 days
    expect(rangeErrors('2020-01-01', '2026-11-13')).toEqual({ to: 'too-long' })
  })

  it('an empty or malformed date is required, each on its own field', () => {
    expect(rangeErrors('', '2026-11-13')).toEqual({ from: 'required' })
    expect(rangeErrors('2026-11-13', '')).toEqual({ to: 'required' })
    expect(rangeErrors('', '')).toEqual({ from: 'required', to: 'required' })
    expect(rangeErrors('13.11.2026', '2026-11-13')).toEqual({ from: 'required' })
  })

  it('a date that is not on the calendar is not a date (30 February)', () => {
    expect(rangeErrors('2026-02-30', '2026-03-05')).toEqual({ from: 'required' })
  })
})

describe('rangeOf: the range a view sends, or none', () => {
  it('a preset is its range, whatever from and to hold', () => {
    expect(rangeOf('lastWeek', 'junk', '', FRIDAY)).toEqual({
      range: { from: '2026-11-02', to: '2026-11-08' },
      errors: {},
    })
  })

  it('Custom is the typed range when it is valid', () => {
    expect(rangeOf('custom', '2026-10-05', '2026-10-09', FRIDAY)).toEqual({
      range: { from: '2026-10-05', to: '2026-10-09' },
      errors: {},
    })
  })

  it('Custom with an error has no range, so nothing can be sent', () => {
    expect(rangeOf('custom', '2026-10-09', '2026-10-05', FRIDAY)).toEqual({
      range: null,
      errors: { to: 'before-from' },
    })
  })
})
