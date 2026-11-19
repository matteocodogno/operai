import { Fragment, useEffect, useLayoutEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { cx } from '../lib/cx'
import { Icon } from './Icon'

export type DataTableColumn<T> = {
  /** Stable id (React key). */
  id: string
  /** Header text — app-owned copy. */
  header: ReactNode
  render: (row: T) => ReactNode
  /** Right-aligned DM Mono with tabular figures: amounts, years, counts. The cell text carries its own currency. */
  numeric?: boolean
  /** Render this column's cells as `<th scope="row">` (the row's name). */
  rowHeader?: boolean
  /** The header becomes a sort button (needs the table's `sort` and `onSortChange`). */
  sortable?: boolean
  /** The direction a first click on this column sorts by: `asc` (default) or `desc` (dates, counts). */
  firstSortDirection?: SortDirection
  /**
   * Keep this column in view at the region's `start` or `end` edge while the table scrolls sideways,
   * from 48 rem up (below that the column scrolls like the others). At most one column of each; a
   * second `start` (or `end`) is ignored. Meant for the first column (the row's name) and the last
   * (a total). Needs a library that has it: a shell that predates it shows the table unpinned.
   */
  pin?: 'start' | 'end'
}

export type SortDirection = 'asc' | 'desc'
/** The table's current order: which column, which way. The page sorts (usually the server). */
export type DataTableSort = { columnId: string; direction: SortDirection }

export type DataTableProps<T> = {
  /** Names the table (sr-only caption) and, unless `regionLabel` is set, its scroll region. */
  caption: string
  /** Id of a visible heading that names the table instead of `caption` (the caption stays for the region). */
  labelledBy?: string
  /**
   * A detail row under a row, spanning every column, when this returns content
   * (an expanded audit entry). The row that toggles it owns an
   * `aria-expanded` control; the detail row is plain content.
   */
  renderDetail?: (row: T) => ReactNode
  regionLabel?: string
  columns: readonly DataTableColumn<T>[]
  rows: readonly T[]
  getRowKey: (row: T) => string
  /** Moves focus to this row's header cell — e.g. the row just added. */
  focusRowKey?: string | null
  /** Highlights rows on hover — when a cell holds the row's link. */
  interactiveRows?: boolean
  testId?: string
  /** data-testid for each row: `${rowTestIdPrefix}-${key}`. */
  rowTestIdPrefix?: string
  /** The current order, shown on its header (`aria-sort`); controlled by the page. */
  sort?: DataTableSort | null
  /**
   * A sortable header was clicked: the same column flips its direction, another
   * column starts at its `firstSortDirection`. The page fetches the new order.
   */
  onSortChange?: (next: DataTableSort) => void
}

/**
 * DataTable — the one table primitive (extracted from inventory-ui). An
 * sr-only caption, `scope` on every header, numeric columns right-aligned in
 * DM Mono, and a keyboard-scrollable region when wider than the viewport. It
 * never formats, sorts or paginates: a `sortable` column's header is a button
 * that reports the order the person asked for (`onSortChange`) and shows the
 * current one (`aria-sort`), and the page puts the rows in that order. Empty
 * and loading states are the page's (render a StatePanel or SkeletonRows
 * instead of an empty table).
 */
export function DataTable<T>({
  caption,
  labelledBy,
  renderDetail,
  regionLabel,
  columns,
  rows,
  getRowKey,
  focusRowKey = null,
  interactiveRows = false,
  testId,
  rowTestIdPrefix,
  sort = null,
  onSortChange,
}: DataTableProps<T>) {
  const regionRef = useRef<HTMLDivElement>(null)
  const tableRef = useRef<HTMLTableElement>(null)
  // The first column to ask for an edge keeps it; a later one asks for nothing.
  const pinStartId = columns.find((column) => column.pin === 'start')?.id
  const pinEndId = columns.find((column) => column.pin === 'end')?.id
  const pinClass = (column: DataTableColumn<T>) =>
    column.id === pinStartId && column.pin === 'start'
      ? 'is-pinned-start'
      : column.id === pinEndId && column.pin === 'end'
        ? 'is-pinned-end'
        : false

  // A focused cell must never end up under a pinned column: the region reserves that column's
  // width as scroll padding (tokens.css, from 48 rem up), which the browser honours when it
  // scrolls a focused cell into view. The width is the header cell's, measured, because the
  // column is as wide as its widest cell. Set on the element, not as state: no re-render.
  useLayoutEffect(() => {
    const region = regionRef.current
    const table = tableRef.current
    if (!region || !table) return
    const sides = [
      ['thead th.is-pinned-start', '--data-table-pin-start'],
      ['thead th.is-pinned-end', '--data-table-pin-end'],
    ] as const
    const pinned = sides.flatMap(([selector, property]) => {
      const cell = table.querySelector<HTMLElement>(selector)
      return cell ? [{ cell, property }] : []
    })
    if (pinned.length === 0) return
    const measure = () => {
      for (const { cell, property } of pinned) {
        region.style.setProperty(property, `${Math.ceil(cell.getBoundingClientRect().width)}px`)
      }
    }
    measure()
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null
    for (const { cell } of pinned) observer?.observe(cell)
    return () => {
      observer?.disconnect()
      for (const { property } of pinned) region.style.removeProperty(property)
    }
  }, [pinStartId, pinEndId])

  useEffect(() => {
    if (focusRowKey === null) return
    const row = Array.from(tableRef.current?.querySelectorAll<HTMLTableRowElement>('tbody tr') ?? []).find(
      (candidate) => candidate.dataset.rowKey === focusRowKey,
    )
    row?.querySelector<HTMLElement>('th[scope="row"]')?.focus()
  }, [focusRowKey])

  return (
    <div
      ref={regionRef}
      role="region"
      aria-label={regionLabel ?? caption}
      tabIndex={0}
      className={cx(
        'table-region',
        pinStartId !== undefined && 'has-pin-start',
        pinEndId !== undefined && 'has-pin-end',
      )}
    >
      <table ref={tableRef} className="data-table" aria-labelledby={labelledBy} data-testid={testId}>
        <caption className="visually-hidden">{caption}</caption>
        <thead>
          <tr>
            {columns.map((column) => {
              const sortable = column.sortable === true && onSortChange !== undefined
              const active = sortable && sort?.columnId === column.id ? sort.direction : null
              return (
                <th
                  key={column.id}
                  scope="col"
                  className={cx(column.numeric && 'is-numeric', pinClass(column))}
                  aria-sort={sortable ? (active === 'asc' ? 'ascending' : active === 'desc' ? 'descending' : 'none') : undefined}
                >
                  {sortable ? (
                    <button
                      type="button"
                      className={cx('data-table-sort', active && 'is-active')}
                      onClick={() =>
                        onSortChange({
                          columnId: column.id,
                          direction: active ? (active === 'asc' ? 'desc' : 'asc') : (column.firstSortDirection ?? 'asc'),
                        })
                      }
                      data-testid={testId ? `${testId}-sort-${column.id}` : undefined}
                    >
                      {column.header}
                      <Icon name={active === 'desc' ? 'arrow-down' : 'arrow-up'} className="data-table-sort-icon" />
                    </button>
                  ) : (
                    column.header
                  )}
                </th>
              )
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const rowKey = getRowKey(row)
            const detail = renderDetail?.(row)
            return (
              <Fragment key={rowKey}>
                <tr
                  data-row-key={rowKey}
                  data-testid={rowTestIdPrefix ? `${rowTestIdPrefix}-${rowKey}` : undefined}
                  className={cx(interactiveRows && 'is-interactive')}
                >
                  {columns.map((column) =>
                    column.rowHeader ? (
                      <th
                        key={column.id}
                        scope="row"
                        tabIndex={-1}
                        className={cx(column.numeric && 'is-numeric', pinClass(column))}
                      >
                        {column.render(row)}
                      </th>
                    ) : (
                      <td key={column.id} className={cx(column.numeric && 'is-numeric', pinClass(column))}>
                        {column.render(row)}
                      </td>
                    ),
                  )}
                </tr>
                {detail !== undefined && detail !== null && detail !== false && (
                  <tr className="data-table-detail" data-row-detail={rowKey}>
                    <td colSpan={columns.length}>{detail}</td>
                  </tr>
                )}
              </Fragment>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
