import { useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { ListRows, listRowClassName } from './ListRows'

afterEach(cleanup)

/** A row that keeps something of its own in state, as a row holding a widget with a message does. */
function Row({ id }: { id: string }) {
  const [note, setNote] = useState<string | null>(null)
  return (
    <div className={listRowClassName} data-testid={`row-${id}`}>
      <span>{id}</span>
      <button type="button" onClick={() => setNote(`note on ${id}`)}>
        Note {id}
      </button>
      {note && <p role="status">{note}</p>}
    </div>
  )
}

const rowsOf = (ids: string[]) => (
  <ListRows label="Items" testId="items">
    {ids.map((id) => (
      <Row key={id} id={id} />
    ))}
  </ListRows>
)

describe('ListRows', () => {
  it('renders one list item per row, in order, with its label and test id', () => {
    render(rowsOf(['a', 'b', 'c']))
    const list = screen.getByRole('list', { name: 'Items' })
    expect(list).toBe(screen.getByTestId('items'))
    expect(list).toHaveClass('list-rows')
    const items = within(list).getAllByRole('listitem')
    expect(items.map((item) => item.textContent)).toEqual(['aNote a', 'bNote b', 'cNote c'])
  })

  it('drops the children that draw nothing and keeps the order of the rest', () => {
    render(
      <ListRows label="Items">
        {null}
        <Row id="a" />
        {false}
        <Row id="b" />
      </ListRows>,
    )
    expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual(['aNote a', 'bNote b'])
  })

  it('keeps a keyed row’s element, and what it holds, when a row is inserted above it', () => {
    const { rerender } = render(rowsOf(['b', 'c']))
    const c = screen.getByTestId('row-c')
    const item = c.closest('li')
    fireEvent.click(screen.getByRole('button', { name: 'Note c' }))
    expect(within(c).getByRole('status').textContent).toBe('note on c')

    rerender(rowsOf(['a', 'b', 'c']))

    expect(screen.getByTestId('row-c')).toBe(c)
    expect(c.closest('li')).toBe(item)
    expect(c.isConnected).toBe(true)
    expect(within(c).getByRole('status').textContent).toBe('note on c')
    expect(screen.getAllByRole('listitem')).toHaveLength(3)
  })

  it('keeps a keyed row’s element, and what it holds, when a row above it is removed', () => {
    const { rerender } = render(rowsOf(['a', 'b', 'c']))
    const c = screen.getByTestId('row-c')
    fireEvent.click(screen.getByRole('button', { name: 'Note c' }))

    rerender(rowsOf(['a', 'c']))

    expect(screen.queryByTestId('row-b')).toBeNull()
    expect(screen.getByTestId('row-c')).toBe(c)
    expect(within(c).getByRole('status').textContent).toBe('note on c')
  })

  it('keeps every surviving row’s element when the first row is removed', () => {
    const { rerender } = render(rowsOf(['a', 'b', 'c']))
    const b = screen.getByTestId('row-b')
    const c = screen.getByTestId('row-c')

    rerender(rowsOf(['b', 'c']))

    expect(screen.getByTestId('row-b')).toBe(b)
    expect(screen.getByTestId('row-c')).toBe(c)
    expect(screen.queryByTestId('row-a')).toBeNull()
  })

  it('moves a keyed row, with what it holds, when the rows are reordered', () => {
    const { rerender } = render(rowsOf(['a', 'b']))
    const b = screen.getByTestId('row-b')
    fireEvent.click(screen.getByRole('button', { name: 'Note b' }))

    rerender(rowsOf(['b', 'a']))

    expect(screen.getAllByRole('listitem').map((item) => item.textContent?.slice(0, 1))).toEqual(['b', 'a'])
    expect(screen.getByTestId('row-b')).toBe(b)
    expect(within(b).getByRole('status').textContent).toBe('note on b')
  })

  it('drops a row that is no longer listed, with what it held, and starts a returning one afresh', () => {
    const { rerender } = render(rowsOf(['a', 'b']))
    fireEvent.click(screen.getByRole('button', { name: 'Note b' }))

    rerender(rowsOf(['a']))
    expect(screen.queryByTestId('row-b')).toBeNull()

    rerender(rowsOf(['a', 'b']))
    expect(within(screen.getByTestId('row-b')).queryByRole('status')).toBeNull()
  })

  it('still lists a row with no key, and keeps it while the rows around it do not change', () => {
    const { rerender } = render(
      <ListRows label="Items">
        <Row id="a" />
        <Row id="b" />
      </ListRows>,
    )
    const b = screen.getByTestId('row-b')
    fireEvent.click(screen.getByRole('button', { name: 'Note b' }))

    rerender(
      <ListRows label="Items">
        <Row id="a" />
        <Row id="b" />
      </ListRows>,
    )

    expect(screen.getByTestId('row-b')).toBe(b)
    expect(within(b).getByRole('status').textContent).toBe('note on b')
  })

  it('lists a row that is plain text', () => {
    render(
      <ListRows label="Items">
        {'first'}
        <Row id="b" />
      </ListRows>,
    )
    expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual(['first', 'bNote b'])
  })
})
