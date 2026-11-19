/**
 * todayZurich — "today" for hours: the calendar day in Europe/Zurich, as `YYYY-MM-DD`
 * (plan § Sequences, AC-1.3). It is the rule hours-api applies to `future_day`, so the Day
 * field's `max` and the period presets agree with the server. It is neither the UTC date
 * nor the machine's: `Intl` is given the zone explicitly, so a laptop set to another zone
 * (or a CI runner on UTC) gets the same answer.
 *
 * The server stays the authority: this only keeps the form from offering a day the server
 * would refuse. `now` is a parameter so a test can name the instant.
 */
const ZURICH_DAY = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Europe/Zurich',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

export const todayZurich = (now: Date = new Date()): string => {
  const part = (type: 'year' | 'month' | 'day') => ZURICH_DAY.formatToParts(now).find((p) => p.type === type)?.value
  return `${part('year')}-${part('month')}-${part('day')}`
}
