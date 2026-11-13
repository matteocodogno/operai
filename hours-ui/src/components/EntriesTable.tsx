import { DataTable, VisuallyHidden, cx, formatDate, formatDuration, listRowMetaClassName } from '@operai/ui'
import type { DataTableColumn } from '@operai/ui'
import type { TimeEntryView } from '../lib/hoursApi.types'
import { activityLine, countsForDealLine, rowName } from '../lib/names'
import { strings } from '../strings'
import { personName } from './PersonFilterOptions'

export type EntriesTableProps = {
  /** The entries loaded so far, in the server's order (newest day first); never re-sorted here. */
  entries: readonly TimeEntryView[]
}

const minutesIn = (minutes: number, style: 'short' | 'spoken') => formatDuration(minutes * 60_000, { style })

/**
 * A duration as hours and minutes ("2 h 30", AC-4.9) with the spoken form for assistive technology.
 * `relative`: the table scrolls sideways inside its region on a narrow screen, and an absolutely positioned
 * visually-hidden span with no positioned ancestor stays where the cell WOULD be on the page and so widens the
 * page itself (seen at 360px); inside this wrapper it is clipped with the cell.
 */
function Duration({ minutes }: { minutes: number }) {
  return (
    <span className="relative">
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
function Pieces({ pieces }: { pieces: (string | null)[] }) {
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

/**
 * The "On" cell (design S4): the name — a link only for one the viewer may read (AC-4.10) — then the kind
 * and the work type or category, then, for a meeting, the deal its hours count for (AC-2.6). The kind is
 * always said, so a row whose name is withheld still says what sort of work it was.
 */
function On({ entry }: { entry: TimeEntryView }) {
  const name = rowName(entry.on)
  const countsFor = countsForDealLine(entry.on)
  return (
    <div className="flex min-w-36 flex-col gap-1">
      {name !== null && (
        <p className="text-sm break-words">
          {name.href !== null ? (
            <a href={name.href} className="link">
              {name.text}
            </a>
          ) : (
            name.text
          )}
        </p>
      )}
      <Pieces pieces={[strings.entries.type[entry.on.type], detailName(entry)]} />
      {countsFor !== null && <p className={cx(listRowMetaClassName, 'break-words')}>{countsFor}</p>}
    </div>
  )
}

/** The "Details" cell: the activity the entry points at, or why it is not named, and the full note. */
function Details({ entry }: { entry: TimeEntryView }) {
  const activity = activityLine(entry.activity)
  const note = entry.note !== null && entry.note !== '' ? entry.note : null
  if (activity === null && note === null) return null
  return (
    <div className="flex min-w-40 flex-col gap-1">
      {activity !== null && <p className={cx(listRowMetaClassName, 'break-words')}>{activity}</p>}
      {note !== null && <p className="text-sm wrap-anywhere whitespace-pre-wrap">{note}</p>}
    </div>
  )
}

const columns = (): readonly DataTableColumn<TimeEntryView>[] => {
  const t = strings.everyone.entries.columns
  return [
    { id: 'day', header: t.day, render: (entry) => formatDate(entry.day) },
    { id: 'person', header: t.person, render: (entry) => personName(entry.person.name, entry.person.status) },
    { id: 'on', header: t.on, render: (entry) => <On entry={entry} /> },
    { id: 'details', header: t.details, render: (entry) => <Details entry={entry} /> },
    { id: 'time', header: t.time, numeric: true, render: (entry) => <Duration minutes={entry.minutes} /> },
  ]
}

/**
 * EntriesTable — the entries of Everyone's hours as a flat, READ-ONLY table (specs/029-time-tracking T29;
 * design S4 "Entries card"; AC-1.6, AC-4.3). Columns Day, Person, On, Details and Time, one row per entry in
 * the order the server gave (newest day first), and nothing is sorted, grouped or summed here: no day
 * headings or totals (those are My hours'), no Edit, no Delete, no row action — a holder reads everyone's
 * hours and changes none of them.
 *
 * A name the viewer may not read, or whose owner did not answer, is a word from the catalog and never the
 * server's label or an id (`lib/names`); the person is named as everywhere else (`personName`). The table
 * never draws itself empty: the page shows its own states for that.
 */
export default function EntriesTable({ entries }: EntriesTableProps) {
  return (
    <DataTable
      caption={strings.everyone.entries.caption}
      columns={columns()}
      rows={entries}
      getRowKey={(entry) => entry.id}
      rowTestIdPrefix="hours-entry"
      testId="hours-entries-table"
    />
  )
}
