import {
  Badge,
  Button,
  Icon,
  VisuallyHidden,
  cx,
  formatDate,
  formatDuration,
  listRowClassName,
  listRowMetaClassName,
} from '@operai/ui'
import type { TimeEntryView } from '../lib/hoursApi.types'
import { activityLine, countsForDealLine, onPhrase, rowName } from '../lib/names'
import { strings } from '../strings'

export type EntryRowProps = {
  entry: TimeEntryView
  /** Edit and Delete are offered only when the page gives a handler. */
  onEdit?: (entry: TimeEntryView) => void
  onDelete?: (entry: TimeEntryView) => void
  /**
   * The Edit button is what a dialog holding this row opens its focus on (`data-autofocus`, the library's own
   * hook for it): the Week's cell dialog sets it on its first row. Nothing in the List sets it.
   */
  autoFocusEdit?: boolean
}

const minutesIn = (minutes: number, style: 'short' | 'spoken') => formatDuration(minutes * 60_000, { style })

/** A duration as hours and minutes ("2 h 30", AC-4.9) with the spoken form for assistive technology. */
export function Duration({ minutes, className }: { minutes: number; className?: string }) {
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

/**
 * Pieces on one meta line, a middle dot between them (the dot is not read). Each piece is an item of a wrapping flex row, and
 * an item is never narrower than its longest unbreakable run unless it is told it may be: `min-w-0` lets a piece that is
 * a name of 200 characters with no break shrink to the row and wrap there (`break-words` alone does not).
 */
function MetaLine({ pieces }: { pieces: (string | null)[] }) {
  const shown = pieces.filter((piece): piece is string => piece !== null)
  if (shown.length === 0) return null
  return (
    <p className={cx(listRowMetaClassName, 'flex flex-wrap gap-x-2')}>
      {shown.map((piece, index) => (
        <span key={index} className="min-w-0 break-words">
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

/**
 * EntryRow — one entry as My hours lists it (specs/20261112-time-tracking T25, moved out of `EntryDayList` by
 * specs/20261116-record-hours-in-place T12 so the Week's cell dialog shows exactly what the List shows, AC-5.15).
 *
 * The type (always shown, even when the name is withheld), the name — a link only for a name the viewer may read
 * (AC-4.10) — the duration, the work type or category, the activity, the deal a meeting's hours count for (AC-2.6)
 * and the note. Edit and Delete, when the page gives handlers, name the entry in their labels so a screen reader can
 * tell the buttons of one day apart. It sums nothing and compares nothing (D23).
 */
export default function EntryRow({ entry, onEdit, onDelete, autoFocusEdit = false }: EntryRowProps) {
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
          {/* The name is written by the record's owner (up to 200 characters, no break in it): `min-w-0` lets this flex item shrink
              to the row and `break-words` wrap it there, in the List's card and in the Week's cell dialog alike (QE pass 4 D1). */}
          {name !== null &&
            (name.href !== null ? (
              <a href={name.href} className="link min-w-0 text-sm break-words">
                {name.text}
              </a>
            ) : (
              <span className="min-w-0 text-sm break-words">{name.text}</span>
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
            data-autofocus={autoFocusEdit ? true : undefined}
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
