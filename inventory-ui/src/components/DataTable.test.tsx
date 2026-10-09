/**
 * @vitest-environment jsdom
 *
 * Component tests for DataTable (T26, specs/015-hardware-inventory; design.md
 * § NEW components "DataTable" and § Accessibility "Data tables"): an
 * sr-only caption naming the table, `scope` headers, the row header cell,
 * right-aligned tabular numeric cells, a focusable labelled scroll region, no
 * sorting, and focus on a chosen row header (T4: after adding a rule, focus
 * moves to the new row's header cell).
 */

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import DataTable from './DataTable'
import type { DataTableColumn, DataTableProps } from './DataTable'

afterEach(() => {
  cleanup()
})

type Row = { id: string; name: string; price: string }

const COLUMNS: DataTableColumn<Row>[] = [
  { id: 'name', header: 'Description', rowHeader: true, render: (row) => row.name },
  { id: 'price', header: 'Price', numeric: true, render: (row) => row.price },
]

const ROWS: Row[] = [
  { id: 'a', name: 'MacBook Pro 14', price: '2499,00 CHF' },
  { id: 'b', name: 'Dell U2723QE', price: '640,00 CHF' },
]

const renderTable = (props: Partial<DataTableProps<Row>> = {}) =>
  render(<DataTable caption="Assets, status in stock" columns={COLUMNS} rows={ROWS} getRowKey={(r) => r.id} {...props} />)

describe('DataTable', () => {
  it('is a real table named by an sr-only caption', () => {
    renderTable()

    const table = screen.getByRole('table', { name: 'Assets, status in stock' })
    const caption = table.querySelector('caption')
    expect(caption?.textContent).toBe('Assets, status in stock')
    expect(caption?.className).toContain('sr-only')
  })

  it('renders every column header as <th scope="col"> in order', () => {
    renderTable()

    const headers = screen.getAllByRole('columnheader')
    expect(headers.map((h) => h.textContent)).toEqual(['Description', 'Price'])
    headers.forEach((h) => expect(h.getAttribute('scope')).toBe('col'))
  })

  it('renders the row-header column as <th scope="row"> and the others as cells', () => {
    renderTable()

    const rows = screen.getAllByRole('row').slice(1)
    expect(rows).toHaveLength(2)
    const rowHeader = within(rows[0]).getByRole('rowheader')
    expect(rowHeader.tagName).toBe('TH')
    expect(rowHeader.getAttribute('scope')).toBe('row')
    expect(rowHeader.textContent).toBe('MacBook Pro 14')
    expect(within(rows[0]).getByRole('cell').textContent).toBe('2499,00 CHF')
  })

  it('right-aligns numeric columns, header and cells, in the mono face with tabular figures', () => {
    renderTable()

    const header = screen.getByRole('columnheader', { name: 'Price' })
    const cell = screen.getByRole('cell', { name: '2499,00 CHF' })
    for (const element of [header, cell]) {
      expect(element.className).toContain('text-right')
    }
    expect(cell.className).toContain('tabular-nums')
    expect(cell.getAttribute('style')).toContain('var(--mono)')
  })

  it('leaves non-numeric cells left-aligned and out of the mono face', () => {
    renderTable()

    const rowHeader = screen.getByRole('rowheader', { name: 'MacBook Pro 14' })
    expect(rowHeader.className).not.toContain('text-right')
    expect(rowHeader.getAttribute('style') ?? '').not.toContain('var(--mono)')
  })

  it('wraps the table in a keyboard-focusable, labelled scroll region', () => {
    renderTable()

    const region = screen.getByRole('region', { name: 'Assets, status in stock' })
    expect(region.getAttribute('tabindex')).toBe('0')
    expect(region.className).toContain('overflow-x-auto')
    expect(within(region).getByRole('table')).not.toBeNull()
  })

  it('labels the scroll region with regionLabel when given', () => {
    renderTable({ regionLabel: 'Assets table, scrollable' })

    expect(screen.getByRole('region', { name: 'Assets table, scrollable' })).not.toBeNull()
  })

  it('offers no sorting: no aria-sort and no header buttons', () => {
    renderTable()

    for (const header of screen.getAllByRole('columnheader')) {
      expect(header.hasAttribute('aria-sort')).toBe(false)
    }
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('renders rich cell content (a link, a badge) from render()', () => {
    renderTable({
      columns: [
        { id: 'name', header: 'Description', rowHeader: true, render: (row) => <a href={`/assets/${row.id}`}>{row.name}</a> },
      ],
    })

    expect(screen.getByRole('link', { name: 'MacBook Pro 14' }).getAttribute('href')).toBe('/assets/a')
  })

  it('renders only the header row for no rows (the page owns the empty state)', () => {
    renderTable({ rows: [] })

    expect(screen.getAllByRole('row')).toHaveLength(1)
  })

  it('keys rows by getRowKey, exposing it for tests and e2e', () => {
    renderTable()

    expect(screen.getAllByRole('row')[1].getAttribute('data-row-key')).toBe('a')
  })

  it('namespaces its test id with testId', () => {
    renderTable({ testId: 'assets-table' })

    expect(screen.getByTestId('assets-table').tagName).toBe('TABLE')
  })

  describe('focusRowKey', () => {
    it('makes row headers programmatically focusable but not tab stops', () => {
      renderTable()

      for (const header of screen.getAllByRole('rowheader')) {
        expect(header.getAttribute('tabindex')).toBe('-1')
      }
    })

    it('moves focus to that row header, e.g. the row just added', () => {
      renderTable({ focusRowKey: 'b' })

      expect(document.activeElement).toBe(screen.getByRole('rowheader', { name: 'Dell U2723QE' }))
    })

    it('does not move focus when it is unset or names no row', () => {
      const { rerender } = renderTable()
      expect(document.activeElement).toBe(document.body)

      rerender(
        <DataTable caption="c" columns={COLUMNS} rows={ROWS} getRowKey={(r) => r.id} focusRowKey="missing" />,
      )
      expect(document.activeElement).toBe(document.body)
    })

    it('focuses again when it changes to another row', () => {
      const { rerender } = renderTable({ focusRowKey: 'a' })
      expect(document.activeElement).toBe(screen.getByRole('rowheader', { name: 'MacBook Pro 14' }))

      rerender(
        <DataTable caption="c" columns={COLUMNS} rows={ROWS} getRowKey={(r) => r.id} focusRowKey="b" />,
      )
      expect(document.activeElement).toBe(screen.getByRole('rowheader', { name: 'Dell U2723QE' }))
    })
  })
})
