import { useEffect, useRef } from 'react'
import { Button, Card, DataTable, StatePanel } from '@operai/ui'
import type { DataTableColumn } from '@operai/ui'
import { strings } from '../strings'
import TimeListStatusBadge from './TimeListStatusBadge'

const t = strings.timeLists

/** Which list a card shows: the categories, or one of the two work-type lists. */
export type TimeListScope = 'categories' | 'project' | 'deal'

/** One row, whichever list it is from. `requiresNote` is present on a category only. */
export type TimeListRow = {
  id: string
  /** Exactly as typed, in every language (AC-3.8): never passed through the strings catalog. */
  name: string
  retired: boolean
  requiresNote?: boolean
}

/**
 * Retired rows after the active ones, each group in the order the server sent (a stable partition of
 * a small, unpaginated list). A row therefore moves when it is retired or restored (design.md S5).
 */
const activeFirst = (rows: readonly TimeListRow[]): TimeListRow[] => [
  ...rows.filter((row) => !row.retired),
  ...rows.filter((row) => row.retired),
]

/** The toggle's accessible name: which item, and what is happening to it. */
const toggleLabel = (row: TimeListRow, busy: boolean): string => {
  if (row.retired) return busy ? t.row.restoringOf(row.name) : t.row.restoreOf(row.name)
  return busy ? t.row.retiringOf(row.name) : t.row.retireOf(row.name)
}

/** The toggle's visible word. A pending Retire is on a row that is still active, and the reverse. */
const toggleText = (row: TimeListRow, busy: boolean): string => {
  if (row.retired) return busy ? t.row.restoring : t.row.restore
  return busy ? t.row.retiring : t.row.retire
}

export type TimeListCardProps = {
  scope: TimeListScope
  title: string
  rows: readonly TimeListRow[]
  /** Whether a retire or restore of this row is in flight: its button is busy, its Rename inert. */
  isBusy: (rowId: string) => boolean
  /**
   * The row whose toggle should take focus now (a retire or restore just moved it), or null. A
   * one-shot request: the card calls `onToggleFocused` once it has acted on it.
   */
  focusToggleId: string | null
  onToggleFocused: () => void
  /** Add opens the page's dialog for a new item of this list. */
  onAdd: () => void
  /** Rename opens the page's dialog for this row. */
  onRename: (row: TimeListRow) => void
  /** Retire (an active row) or Restore (a retired one): the page sends the `PATCH { retired }`. */
  onToggleRetired: (row: TimeListRow) => void
}

/**
 * TimeListCard — one list of the Time lists screen: its title and Add action, its table (Name, the
 * "Entries need a note" column of a category, Status, and the Rename and Retire / Restore row
 * actions) or its empty state, and a footnote (T32, specs/029-time-tracking, design.md S5).
 * Presentational: the page owns the data, the requests and the dialogs.
 *
 * Retired rows are listed after the active ones. There is no Delete anywhere (AC-3.2): nothing is
 * deleted, so a retired item stays here, restorable, for the entries that still have it (AC-3.4).
 */
export default function TimeListCard({
  scope,
  title,
  rows,
  isBusy,
  focusToggleId,
  onToggleFocused,
  onAdd,
  onRename,
  onToggleRetired,
}: TimeListCardProps) {
  const toggleRefs = useRef(new Map<string, HTMLButtonElement>())

  // A retire or restore replaces the button the person pressed and moves its row; a browser drops
  // focus when that happens, and a keyboard user would start again from the top of the page. Focus
  // moves to the same item's new toggle — unless the person has meanwhile gone somewhere else (a
  // dialog opened on another row): only a focus that is lost, or still in this row, is taken back.
  useEffect(() => {
    if (focusToggleId === null) return
    const toggle = toggleRefs.current.get(focusToggleId)
    const active = document.activeElement
    const focusLost = active === null || active === document.body
    if (toggle && (focusLost || toggle.closest('tr')?.contains(active))) toggle.focus()
    onToggleFocused()
  }, [focusToggleId, onToggleFocused])

  const columns: DataTableColumn<TimeListRow>[] = [
    {
      id: 'name',
      header: strings.common.fields.name,
      rowHeader: true,
      render: (row) => row.name,
    },
    ...(scope === 'categories'
      ? [
          {
            id: 'requiresNote',
            header: t.columns.requiresNote,
            render: (row: TimeListRow) => (row.requiresNote ? t.yes : t.no),
          },
        ]
      : []),
    { id: 'status', header: t.columns.status, render: (row) => <TimeListStatusBadge retired={row.retired} /> },
    {
      id: 'actions',
      header: strings.common.actionsColumn,
      render: (row) => {
        const busy = isBusy(row.id)
        return (
          <span className="flex gap-1">
            <Button
              size="sm"
              variant="ghost"
              aria-haspopup="dialog"
              aria-label={t.row.renameOf(row.name)}
              // Not `disabled`: the person keeps their place and the control keeps its name.
              aria-disabled={busy || undefined}
              onClick={busy ? undefined : () => onRename(row)}
              data-testid={`time-lists-rename-${scope}-${row.id}`}
            >
              {t.row.rename}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              busy={busy}
              ref={(button) => {
                if (button) toggleRefs.current.set(row.id, button)
                else toggleRefs.current.delete(row.id)
              }}
              aria-label={toggleLabel(row, busy)}
              onClick={() => onToggleRetired(row)}
              data-testid={`time-lists-toggle-${scope}-${row.id}`}
            >
              {toggleText(row, busy)}
            </Button>
          </span>
        )
      },
    },
  ]

  return (
    <Card
      title={title}
      data-testid={`time-lists-card-${scope}`}
      className="min-w-0"
      action={
        <Button
          size="sm"
          variant="secondary"
          aria-haspopup="dialog"
          onClick={onAdd}
          data-testid={`time-lists-add-${scope}`}
        >
          {t.list[scope].add}
        </Button>
      }
    >
      {rows.length === 0 ? (
        // A list with only retired rows is not empty: it shows them.
        <StatePanel title={t.list[scope].empty.title} headingLevel={4} testId={`time-lists-empty-${scope}`}>
          {t.list[scope].empty.body}
        </StatePanel>
      ) : (
        <>
          <DataTable
            caption={title}
            columns={columns}
            rows={activeFirst(rows)}
            getRowKey={(row) => row.id}
            testId={`time-lists-table-${scope}`}
            rowTestIdPrefix={`time-lists-row-${scope}`}
          />
          <p className="mt-3 text-xs text-soft">{t.list[scope].footnote}</p>
        </>
      )}
    </Card>
  )
}
