/**
 * The rules of the entry dialog's Day (specs/029-time-tracking T27; plan § Entries "A day", amendment 4 of
 * 2026-11-13; AC-1.3). The dialog's own tests prove the field shows the error; this pins the rule itself on
 * strings a browser's date field would never hand over, so the rule holds whatever fills `day`.
 */
import { describe, expect, it } from 'vitest'
import { strings } from '../strings'
import { EARLIEST_DAY, emptyValues, isRealDay, ruleError } from './EntryDialogModel'

const TODAY = '2026-11-13'
const dayError = (day: string) => ruleError('day', { ...emptyValues(TODAY), day }, { today: TODAY, categories: [] })

describe('isRealDay: exactly YYYY-MM-DD, and a day the calendar has', () => {
  it.each(['2026-11-13', '2000-01-01', '2028-02-29', '2026-12-31', '9999-12-31'])('%s is a real day', (day) => {
    expect(isRealDay(day)).toBe(true)
  })

  it.each([
    '', // nothing
    '2026-02-30', // Bun and a browser roll it over to 2 March
    '2025-02-29', // not a leap year
    '2026-04-31',
    '2026-13-01',
    '2026-00-10',
    '2026-11-00',
    '2026-2-01', // not zero-padded
    '2026-11-13T00:00:00Z', // an instant, not a day
    ' 2026-11-13',
    '2026/11/13',
    '٢٠٢٦-١١-١٣', // digits that are not ASCII
    '0000-01-01', // Postgres refuses it
    '0050-01-01', // Date.UTC reads the year as 1950
    '275760-09-13', // the browser's own ceiling, six digits
  ])('%j is not', (day) => {
    expect(isRealDay(day)).toBe(false)
  })
})

describe('the Day rule (plan § Entries "A day"; AC-1.3)', () => {
  it('asks for a day when there is none', () => {
    expect(dayError('')).toBe(strings.entry.errors.dayRequired)
  })

  it('refuses what is not a day on the calendar, whatever year it names', () => {
    expect(dayError('2026-02-30')).toBe(strings.entry.errors.dayInvalid)
    expect(dayError('0000-01-01')).toBe(strings.entry.errors.dayInvalid)
    expect(dayError('0050-01-01')).toBe(strings.entry.errors.dayInvalid)
    expect(dayError('2026-11-13T00:00:00Z')).toBe(strings.entry.errors.dayInvalid)
  })

  it('refuses a real day before 01.01.2000, naming the day it cannot be before', () => {
    expect(EARLIEST_DAY).toBe('2000-01-01')
    expect(dayError('1999-12-31')).toBe(strings.entry.errors.dayTooEarly('01.01.2000'))
    expect(dayError('0226-11-13')).toBe(strings.entry.errors.dayTooEarly('01.01.2000'))
    expect(strings.entry.errors.dayTooEarly('01.01.2000')).toContain('01.01.2000')
  })

  it('takes 01.01.2000 itself, and any real day up to today', () => {
    expect(dayError('2000-01-01')).toBeUndefined()
    expect(dayError('2026-11-12')).toBeUndefined()
    expect(dayError(TODAY)).toBeUndefined()
  })

  it('a real day after today is the future-day error: the server’s 422 `future_day` says the same', () => {
    expect(dayError('2026-11-14')).toBe(strings.entry.errors.dayFuture)
    expect(dayError('9999-12-31')).toBe(strings.entry.errors.dayFuture)
  })
})
