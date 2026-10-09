import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'

/**
 * DataTable — the one table primitive (T26, specs/015-hardware-inventory;
 * design.md § NEW components: "no table primitive exists; MileageRatesPage
 * inlines one. Six tables here need the same caption, `scope`, numeric
 * right-alignment and responsive scroll wrapper"). The assets list, rules,
 * fiscal years, year detail, the schedule and the roll-forward statement all
 * render through it.
 *
 * Contract (design.md § Accessibility "Data tables"):
 *   - an sr-only `<caption>` names the table (and the active filters — the page
 *     composes the text); it is also the scroll region's label unless
 *     `regionLabel` says otherwise;
 *   - `<th scope="col">` per column; the column flagged `rowHeader` renders its
 *     cells as `<th scope="row">` (the description or the year);
 *   - `numeric` columns are right-aligned in DM Mono with `tabular-nums`, header
 *     and cells alike; the cell text carries its own currency code (the page
 *     formats it with `formatMoney`) — this component never formats or computes;
 *   - wider than the viewport -> a `role="region"` scroll wrapper with
 *     `tabindex="0"` and an `aria-label`, so keyboard users can scroll it;
 *   - no sorting, so no `aria-sort` and no header buttons;
 *   - `focusRowKey` moves focus to that row's header cell (made focusable with
 *     `tabIndex={-1}`, never a tab stop) — T4's "after adding, focus moves to
 *     the new row's header cell".
 *
 * Empty and loading states are the page's: with no rows only the header renders.
 */

export type DataTableColumn<T> = {
  /** Stable id for the column (React key). */
  id: string
  /** Column header text — page-owned copy. */
  header: string
  render: (row: T) => ReactNode
  /** Right-align in DM Mono with tabular figures (amounts, years, counts). */
  numeric?: boolean
  /** Render this column's cells as `<th scope="row">`. */
  rowHeader?: boolean
}

export type DataTableProps<T> = {
  /** Names the table; rendered sr-only. */
  caption: string
  /** Label of the scroll region. Defaults to `caption`. */
  regionLabel?: string
  columns: readonly DataTableColumn<T>[]
  rows: readonly T[]
  getRowKey: (row: T) => string
  /** The row whose header cell should take focus (e.g. the row just added). */
  focusRowKey?: string | null
  testId?: string
}

const CELL = 'py-1.5 px-2 text-sm'

export default function DataTable<T>({
  caption,
  regionLabel,
  columns,
  rows,
  getRowKey,
  focusRowKey = null,
  testId,
}: DataTableProps<T>) {
  const tableRef = useRef<HTMLTableElement>(null)

  useEffect(() => {
    if (focusRowKey === null) return
    const row = Array.from(tableRef.current?.querySelectorAll<HTMLTableRowElement>('tbody tr') ?? []).find(
      (candidate) => candidate.dataset.rowKey === focusRowKey,
    )
    row?.querySelector<HTMLElement>('th[scope="row"]')?.focus()
  }, [focusRowKey])

  return (
    <div role="region" aria-label={regionLabel ?? caption} tabIndex={0} className="overflow-x-auto">
      <table ref={tableRef} className="w-full border-collapse" data-testid={testId}>
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b" style={{ borderColor: 'var(--rule)' }}>
            {columns.map((column) => (
              <th
                key={column.id}
                scope="col"
                className={`${CELL} text-[11px] font-mono font-medium uppercase tracking-wider whitespace-nowrap ${column.numeric ? 'text-right' : 'text-left'}`}
                style={{ color: 'var(--soft)' }}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const rowKey = getRowKey(row)
            return (
              <tr
                key={rowKey}
                data-row-key={rowKey}
                className="border-b"
                style={{ borderColor: 'color-mix(in srgb, var(--rule) 50%, transparent)' }}
              >
                {columns.map((column) => {
                  const className = `${CELL} ${column.numeric ? 'text-right tabular-nums whitespace-nowrap' : 'text-left'}`
                  const style = {
                    color: 'var(--text)',
                    ...(column.numeric ? { fontFamily: 'var(--mono)' } : {}),
                  }
                  return column.rowHeader ? (
                    <th
                      key={column.id}
                      scope="row"
                      tabIndex={-1}
                      className={`${className} font-medium focus:outline-none focus-visible:ring-2`}
                      style={style}
                    >
                      {column.render(row)}
                    </th>
                  ) : (
                    <td key={column.id} className={className} style={style}>
                      {column.render(row)}
                    </td>
                  )
                })}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
