import { describe, expect, it, vi } from 'vitest'
import { formatDate, formatDateTime, todayIsoDate } from './dates'

describe('formatDate', () => {
  // These used to assert only `toContain('2026')`, because the output was
  // toLocaleDateString(undefined, …) and therefore differed per machine — the
  // loose assertions were the tell. The format is fixed now, so they can say
  // exactly what a CH/IT reader should see.
  it('formats a bare ISO date as DD.MM.YYYY', () => {
    expect(formatDate('2026-08-11')).toBe('11.08.2026')
  })

  it('zero-pads single-digit days and months', () => {
    expect(formatDate('2021-01-31')).toBe('31.01.2021')
    expect(formatDate('2026-01-05')).toBe('05.01.2026')
  })

  // The whole point of the change: one screen previously showed a raw ISO
  // line date next to a US-long rate date. Both shapes must now converge.
  it('renders a date-only value and a timestamp in the SAME shape', () => {
    expect(formatDate('2026-08-11')).toBe('11.08.2026')
    expect(formatDate('2026-08-11T10:00:00.000Z')).toMatch(/^\d{2}\.\d{2}\.\d{4}$/)
  })

  // A date-only value must never be shifted by the viewer's timezone.
  // `new Date('2026-08-11')` is UTC midnight, so an implementation that parses
  // it shows 10.08.2026 anywhere west of UTC. CH/IT and CI are at or east of
  // UTC, where that bug is invisible — so asserting the formatted output would
  // pass here while being broken for anyone travelling.
  //
  // Asserting the INVARIANT instead: the date-only path must not construct a
  // Date at all. Making the constructor throw proves it TZ-independently,
  // where reassigning process.env.TZ mid-run would have proved nothing (Node
  // reads it once at startup).
  it('never constructs a Date for a date-only value, so no timezone can shift it', () => {
    const RealDate = globalThis.Date
    vi.stubGlobal(
      'Date',
      class {
        constructor() {
          throw new Error('formatDate must not parse a date-only value')
        }
      },
    )
    try {
      expect(formatDate('2026-08-11')).toBe('11.08.2026')
    } finally {
      vi.stubGlobal('Date', RealDate)
    }
  })

  it('never emits a month name — the format is all-numeric', () => {
    expect(formatDate('2021-01-31')).not.toMatch(/[A-Za-z]/)
  })

  it('returns "—" for an unparseable input', () => {
    expect(formatDate('not-a-date')).toBe('—')
  })
})

describe('formatDateTime', () => {
  it('formats a timestamp as DD.MM.YYYY, HH:mm with the same date shape as formatDate', () => {
    const result = formatDateTime('2026-07-16T10:30:00.000Z')
    expect(result).toMatch(/^\d{2}\.\d{2}\.\d{4}, \d{2}:\d{2}$/)
    expect(result.split(',')[0]).toBe(formatDate('2026-07-16T10:30:00.000Z'))
  })

  // 24-hour, not a locale-derived 12-hour clock — AM/PM is exactly the
  // ambiguity this audience does not use.
  it('uses a 24-hour clock with no AM/PM marker', () => {
    expect(formatDateTime('2026-07-16T22:05:00.000Z')).not.toMatch(/[AaPp]\.?[Mm]/)
  })

  it('returns "—" for an unparseable input', () => {
    expect(formatDateTime('not-a-date')).toBe('—')
  })
})

describe('todayIsoDate', () => {
  it('returns a yyyy-mm-dd string matching the current date', () => {
    const result = todayIsoDate()
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    const now = new Date()
    expect(result).toBe(
      `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`,
    )
  })
})
