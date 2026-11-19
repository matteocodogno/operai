/**
 * Reading a duration the person typed (specs/20261112-time-tracking T45; design S2 as amended, ledger D53;
 * AC-1.2). A pure function, so the entry dialog and its tests share one reading.
 *
 * It reads, after trimming and whatever the case:
 *
 *   `2:30` `0:30` `24:00`       hours and minutes, the minutes always two digits (00–59)
 *   `2,5` `2.5` `8`              hours, with a comma or a point
 *   `2h30` `2h 30` `2 h 30` `2 h`   hours and minutes as the app itself shows them (`formatDuration`, short), so
 *                                the value an edited entry opens with reads back
 *   `90m` `90 min`               minutes alone
 *
 * It never rounds. What it reads must be a whole number of 30-minute steps from 30 minutes to 24 hours
 * (AC-1.2), or it says which rule the value breaks. hours-api stays the authority (422 `invalid_minutes`): this
 * only saves the person the round trip and says it in their words.
 */

/** The shortest and the longest entry, and the step between them (AC-1.2), in minutes: hours-api's own rule. */
const MIN_MINUTES = 30
const MAX_MINUTES = 24 * 60
const STEP_MINUTES = 30

/**
 * Why a value is refused: `unreadable` (none of the forms above, nothing typed included), `range` (outside
 * 30 minutes … 24 hours) or `steps` (inside it, but not whole 30-minute steps). A value that breaks both is
 * `range`: the limits are the more useful thing to be told.
 */
export type DurationProblem = 'unreadable' | 'range' | 'steps'

export type DurationReading = { ok: true; minutes: number } | { ok: false; problem: DurationProblem }

/**
 * What the text says, before the limits: `exact` is false for decimal hours that are not a whole number of
 * minutes' worth of half hours (`2,25`, `2,333`). Those are never turned into minutes by a float, which
 * would let `2,50000000000000001` pass as 2 h 30: they are only ever refused, and `minutes` is then
 * an approximation good enough to tell which side of the limits they fall on.
 */
type Said = { minutes: number; exact: boolean }

const CLOCK = /^(\d+):(\d{2})$/
const HOURS_AND_MINUTES = /^(\d+)\s*h\s*(\d{2})?$/
const MINUTES = /^(\d+)\s*m(?:in)?$/
const HOURS = /^(\d+)(?:[.,](\d+))?$/

const MINUTES_IN_HOUR = 60

const said = (text: string): Said | null => {
  const clock = CLOCK.exec(text) ?? HOURS_AND_MINUTES.exec(text)
  if (clock) {
    const minutes = Number(clock[2] ?? '0')
    // 2:75 is no time of an hour: it is not read as 3:15.
    return minutes < MINUTES_IN_HOUR ? { minutes: Number(clock[1]) * MINUTES_IN_HOUR + minutes, exact: true } : null
  }

  const alone = MINUTES.exec(text)
  if (alone) return { minutes: Number(alone[1]), exact: true }

  const hours = HOURS.exec(text)
  if (hours) {
    const whole = Number(hours[1]) * MINUTES_IN_HOUR
    const fraction = (hours[2] ?? '').replace(/0+$/, '')
    if (fraction === '') return { minutes: whole, exact: true }
    if (fraction === '5') return { minutes: whole + MINUTES_IN_HOUR / 2, exact: true }
    return { minutes: Number(`${hours[1]}.${fraction}`) * MINUTES_IN_HOUR, exact: false }
  }
  return null
}

export const readDuration = (text: string): DurationReading => {
  const reading = said(text.trim().toLowerCase())
  if (reading === null) return { ok: false, problem: 'unreadable' }
  const { minutes, exact } = reading
  if (!(minutes >= MIN_MINUTES && minutes <= MAX_MINUTES)) return { ok: false, problem: 'range' }
  if (!exact || minutes % STEP_MINUTES !== 0) return { ok: false, problem: 'steps' }
  return { ok: true, minutes }
}
