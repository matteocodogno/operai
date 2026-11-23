import { describe, expect, it } from 'vitest'
import { formatDuration } from '@operai/ui'
import { readDuration } from './duration'

/**
 * `readDuration` reads what a person types into the entry dialog's Duration (specs/20261112-time-tracking
 * T45; design S2 as amended, ledger D53; AC-1.2). It never rounds: a value that is not whole 30-minute steps
 * from 30 minutes to 24 hours is refused, and hours-api stays the authority.
 */
describe('readDuration: what it reads', () => {
  it.each([
    // [typed, minutes, the form]
    ['2:30', 150, 'h:mm'],
    ['0:30', 30, 'h:mm with no hours'],
    ['2:00', 120, 'h:mm on the hour'],
    ['02:30', 150, 'h:mm with a leading zero'],
    ['24:00', 1440, 'the longest entry as h:mm'],
    ['2,5', 150, 'decimal hours with a comma'],
    ['2.5', 150, 'decimal hours with a point'],
    ['0,5', 30, 'half an hour'],
    ['2,50', 150, 'a trailing zero changes nothing'],
    ['8', 480, 'whole hours'],
    ['24', 1440, 'the longest entry as whole hours'],
    ['2h30', 150, 'hours and minutes, joined'],
    ['2h 30', 150, 'hours and minutes, one space'],
    ['2 h 30', 150, "hours and minutes as the app's own short display"],
    ['2 h', 120, "whole hours as the app's own short display"],
    ['2h', 120, 'whole hours with an h'],
    ['0h30', 30, 'hours and minutes with no hours'],
    ['90m', 90, 'minutes alone, joined'],
    ['90 min', 90, 'minutes alone with a space'],
    ['30 min', 30, "minutes alone as the app's own short display"],
    ['1440m', 1440, 'the longest entry as minutes'],
    ['2h30m', 150, 'hours and minutes, each with its unit'],
    ['1h 30min', 90, 'hours and minutes, the minutes with their short unit'],
    ['1 h 30 min', 90, 'hours and minutes, spaced, both with units'],
    ['2 : 30', 150, 'h:mm with spaces around the colon'],
  ])('%s is %i minutes (%s)', (typed, minutes) => {
    expect(readDuration(typed)).toEqual({ ok: true, minutes })
  })

  it('trims the text and does not mind the case', () => {
    expect(readDuration('  2:30  ')).toEqual({ ok: true, minutes: 150 })
    expect(readDuration('\t2,5\n')).toEqual({ ok: true, minutes: 150 })
    expect(readDuration('2H30')).toEqual({ ok: true, minutes: 150 })
    expect(readDuration('2 H')).toEqual({ ok: true, minutes: 120 })
    expect(readDuration('90 MIN')).toEqual({ ok: true, minutes: 90 })
    expect(readDuration('90M')).toEqual({ ok: true, minutes: 90 })
  })

  it('reads back what the app shows for every duration an entry can have', () => {
    for (let minutes = 30; minutes <= 1440; minutes += 30) {
      const shown = formatDuration(minutes * 60_000, { style: 'short' })
      expect(readDuration(shown), shown).toEqual({ ok: true, minutes })
    }
  })
})

describe('readDuration: what it refuses, and why', () => {
  it.each([
    // [typed, the problem, why]
    ['2:15', 'steps', 'h:mm off the half hour'],
    ['2,25', 'steps', 'decimal hours off the half hour'],
    ['2.75', 'steps', 'decimal hours off the half hour with a point'],
    ['2,333', 'steps', 'a fraction that is no number of minutes'],
    ['2,50000000000000001', 'steps', 'too close to half an hour to be told apart by a float'],
    ['2h15', 'steps', 'hours and minutes off the half hour'],
    ['2 h 05', 'steps', 'a padded minute that is no half hour'],
    ['100m', 'steps', 'minutes off the half hour'],
    ['45m', 'steps', 'minutes off the half hour, inside the range'],
    ['0', 'range', 'nothing is not an entry'],
    ['0:00', 'range', 'nothing as h:mm'],
    ['0m', 'range', 'nothing as minutes'],
    ['0h', 'range', 'nothing as hours'],
    ['24:30', 'range', 'past the day, on the half hour'],
    ['25', 'range', 'past the day in hours'],
    ['1441m', 'range', 'one minute past the day'],
    ['100:00', 'range', 'a hundred hours'],
    ['99999999999999999999999', 'range', 'a number too large to hold'],
    ['0:15', 'range', 'under 30 minutes (the range is said before the steps)'],
    ['10m', 'range', 'under 30 minutes in minutes'],
    ['0,25', 'range', 'under 30 minutes in decimal hours'],
    ['abc', 'unreadable', 'not a duration'],
    ['2:75', 'unreadable', 'minutes of an hour only go to 59'],
    ['2h75', 'unreadable', 'minutes of an hour only go to 59, with an h'],
    ['2h5', 'steps', 'a one-digit minute is read (2 h 05), and refused for its steps'],
    ['2:5', 'unreadable', 'h:mm takes two digits of minutes'],
    ['2:', 'unreadable', 'h:mm cut short'],
    [':30', 'unreadable', 'h:mm with no hours'],
    ['2:30:00', 'unreadable', 'a clock time with seconds'],
    ['-1', 'unreadable', 'a sign is no part of a duration'],
    ['-2:30', 'unreadable', 'a sign before h:mm'],
    ['+2', 'unreadable', 'a sign is no part of a duration'],
    ['', 'unreadable', 'nothing typed'],
    ['   ', 'unreadable', 'only spaces'],
    ['2,5,5', 'unreadable', 'two separators'],
    ['2,', 'unreadable', 'a separator and no digits'],
    [',5', 'unreadable', 'a separator and no hours'],
    ['1e2', 'unreadable', 'an exponent'],
    ['2 30', 'unreadable', 'two numbers with nothing between them'],
    ['2h30x', 'unreadable', 'a unit after the minutes this field does not read'],
    ['2h5h', 'unreadable', 'two hour units'],
    ['2 hours', 'unreadable', 'a word this field does not read'],
    ['٢:٣٠', 'unreadable', 'digits of another script'],
  ])('%j is refused as %s (%s)', (typed, problem) => {
    expect(readDuration(typed)).toEqual({ ok: false, problem })
  })
})
