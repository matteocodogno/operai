import { useId } from 'react'
import type { ReactNode } from 'react'
import {
  Badge,
  Button,
  Icon,
  ListRows,
  VisuallyHidden,
  cx,
  formatDate,
  formatDateLong,
  formatDuration,
  listRowClassName,
  listRowMetaClassName,
} from '@operai/ui'
import type { TimeEntryView } from '../lib/hoursApi.types'
import { activityLine, countsForDealLine, onPhrase, rowName } from '../lib/names'
import { strings } from '../strings'

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

const minutesIn = (minutes: number, style: 'short' | 'spoken') => formatDuration(minutes * 60_000, { style })

/** A duration as hours and minutes ("2 h 30", AC-4.9) with the spoken form for assistive technology. */
function Duration({ minutes, className }: { minutes: number; className?: string }) {
  return (
    <span className={cx('font-mono text-sm whitespace-nowrap', className)}>
      <span aria-hidden="true">{minutesIn(minutes, 'short')}</span>
      <VisuallyHidden>{minutesIn(minutes, 'spoken')}</VisuallyHidden>
    </span>
  )
}

/** The work type, or the category of other work, as the lists hold it (a retired one says so, AC-3.4). */
const detailName = (entry: TimeEntryView): string | null => {
  const named = entry.on.type === 'none' ? entry.on.category : entry.workType
  if (named === null) return null
  return named.retired ? strings.entries.retired(named.name) : named.name
}

/** Pieces on one meta line, a middle dot between them (the dot is not read). */
function MetaLine({ pieces }: { pieces: (string | null)[] }) {
  const shown = pieces.filter((piece): piece is string => piece !== null)
  if (shown.length === 0) return null
  return (
    <p className={cx(listRowMetaClassName, 'flex flex-wrap gap-x-2')}>
      {shown.map((piece, index) => (
        <span key={index} className="break-words">
          {index > 0 && (
            <span aria-hidden="true" className="mr-2">
              ·
            </span>
          )}
          {piece}
        </span>
      ))}
    </p>
  )
}

type RowProps = Pick<EntryDayListProps, 'onEdit' | 'onDelete'> & { entry: TimeEntryView }

function EntryRow({ entry, onEdit, onDelete }: RowProps) {
  const name = rowName(entry.on)
  const meeting = countsForDealLine(entry.on)
  const duration = minutesIn(entry.minutes, 'short')
  const label = (describe: typeof strings.entries.editEntry) =>
    describe(duration, onPhrase(entry.on), formatDate(entry.day))

  return (
    <div className={cx(listRowClassName, 'is-interactive flex-wrap')} data-testid={`hours-entry-${entry.id}`}>
      <div className="flex min-w-0 flex-1 basis-60 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <Badge>{strings.entries.type[entry.on.type]}</Badge>
          {name !== null &&
            (name.href !== null ? (
              <a href={name.href} className="link text-sm break-words">
                {name.text}
              </a>
            ) : (
              <span className="text-sm break-words">{name.text}</span>
            ))}
        </div>
        <MetaLine pieces={[detailName(entry), activityLine(entry.activity)]} />
        <MetaLine pieces={[meeting]} />
        {entry.note !== null && entry.note !== '' && (
          <p className="text-sm break-words whitespace-pre-wrap">{entry.note}</p>
        )}
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <Duration minutes={entry.minutes} />
        {onEdit && (
          <Button
            variant="secondary"
            size="sm"
            aria-label={label(strings.entries.editEntry)}
            onClick={() => onEdit(entry)}
            data-testid={`hours-entry-${entry.id}-edit`}
          >
            {strings.entries.edit}
          </Button>
        )}
        {onDelete && (
          <Button
            variant="danger"
            size="sm"
            iconOnly
            aria-label={label(strings.entries.deleteEntry)}
            onClick={() => onDelete(entry)}
            data-testid={`hours-entry-${entry.id}-delete`}
          >
            <Icon name="trash" />
          </Button>
        )}
      </div>
    </div>
  )
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
 * EntryDayList — the entries of My hours, one section per day (specs/029-time-tracking T25; design S1
 * "Entries"; AC-4.1). A day is a region named by its `h4` (`formatDateLong`) and carries the total the
 * server stated for it (`groupBy=day`), so a day whose entries straddle two pages shows its full total at
 * once; with no figure for it, it shows none. Nothing is computed here, and nothing marks a day as
 * incomplete (D23).
 *
 * A row is the type (always shown, even when the name is withheld), the name — a link only for a name the
 * viewer may read (AC-4.10) — the duration, the work type or category, the activity, the deal a meeting's
 * hours count for (AC-2.6) and the note. Edit and Delete, when the page gives handlers, name the entry in
 * their labels so a screen reader can tell the buttons of one day apart.
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
