import { Children, isValidElement } from 'react'
import type { ReactNode } from 'react'

export type ListRowsProps = {
  /** Accessible name of the list. */
  label?: string
  /** One element per row — a router <Link className="list-row"> for a row that opens a record. */
  children: ReactNode
  testId?: string
}

/**
 * ListRows — a card-style list where each row opens one record (My requests,
 * Batch history). Use a DataTable instead when rows have more than ~3
 * comparable columns.
 *
 * Give each row a `key` that names its record (its id): a row then keeps its
 * element, and what it holds (an open menu, a message shown in it), when a row
 * above it is added or removed. A row without a key is kept by its position.
 */
export function ListRows({ label, children, testId }: ListRowsProps) {
  return (
    <ul className="list-rows" aria-label={label} data-testid={testId}>
      {Children.toArray(children).map((child, index) => (
        // `toArray` namespaces a row's own key (and numbers a row without one by its place among the children),
        // so the item follows its record, not the slot the record happens to be in. Text has no key: its place.
        <li key={isValidElement(child) && child.key !== null ? child.key : index}>{child}</li>
      ))}
    </ul>
  )
}

/** The class a row link carries; `listRowMetaClassName` for its secondary text. */
export const listRowClassName = 'list-row'
export const listRowMetaClassName = 'list-row-meta'
