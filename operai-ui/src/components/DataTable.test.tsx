import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DataTable } from './DataTable'
import type { DataTableColumn } from './DataTable'

afterEach(cleanup)

type Row = { id: string; name: string; hours: string; open?: boolean }

const rows: Row[] = [
  { id: 'a', name: 'Alpha', hours: '8 h', open: true },
  { id: 'b', name: 'Beta', hours: '2 h' },
]

describe('DataTable without pin', () => {
  it('renders the markup it rendered before the pin prop existed', () => {
    const columns: DataTableColumn<Row>[] = [
      { id: 'name', header: 'Name', rowHeader: true, sortable: true, render: (row) => row.name },
      { id: 'hours', header: 'Hours', numeric: true, render: (row) => row.hours },
    ]
    const { container } = render(
      <DataTable
        caption="Hours"
        columns={columns}
        rows={rows}
        getRowKey={(row) => row.id}
        interactiveRows
        testId="hours"
        rowTestIdPrefix="hours-row"
        sort={{ columnId: 'name', direction: 'asc' }}
        onSortChange={() => undefined}
        renderDetail={(row) => (row.open ? `Details of ${row.name}` : null)}
      />,
    )
    expect(container.innerHTML).toMatchInlineSnapshot(`"<div role="region" aria-label="Hours" tabindex="0" class="table-region"><table class="data-table" data-testid="hours"><caption class="visually-hidden">Hours</caption><thead><tr><th scope="col" class="" aria-sort="ascending"><button type="button" class="data-table-sort is-active" data-testid="hours-sort-name">Name<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="icon data-table-sort-icon" aria-hidden="true" focusable="false"><path d="M12 19V5m-6 6 6-6 6 6"></path></svg></button></th><th scope="col" class="is-numeric">Hours</th></tr></thead><tbody><tr data-row-key="a" data-testid="hours-row-a" class="is-interactive"><th scope="row" tabindex="-1" class="">Alpha</th><td class="is-numeric">8 h</td></tr><tr class="data-table-detail" data-row-detail="a"><td colspan="2">Details of Alpha</td></tr><tr data-row-key="b" data-testid="hours-row-b" class="is-interactive"><th scope="row" tabindex="-1" class="">Beta</th><td class="is-numeric">2 h</td></tr></tbody></table></div>"`)
  })
})

describe('DataTable pin', () => {
  const columns: DataTableColumn<Row>[] = [
    { id: 'name', header: 'Name', rowHeader: true, pin: 'start', render: (row) => row.name },
    { id: 'hours', header: 'Hours', numeric: true, render: (row) => row.hours },
    { id: 'total', header: 'Total', numeric: true, pin: 'end', render: (row) => row.hours },
  ]

  it('marks the pinned column in the header and in every row, and no other cell', () => {
    const { container } = render(
      <DataTable
        caption="Hours"
        columns={columns}
        rows={rows}
        getRowKey={(row) => row.id}
        renderDetail={(row) => (row.open ? `Details of ${row.name}` : null)}
      />,
    )
    const cellsOf = (selector: string) => Array.from(container.querySelectorAll(selector))
    const classes = (cells: Element[]) => cells.map((cell) => cell.className)

    expect(classes(cellsOf('thead th'))).toEqual(['is-pinned-start', 'is-numeric', 'is-numeric is-pinned-end'])
    for (const row of cellsOf('tbody tr[data-row-key]')) {
      expect(classes(Array.from(row.children))).toEqual(['is-pinned-start', 'is-numeric', 'is-numeric is-pinned-end'])
    }
    // The detail row spans the whole table and scrolls with it.
    expect(container.querySelector('tr.data-table-detail td')).not.toHaveClass('is-pinned-start')
    expect(container.querySelector('tr.data-table-detail td')).not.toHaveClass('is-pinned-end')
  })

  it('keeps the first column that asks for an edge and ignores a later one', () => {
    const { container } = render(
      <DataTable
        caption="Hours"
        rows={rows}
        getRowKey={(row) => row.id}
        columns={[
          { id: 'name', header: 'Name', rowHeader: true, pin: 'start', render: (row) => row.name },
          { id: 'also-start', header: 'Also start', pin: 'start', render: () => '' },
          { id: 'hours', header: 'Hours', pin: 'end', render: (row) => row.hours },
          { id: 'also-end', header: 'Also end', pin: 'end', render: () => '' },
        ]}
      />,
    )
    const headerClasses = Array.from(container.querySelectorAll('thead th')).map((cell) => cell.className)
    expect(headerClasses).toEqual(['is-pinned-start', '', 'is-pinned-end', ''])
    expect(container.querySelectorAll('.is-pinned-start')).toHaveLength(1 + rows.length)
    expect(container.querySelectorAll('.is-pinned-end')).toHaveLength(1 + rows.length)
  })
})

