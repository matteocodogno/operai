import { useId } from 'react'
import type { ReactNode } from 'react'
import { ListRows, formatDateLong } from '@operai/ui'
import type { TimeEntryView } from '../lib/hoursApi.types'
import { strings } from '../strings'
import EntryRow, { Duration } from './EntryRow'

export type EntryDayListProps = {
  /** The entries loaded so far, in the server's order (newest day first); days are never re-sorted. */
  entries: readonly TimeEntryView[]
  /**
   * What `groupBy=day` answered: day (`YYYY-MM-DD`) → minutes. A day with no figure here shows none: this
   * component never sums the rows it holds, which may be only part of a day (the rest is on the next page).
   * `null` while that read is loading or failed.
   */
  dayTotals: ReadonlyMap<string, number> | null
  /** Edit and Delete are offered only when the page gives a handler (the dialogs are T27 and T28). */
  onEdit?: (entry: TimeEntryView) => void
  onDelete?: (entry: TimeEntryView) => void
}

/** The entries grouped by day, each day once at the place its first entry came: the order stays the server's. */
const byDay = (entries: readonly TimeEntryView[]): { day: string; items: TimeEntryView[] }[] => {
  const days = new Map<string, TimeEntryView[]>()
  for (const entry of entries) {
    const items = days.get(entry.day)
    if (items) items.push(entry)
    else days.set(entry.day, [entry])
  }
  return [...days].map(([day, items]) => ({ day, items }))
}

/**
 * EntryDayList — the entries of My hours, one section per day (specs/20261112-time-tracking T25; design S1
 * "Entries"; AC-4.1). A day is a region named by its `h4` (`formatDateLong`) and carries the total the
 * server stated for it (`groupBy=day`), so a day whose entries straddle two pages shows its full total at
 * once; with no figure for it, it shows none. Nothing is computed here, and nothing marks a day as
 * incomplete (D23).
 *
 * A row is `EntryRow`'s (the Week's cell dialog draws the same one): the type, the name, the duration, the work type
 * or category, the activity, the deal a meeting's hours count for and the note, with Edit and Delete when the page
 * gives handlers.
 */
export default function EntryDayList({ entries, dayTotals, onEdit, onDelete }: EntryDayListProps): ReactNode {
  const idPrefix = useId()
  return (
    <div className="flex flex-col gap-5" data-testid="hours-day-list">
      {byDay(entries).map(({ day, items }) => {
        const headingId = `${idPrefix}-${day}`
        const total = dayTotals?.get(day)
        const date = formatDateLong(day)
        return (
          <section key={day} aria-labelledby={headingId} data-testid={`hours-day-${day}`}>
            <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <h4 id={headingId} className="text-sm font-medium text-text">
                {date}
              </h4>
              {total !== undefined && (
                <span className="flex items-baseline gap-2" data-testid={`hours-day-total-${day}`}>
                  <span className="text-xs text-soft">{strings.entries.dayTotal}</span>
                  <Duration minutes={total} />
                </span>
              )}
            </div>
            <ListRows label={strings.entries.dayList(date)}>
              {items.map((entry) => (
                <EntryRow key={entry.id} entry={entry} onEdit={onEdit} onDelete={onDelete} />
              ))}
            </ListRows>
          </section>
        )
      })}
    </div>
  )
}
