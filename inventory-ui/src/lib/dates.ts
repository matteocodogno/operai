/**
 * dates — display-formatting helpers (T25, specs/015-hardware-inventory),
 * re-authored from `refund-ui/src/lib/dates.ts` (ADR-0006: no cross-remote
 * imports) with identical behaviour, so one record reads the same characters in
 * every screen and in the sibling refund tool.
 *
 * inventory-api carries every date as ISO 8601 (CLAUDE.md); display formatting
 * is this file's concern. FORMAT: `DD.MM.YYYY`, fixed for every viewer — the
 * native civil format in both CH and IT, deterministic in tests, and never
 * derived from the viewer's browser locale.
 */

/** `2026-08-11` — a date with no time component, the shape refund-api sends for a line's `date`. */
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/

const pad2 = (value: number): string => String(value).padStart(2, '0')

/**
 * Formats an ISO 8601 date or timestamp as `DD.MM.YYYY`. Returns "—" for an
 * unparseable input.
 *
 * A DATE-ONLY input is formatted from its own characters and never goes near
 * `new Date`. That is load-bearing, not a shortcut: `new Date('2026-08-11')`
 * parses as UTC midnight, so any viewer west of UTC would have seen
 * `10.08.2026` for a line dated the 11th. CH/IT sit east of UTC so the old
 * code happened to be right for them — this makes it right by construction
 * rather than by the office's longitude, which matters the moment anyone
 * travels or the data is read from elsewhere.
 *
 * A full TIMESTAMP is parsed and rendered in the viewer's own timezone, which
 * is correct for the opposite reason: it records a moment in time, and "when
 * did this happen, for me" is the useful reading.
 */
export const formatDate = (iso: string): string => {
  const dateOnly = DATE_ONLY.exec(iso)
  if (dateOnly) {
    const [, year, month, day] = dateOnly
    return `${day}.${month}.${year}`
  }

  try {
    const parsed = new Date(iso)
    if (Number.isNaN(parsed.getTime())) return '—'
    return `${pad2(parsed.getDate())}.${pad2(parsed.getMonth() + 1)}.${parsed.getFullYear()}`
  } catch {
    return '—'
  }
}

/**
 * Formats an ISO 8601 timestamp as `DD.MM.YYYY, HH:mm` — for the places a bare
 * date is ambiguous (a batch cutoff, a generated-at/paid-at/discarded-at
 * stamp). 24-hour time, matching the date format's reasoning: it is the civil
 * convention in both CH and IT, and it removes the AM/PM ambiguity a
 * locale-derived 12-hour clock would reintroduce for exactly the audience this
 * is for. Returns "—" for an unparseable input, mirroring `formatDate`.
 */
export const formatDateTime = (iso: string): string => {
  try {
    const parsed = new Date(iso)
    if (Number.isNaN(parsed.getTime())) return '—'
    const date = `${pad2(parsed.getDate())}.${pad2(parsed.getMonth() + 1)}.${parsed.getFullYear()}`
    return `${date}, ${pad2(parsed.getHours())}:${pad2(parsed.getMinutes())}`
  } catch {
    return '—'
  }
}

/**
 * Today's date as a `yyyy-mm-dd` string — the default value for a new expense
 * line's Date field.
 *
 * Stays ISO deliberately: this feeds an `<input type="date">`, whose `value`
 * is defined by HTML to be `yyyy-mm-dd` regardless of what the browser shows
 * the user. It is a wire format, not a display one.
 */
export const todayIsoDate = (): string => {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}
