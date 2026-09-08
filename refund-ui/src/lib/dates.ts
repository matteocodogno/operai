/**
 * dates — display-formatting helpers for refund-ui (T16,
 * specs/007-refund-service/tasks.md). refund-api's contract carries every
 * timestamp as ISO 8601 (CLAUDE.md: "Dates and durations always in ISO 8601 in
 * API contracts; display formatting is a UI concern") — this file is that UI
 * concern's single home, so every screen formats dates identically rather than
 * re-deriving its own call.
 *
 * FORMAT: `DD.MM.YYYY`, fixed, for every viewer.
 *
 * Deliberately NOT `toLocaleDateString(undefined, …)`, which is what this
 * module used to do. That produced a different string per viewer's browser
 * locale — "Jan 31, 2021" on a US-locale machine — while other surfaces
 * printed the raw ISO `2026-08-11`, so one screen could show two date formats
 * at once, neither of which reads naturally to this product's audience.
 * wellD operates in Switzerland and Italy, where `DD.MM.YYYY` is the native
 * civil format in both markets and in both of the suite's target languages.
 * Pinning it also makes the output deterministic in tests and screenshots,
 * instead of depending on the machine that rendered them.
 *
 * A viewer-locale format is the wrong tool here for a second reason: these are
 * dates on a shared financial record. An employee in Italy and an accountant
 * in Switzerland discussing the same expense line should be reading the same
 * characters.
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
