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
import { showsFromMeetingMark } from '../lib/fromMeetingMark'
import type { TimeEntryView } from '../lib/hoursApi.types'
import { activityLine, countsForDealLine, countsForProjectLine, onPhrase, rowName } from '../lib/names'
import { strings } from '../strings'
import FromMeetingBadge from './FromMeetingBadge'

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
 * (AC-4.10) — the duration, the work type or category, the activity, the deal or the project a meeting's hours count for
 * (AC-2.6; specs/20261112-project-hours AC-4.4, AC-4.7) and the note. Edit and Delete, when the page gives handlers, name the entry
 * in their labels so a screen reader can tell the buttons of one day apart. It sums nothing and compares nothing (D23).
 *
 * An entry Operai recorded from a meeting carries a "From meeting" badge right after the kind badge and before the name
 * exactly while it is recorded on a meeting (`showsFromMeetingMark`: `origin: meeting` and `on.type: meeting`, specs/20261112-meeting-hours
 * T10, T16; AC-2.3 as changed, D67, A47; design S1). It keeps the badge when the person changes its day, duration or note, when
 * they move it to another meeting, and when the meeting is no longer visible to the viewer (the name is then the placeholder,
 * never the title, AC-4.1); it loses it when they move it to a project, a deal or other work, and gets it back when they record
 * it on a meeting again. Any other entry, a missing `origin` included, draws the kind badge alone, as it always did.
 */
export default function EntryRow({ entry, onEdit, onDelete, autoFocusEdit = false }: EntryRowProps) {
  const name = rowName(entry.on)
  // A meeting has one host, so at most one of these two lines exists (specs/20261112-project-hours design S4).
  const meetingDeal = countsForDealLine(entry.on)
  const meetingProject = countsForProjectLine(entry.on)
  const duration = minutesIn(entry.minutes, 'short')
  const kind = <Badge>{strings.entries.type[entry.on.type]}</Badge>
  const label = (describe: typeof strings.entries.editEntry) =>
    describe(duration, onPhrase(entry.on), formatDate(entry.day))

  return (
    <div className={cx(listRowClassName, 'is-interactive flex-wrap')} data-testid={`hours-entry-${entry.id}`}>
      <div className="flex min-w-0 flex-1 basis-60 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {showsFromMeetingMark(entry) ? (
            // The kind and the mark are one cluster, so the mark reads as a qualifier of the kind and the name keeps the row's
            // usual gap after both. A row the rule does not mark draws the kind badge alone, with no wrapper, as it always did (design S1).
            <span className="inline-flex flex-wrap items-center gap-1.5">
              {kind}
              <FromMeetingBadge entryId={entry.id} />
            </span>
          ) : (
            kind
          )}
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
        <MetaLine pieces={[meetingDeal]} />
        <MetaLine pieces={[meetingProject]} />
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