describe('DataTable pin: room for a focused cell', () => {
  const columns: DataTableColumn<Row>[] = [
    { id: 'name', header: 'Name', rowHeader: true, pin: 'start', render: (row) => row.name },
    { id: 'hours', header: 'Hours', numeric: true, render: (row) => row.hours },
    { id: 'total', header: 'Total', numeric: true, pin: 'end', render: (row) => row.hours },
  ]

  // jsdom has no layout: the header cells' widths are whatever the test says, by their text.
  const widths: Record<string, number> = { Name: 140.2, Total: 63.5 }
  const observers: Array<{ callback: () => void; observed: Element[]; disconnected: boolean }> = []

  class ResizeObserverStub {
    entry = { callback: () => {}, observed: [] as Element[], disconnected: false }
    constructor(callback: () => void) {
      this.entry.callback = callback
      observers.push(this.entry)
    }
    observe(element: Element) {
      this.entry.observed.push(element)
    }
    disconnect() {
      this.entry.disconnected = true
    }
    unobserve() {}
  }

  const stubLayout = () => {
    vi.stubGlobal('ResizeObserver', ResizeObserverStub)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return { width: widths[this.textContent ?? ''] ?? 0 } as DOMRect
    })
  }

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    observers.length = 0
    widths.Name = 140.2
    widths.Total = 63.5
  })

  const table = (cols: DataTableColumn<Row>[]) => (
    <DataTable caption="Hours" columns={cols} rows={rows} getRowKey={(row) => row.id} />
  )

  it('hands the region the measured width of each pinned column, rounded up', () => {
    stubLayout()
    const { getByRole } = render(table(columns))
    const region = getByRole('region', { name: 'Hours' })
    expect(region).toHaveClass('table-region', 'has-pin-start', 'has-pin-end')
    expect(region.style.getPropertyValue('--data-table-pin-start')).toBe('141px')
    expect(region.style.getPropertyValue('--data-table-pin-end')).toBe('64px')
  })

  it('follows a pinned column that changes width', () => {
    stubLayout()
    const { getByRole } = render(table(columns))
    const region = getByRole('region', { name: 'Hours' })
    expect(observers).toHaveLength(1)
    expect(observers[0]!.observed.map((element) => element.textContent)).toEqual(['Name', 'Total'])

    widths.Name = 200
    act(() => observers[0]!.callback())
    expect(region.style.getPropertyValue('--data-table-pin-start')).toBe('200px')
    expect(region.style.getPropertyValue('--data-table-pin-end')).toBe('64px')
  })

  it('stops observing when the table unmounts', () => {
    stubLayout()
    const { unmount } = render(table(columns))
    unmount()
    expect(observers[0]!.disconnected).toBe(true)
  })

  it('measures once where there is no ResizeObserver', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return { width: widths[this.textContent ?? ''] ?? 0 } as DOMRect
    })
    const { getByRole } = render(table(columns))
    expect(getByRole('region', { name: 'Hours' }).style.getPropertyValue('--data-table-pin-start')).toBe('141px')
  })

  it('asks for room only on the edge that is pinned', () => {
    stubLayout()
    const { getByRole } = render(table(columns.filter((column) => column.pin !== 'end')))
    const region = getByRole('region', { name: 'Hours' })
    expect(region).toHaveClass('has-pin-start')
    expect(region).not.toHaveClass('has-pin-end')
    expect(region.style.getPropertyValue('--data-table-pin-end')).toBe('')
  })

  it('gives the region nothing when no column is pinned, and takes it back when the pin goes', () => {
    stubLayout()
    const { getByRole, rerender } = render(table(columns))
    const region = getByRole('region', { name: 'Hours' })
    expect(region.style.getPropertyValue('--data-table-pin-start')).toBe('141px')

    rerender(table(columns.map((column) => ({ ...column, pin: undefined }))))
    expect(region.className).toBe('table-region')
    expect(region.style.getPropertyValue('--data-table-pin-start')).toBe('')
    expect(region.style.getPropertyValue('--data-table-pin-end')).toBe('')
    expect(observers.at(-1)!.disconnected).toBe(true)
  })
})

describe('DataTable pin: the stylesheet', () => {
  // jsdom applies no media query, so the "from 48 rem up" rule is checked on the source: every rule
  // that makes a pinned cell stick, and the scroll padding that goes with it, sits inside one block.
  const source = readFileSync(resolve(import.meta.dirname, '../styles/tokens.css'), 'utf8')
  const css = source.replace(/\/\*[\s\S]*?\*\//g, '')
  const start = css.indexOf('@media (min-width: 48rem) {')
  const block = (() => {
    let depth = 0
    for (let at = css.indexOf('{', start); at < css.length; at++) {
      if (css[at] === '{') depth++
      if (css[at] === '}' && --depth === 0) return css.slice(start, at + 1)
    }
    return ''
  })()

  it('sticks the pinned cells and reserves their width only from 48 rem up', () => {
    expect(start).toBeGreaterThan(-1)
    expect(block).toMatch(/\.is-pinned-start[^{]*\{[^}]*position: sticky/)
    expect(block).toMatch(/\.is-pinned-start[^{]*\{[^}]*inset-inline-start: 0/)
    expect(block).toMatch(/\.is-pinned-end[^{]*\{[^}]*inset-inline-end: 0/)
    expect(block).toMatch(/scroll-padding-inline-start: calc\(var\(--data-table-pin-start\)/)
    expect(block).toMatch(/scroll-padding-inline-end: calc\(var\(--data-table-pin-end\)/)
    const rest = css.replace(block, '')
    expect(rest).not.toMatch(/sticky/)
    expect(rest).not.toMatch(/scroll-padding-inline/)
  })
})
