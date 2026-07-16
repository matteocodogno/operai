/**
 * @vitest-environment jsdom
 *
 * Component tests for ExpenseLineRow (T16, specs/007-refund-service/
 * tasks.md). Covers: `edit` mode's blur-commit-as-one-PUT behavior (not
 * per-keystroke), the `readOnly`/`readOnlyApproved` variants (AC-3.2: shows
 * both requested and approved), inline delete, and the km field's
 * type-driven show/hide inside the row too.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import ExpenseLineRow from './ExpenseLineRow'
import type { RefundLine } from '../lib/requestsApi'

afterEach(() => {
  cleanup()
})

const line: RefundLine = {
  id: 'line-1',
  date: '2026-07-01',
  type: 'stationery',
  motivo: 'Pens',
  entity: 'welld_it',
  currency: 'EUR',
  requestedAmountCents: 1000,
  km: null,
  approvedTotalCents: null,
  attachments: [],
}

describe('ExpenseLineRow — edit mode', () => {
  it('commits a single PUT with the whole payload when focus leaves the row, not per keystroke', () => {
    const onCommit = vi.fn().mockResolvedValue(undefined)
    render(<ExpenseLineRow line={line} mode="edit" onCommit={onCommit} onDelete={vi.fn()} />)

    fireEvent.change(screen.getByTestId('row-line-1-motivo'), { target: { value: 'Pens and paper' } })
    expect(onCommit).not.toHaveBeenCalled()

    // Focus another element OUTSIDE the row — commits once.
    fireEvent.blur(screen.getByTestId('row-line-1-motivo'), { relatedTarget: document.body })

    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenCalledWith({
      date: '2026-07-01',
      type: 'stationery',
      motivo: 'Pens and paper',
      requestedAmountCents: 1000,
      entity: 'welld_it',
    })
  })

  it('does NOT commit when focus moves to another field inside the same row', () => {
    const onCommit = vi.fn().mockResolvedValue(undefined)
    render(<ExpenseLineRow line={line} mode="edit" onCommit={onCommit} onDelete={vi.fn()} />)

    fireEvent.change(screen.getByTestId('row-line-1-motivo'), { target: { value: 'Pens and paper' } })
    fireEvent.blur(screen.getByTestId('row-line-1-motivo'), { relatedTarget: screen.getByTestId('row-line-1-amount') })

    expect(onCommit).not.toHaveBeenCalled()
  })

  it('does not re-commit when nothing changed', () => {
    const onCommit = vi.fn().mockResolvedValue(undefined)
    render(<ExpenseLineRow line={line} mode="edit" onCommit={onCommit} onDelete={vi.fn()} />)

    fireEvent.blur(screen.getByTestId('row-line-1-motivo'), { relatedTarget: document.body })

    expect(onCommit).not.toHaveBeenCalled()
  })

  it('shows km only once type is changed to travel_km, hides it for any other type', () => {
    render(<ExpenseLineRow line={line} mode="edit" onCommit={vi.fn()} onDelete={vi.fn()} />)

    expect(screen.queryByTestId('row-line-1-km')).toBeNull()

    fireEvent.change(screen.getByTestId('row-line-1-type'), { target: { value: 'travel_km' } })
    expect(screen.getByTestId('row-line-1-km')).not.toBeNull()

    fireEvent.change(screen.getByTestId('row-line-1-type'), { target: { value: 'postal' } })
    expect(screen.queryByTestId('row-line-1-km')).toBeNull()
  })

  it('calls onDelete when the inline "×" is clicked, with no confirm modal', async () => {
    const onDelete = vi.fn().mockResolvedValue(undefined)
    render(<ExpenseLineRow line={line} mode="edit" onCommit={vi.fn()} onDelete={onDelete} />)

    fireEvent.click(screen.getByTestId('row-line-1-delete'))

    await waitFor(() => expect(onDelete).toHaveBeenCalledTimes(1))
    expect(screen.queryByTestId('confirm-delete-modal')).toBeNull()
  })

  it('renders an AttachmentList seam placeholder, not real upload machinery (T17 out of scope)', () => {
    render(<ExpenseLineRow line={line} mode="edit" onCommit={vi.fn()} onDelete={vi.fn()} />)
    expect(screen.getByTestId('row-line-1-attachments-seam')).not.toBeNull()
    expect(screen.queryByRole('button', { name: /attach/i })).toBeNull()
  })
})

describe('ExpenseLineRow — read-only modes', () => {
  it('readOnly renders no inputs and no delete control', () => {
    render(<ExpenseLineRow line={line} mode="readOnly" />)
    expect(screen.queryByTestId('row-line-1-motivo')).toBeNull()
    expect(screen.queryByTestId('row-line-1-delete')).toBeNull()
    expect(screen.getByText('Pens')).not.toBeNull()
  })

  it('readOnly shows only the requested amount, not an approved figure', () => {
    render(<ExpenseLineRow line={line} mode="readOnly" />)
    const row = screen.getByTestId('expense-line-row-line-1')
    expect(row.textContent).toContain('10,00 €')
    expect(row.textContent).not.toContain('Approved')
  })

  it('readOnlyApproved shows both requested and approved (AC-3.2)', () => {
    const approvedLine: RefundLine = { ...line, approvedTotalCents: 800 }
    render(<ExpenseLineRow line={approvedLine} mode="readOnlyApproved" />)
    const row = screen.getByTestId('expense-line-row-line-1')
    expect(row.textContent).toContain('10,00 €')
    expect(row.textContent).toContain('8,00 €')
  })
})
