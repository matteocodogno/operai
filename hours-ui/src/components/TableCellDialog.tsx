import { useEffect, useRef } from 'react'
import { Button, Dialog, ListRows, formatDateLong, formatDuration } from '@operai/ui'
import type { TimeEntryView } from '../lib/hoursApi.types'
import type { TableGridCell, TableGridRow } from '../lib/tableGrid'
import { strings } from '../strings'
import EntryRow from './EntryRow'
import { longDay, rowLabel } from './TableViewModel'

export type TableCellDialogProps = {
  /** The row of the grid the cell is on: its kind and name title the dialog, its `preset` says whether hours can be added. */
  row: TableGridRow
  /** What the cell holds: the entries, in the server's order, and their total. Never empty (the page closes the dialog then). */
  cell: TableGridCell
  /** `YYYY-MM-DD`: the description names its weekday, read from the date (R17). */
  day: string
  /** Edit and Delete of one entry: the page opens its own entry dialog and delete confirmation over this one. */
  onEdit: (entry: TimeEntryView) => void
  onDelete: (entry: TimeEntryView) => void
  /** Add hours on this day and row. Absent where no hours can be added: an unreadable row, a retired category (AC-5.24). */
  onAdd?: () => void
  onClose: () => void
}

/**
 * TableCellDialog — the entries of one cell of the table: one row, one day (specs/20261116-record-hours-in-place T12, T18;
 * design S8; AC-5.15–AC-5.18, AC-5.24).
 *
 * A `Dialog`, not a drawer or a popover: it holds Edit and Delete, and a modal gives the stack the library already
 * handles — the page's entry dialog and delete confirmation open over it, take the keyboard and hand it back. Each entry is
 * the List's own `EntryRow` (AC-5.15), with Edit and Delete on every one, whether the row can be recorded on or not
 * (the author changes and deletes their own, time-tracking AC-2.12). Add hours is the one primary action and is only
 * there where the page gave a handler.
 *
 * The dialog is drawn from the cell the page hands it, which the page keeps from the last week that loaded, so the list
 * does not blank while the week is read again after a write and then updates in place. Two things follow from that
 * and are this component's: focus opens on the first entry's Edit (design S8), and when the entry whose button had
 * focus has gone from the cell (deleted, or edited onto another day or row) focus goes to the dialog's heading, never
 * to the page behind it. An empty cell is not drawn: the page closes the dialog.
 */
export default function TableCellDialog({ row, cell, day, onEdit, onDelete, onAdd, onClose }: TableCellDialogProps) {
  const body = useRef<HTMLDivElement>(null)
  const date = formatDateLong(day)

  // Which entries the dialog lists, in which order: when that changes and focus has fallen to the page's body (the
  // button it was on was removed with its entry), it goes to the dialog's heading. A focus that is anywhere else — on a
  // button that is still there, on the Add hours button, in an entry dialog stacked above — is left alone.
  const entryIds = cell.entries.map((entry) => entry.id).join()
  useEffect(() => {
    const active = document.activeElement
    if (active !== null && active !== document.body) return
    const labelledBy = body.current?.closest('[role="dialog"]')?.getAttribute('aria-labelledby')
    const heading = labelledBy ? document.getElementById(labelledBy) : null
    if (heading === null) return
    heading.tabIndex = -1
    heading.focus()
  }, [entryIds])

  return (
    <Dialog
      size="lg"
      // The row's name is a project's, a deal's or a meeting's title, up to 200 characters and no break in it. The library's
      // header is a flex row whose heading is a flex item sized by its longest unbreakable run, so an unwrapped name pushes
      // the × out of the window (QE pass 4 D1). `wrap-anywhere` lets the heading shrink to the dialog and break only a run
      // that does not fit on a line of its own: an ordinary name stays whole.
      title={
        <span className="wrap-anywhere">
          {strings.table.cellDialog.title(strings.entries.type[row.kind], rowLabel(row))}
        </span>
      }
      description={strings.table.cellDialog.description(
        longDay(day),
        cell.entries.length,
        formatDuration(cell.minutes * 60_000, { style: 'short' }),
      )}
      closeLabel={strings.common.close}
      onClose={onClose}
      testIdPrefix="hours-table-cell"
    >
      <div ref={body} className="mb-4">
        <ListRows label={strings.entries.dayList(date)}>
          {cell.entries.map((entry, index) => (
            <EntryRow key={entry.id} entry={entry} onEdit={onEdit} onDelete={onDelete} autoFocusEdit={index === 0} />
          ))}
        </ListRows>
      </div>
      <div className="dialog-footer">
        <Button variant="ghost" onClick={onClose} data-testid="hours-table-cell-done">
          {strings.common.close}
        </Button>
        {onAdd && (
          <Button variant="primary" aria-haspopup="dialog" onClick={onAdd} data-testid="hours-table-cell-add">
            {strings.table.cellDialog.add}
          </Button>
        )}
      </div>
    </Dialog>
  )
}
