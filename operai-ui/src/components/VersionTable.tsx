import { useId } from 'react'
import type { ReactNode } from 'react'
import { formatDateTime } from '../lib/format'
import { Badge } from './Badge'
import { Button } from './Button'
import { DataTable } from './DataTable'
import type { DataTableColumn } from './DataTable'

export type VersionTableRow = {
  /** The version number; unique within the table. */
  version: number
  /** The version in effect now: it gets the badge and no Restore. */
  current: boolean
  /** The version a restore copied; `null` for a save. A line "Restored from version m" shows under the number. */
  restoredFrom: number | null
  /** Who saved it, as stored at the save. */
  savedBy: string
  /** When, an ISO 8601 instant: shown in a `<time dateTime>`. */
  savedAt: string
  /** What changed against the version before, in words — composed by the app (it knows its value names). */
  changed: ReactNode
  /**
   * Set when this version cannot be restored: Restore stays in place, `aria-disabled` and focusable, and the
   * text is shown beside it and linked as its description. Ignored on the current row.
   */
  restoreBlockedReason?: string
}

export type VersionTableLabels = {
  /** Column headers. */
  version: string
  savedBy: string
  savedAt: string
  changed: string
  actions: string
  /** The badge on the current version: "Current". */
  current: string
  /** "Restored from version 2". */
  restoredFrom: (version: number) => string
  /** Visible button text, "Open" / "Restore" — every row's. */
  open: string
  restore: string
  /** The buttons' accessible names, naming the row: "Open version 3" / "Restore version 3". */
  openName: (version: number) => string
  restoreName: (version: number) => string
}

export type VersionTableProps = {
  /** Names the table (screen readers): "Versions of {entity}". */
  caption: string
  /** Rows in the order to show — newest first. */
  rows: readonly VersionTableRow[]
  labels: VersionTableLabels
  /** The person may restore: false shows Open only (a read-only record). */
  canRestore: boolean
  onOpen: (version: number) => void
  /** Called for a restorable, non-current row only; a blocked Restore does nothing. */
  onRestore: (version: number) => void
  /** Formats `savedAt`. Defaults to the suite's `formatDateTime`. */
  formatSavedAt?: (iso: string) => string
  testId?: string
  /** `data-testid` prefix per row, `${rowTestIdPrefix}-${version}`; buttons add `-open` / `-restore`. */
  rowTestIdPrefix?: string
}

/**
 * VersionTable — the history of a record as a `DataTable`: version (row header, with a Current badge and
 * "Restored from version m"), who, when, what changed, and Open / Restore buttons named after their row. A
 * version that cannot be restored keeps a focusable `aria-disabled` Restore with its reason beside it. The app
 * owns the fetching, the copy and the restore flow (a `ConfirmDialog`); this component owns the table.
 */
export function VersionTable({
  caption,
  rows,
  labels,
  canRestore,
  onOpen,
  onRestore,
  formatSavedAt = formatDateTime,
  testId,
  rowTestIdPrefix,
}: VersionTableProps) {
  const idPrefix = useId()
  const columns: DataTableColumn<VersionTableRow>[] = [
    {
      id: 'version',
      header: labels.version,
      rowHeader: true,
      render: (row) => (
        <div className="flex flex-col items-start gap-1">
          <span className="flex items-center gap-2">
            <span>{row.version}</span>
            {row.current && <Badge tone="accent">{labels.current}</Badge>}
          </span>
          {row.restoredFrom !== null && (
            <span className="text-xs text-soft">{labels.restoredFrom(row.restoredFrom)}</span>
          )}
        </div>
      ),
    },
    { id: 'savedBy', header: labels.savedBy, render: (row) => row.savedBy },
    {
      id: 'savedAt',
      header: labels.savedAt,
      render: (row) =>
        Number.isNaN(Date.parse(row.savedAt)) ? '–' : <time dateTime={row.savedAt}>{formatSavedAt(row.savedAt)}</time>,
    },
    { id: 'changed', header: labels.changed, render: (row) => row.changed },
    {
      id: 'actions',
      header: labels.actions,
      render: (row) => {
        const blocked = !row.current && row.restoreBlockedReason !== undefined
        const reasonId = `${idPrefix}-reason-${row.version}`
        const rowTestId = rowTestIdPrefix ? `${rowTestIdPrefix}-${row.version}` : undefined
        return (
          <div className="flex flex-col items-start gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="secondary"
                aria-label={labels.openName(row.version)}
                onClick={() => onOpen(row.version)}
                data-testid={rowTestId ? `${rowTestId}-open` : undefined}
              >
                {labels.open}
              </Button>
              {canRestore && !row.current && (
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={labels.restoreName(row.version)}
                  aria-disabled={blocked ? true : undefined}
                  aria-describedby={blocked ? reasonId : undefined}
                  onClick={() => {
                    if (!blocked) onRestore(row.version)
                  }}
                  data-testid={rowTestId ? `${rowTestId}-restore` : undefined}
                >
                  {labels.restore}
                </Button>
              )}
            </div>
            {canRestore && blocked && (
              <span id={reasonId} className="max-w-xs text-xs text-soft">
                {row.restoreBlockedReason}
              </span>
            )}
          </div>
        )
      },
    },
  ]

  return (
    <DataTable
      caption={caption}
      columns={columns}
      rows={rows}
      getRowKey={(row) => String(row.version)}
      testId={testId}
      rowTestIdPrefix={rowTestIdPrefix}
    />
  )
}
