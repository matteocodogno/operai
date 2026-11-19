import { afterEach, describe, expect, it, vi } from 'vitest'
import { todayZurich } from './todayZurich'

/**
 * "Today" is the calendar day in Europe/Zurich (plan § Sequences, AC-1.3), the same rule the server
 * applies to `future_day`. It is neither the UTC date nor the machine's: a person in Zurich who
 * records hours at 00:30 local time on the 13th is on the 13th while UTC still says the 12th.
 */
describe('todayZurich', () => {
  afterEach(() => vi.useRealTimers())

  it.each([
    // [instant (UTC), the Zurich day, why]
    ['2026-11-12T12:00:00Z', '2026-11-12', 'midday'],
    ['2026-11-12T22:59:59Z', '2026-11-12', 'the last second of the 12th in winter (UTC+1)'],
    ['2026-11-12T23:00:00Z', '2026-11-13', 'midnight in Zurich in winter, still the 12th in UTC'],
    ['2026-11-12T23:30:00Z', '2026-11-13', 'half past midnight in Zurich in winter'],
    ['2026-07-12T21:59:59Z', '2026-07-12', 'the last second of the 12th in summer (UTC+2)'],
    ['2026-07-12T22:00:00Z', '2026-07-13', 'midnight in Zurich in summer'],
    ['2026-12-31T23:00:00Z', '2027-01-01', 'across the new year'],
  ])('%s is %s in Zurich (%s)', (instant, day) => {
    expect(todayZurich(new Date(instant))).toBe(day)
  })

  it('follows the clock changes of 2026 (29 March forward, 25 October back)', () => {
    // Forward: at 01:00 UTC on 29 March Zurich moves from UTC+1 to UTC+2, so midnight of the 30th is 22:00 UTC.
    expect(todayZurich(new Date('2026-03-28T22:59:59Z'))).toBe('2026-03-28')
    expect(todayZurich(new Date('2026-03-28T23:00:00Z'))).toBe('2026-03-29')
    expect(todayZurich(new Date('2026-03-29T21:59:59Z'))).toBe('2026-03-29')
    expect(todayZurich(new Date('2026-03-29T22:00:00Z'))).toBe('2026-03-30')
    // Back: at 01:00 UTC on 25 October Zurich returns to UTC+1, so midnight of the 26th is 23:00 UTC.
    expect(todayZurich(new Date('2026-10-24T21:59:59Z'))).toBe('2026-10-24')
    expect(todayZurich(new Date('2026-10-24T22:00:00Z'))).toBe('2026-10-25')
    expect(todayZurich(new Date('2026-10-25T22:59:59Z'))).toBe('2026-10-25')
    expect(todayZurich(new Date('2026-10-25T23:00:00Z'))).toBe('2026-10-26')
  })

  it('reads the clock when no instant is given', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-12T23:30:00Z'))
    expect(todayZurich()).toBe('2026-11-13')
  })

  it('does not depend on the machine time zone', () => {
    const before = process.env['TZ']
    try {
      process.env['TZ'] = 'America/Los_Angeles'
      expect(todayZurich(new Date('2026-11-12T23:30:00Z'))).toBe('2026-11-13')
      process.env['TZ'] = 'Pacific/Auckland'
      expect(todayZurich(new Date('2026-11-12T12:00:00Z'))).toBe('2026-11-12')
    } finally {
      if (before === undefined) delete process.env['TZ']
      else process.env['TZ'] = before
    }
  })

  it('always answers YYYY-MM-DD, zero-padded', () => {
    expect(todayZurich(new Date('2026-01-05T10:00:00Z'))).toBe('2026-01-05')
  })
})
