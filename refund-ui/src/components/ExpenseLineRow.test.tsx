/**
 * @vitest-environment jsdom
 *
 * Component tests for ExpenseLineRow (T16/T17, specs/007-refund-service/
 * tasks.md; post-close UX amendment, specs/007, 2026-07-17 — see
 * `specs/007-refund-service/design.md`'s dated amendment note). Covers:
 * `edit` mode's collapsed-summary-by-default render, Edit expanding it to
 * the full field form and Done collapsing it back (still exercising the
 * blur-commit-as-one-PUT behavior, not per-keystroke), the line-delete
 * confirm modal (open → confirm → delete called; cancel → not deleted), the
 * `readOnly`/`readOnlyApproved` variants (AC-3.2: shows both requested and
 * approved), the km field's type-driven show/hide inside the expanded row,
 * and (T17) that each mode wires the real `AttachmentList`/
 * `AttachmentDownloadLink` rather than the T16 seam placeholder — the
 * attachment state machine itself is covered by AttachmentList.test.tsx;
 * these tests only assert the wiring (right mode, right callbacks reach the
 * child).
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import ExpenseLineRow from './ExpenseLineRow'
import type { Attachment, RefundLine } from '../lib/requestsApi'

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

const attachment: Attachment = { id: 'a1', fileName: 'receipt.pdf', contentType: 'application/pdf', sizeBytes: 2048 }

/** Clicks "Edit" on a collapsed summary row, expanding it to the full field form. */
const expandRow = (lineId = 'line-1') => fireEvent.click(screen.getByTestId(`row-${lineId}-edit`))

describe('ExpenseLineRow — edit mode, collapsed (default) summary', () => {
  it('renders a compact read-only summary — no field inputs — with Edit and Delete controls', () => {
    render(<ExpenseLineRow line={line} mode="edit" onCommit={vi.fn()} onDelete={vi.fn()} onDownloadAttachment={vi.fn()} />)

    expect(screen.queryByTestId('row-line-1-motivo')).toBeNull()
    expect(screen.queryByTestId('row-line-1-date')).toBeNull()
    expect(screen.getByText('Pens')).not.toBeNull()
    expect(screen.getByTestId('expense-line-row-line-1').textContent).toContain('10,00 €')
    expect(screen.getByTestId('row-line-1-edit')).not.toBeNull()
    expect(screen.getByTestId('row-line-1-delete')).not.toBeNull()
  })

  it('shows entity and currency as two separate badges, same as the read-only presentation', () => {
    render(
      <ExpenseLineRow line={{ ...line, entity: 'welld_it', currency: 'USD' }} mode="edit" onCommit={vi.fn()} onDelete={vi.fn()} onDownloadAttachment={vi.fn()} />,
    )
    expect(screen.getByTestId('entity-badge').textContent).toBe('🇮🇹WellD Italia')
    expect(screen.getByTestId('currency-badge').textContent).toBe('$USD')
  })

  it('shows a small attachment indicator when the line has attachments, without the full upload UI', () => {
    render(
      <ExpenseLineRow line={{ ...line, attachments: [attachment] }} mode="edit" onCommit={vi.fn()} onDelete={vi.fn()} onDownloadAttachment={vi.fn()} />,
    )
    expect(screen.getByTestId('row-line-1-attachments-indicator').textContent).toContain('1 file')
    expect(screen.queryByTestId('attachment-attach-button-line-1')).toBeNull()
    expect(screen.queryByTestId('attachment-list-line-1')).toBeNull()
  })

  it('shows no attachment indicator when the line has no attachments', () => {
    render(<ExpenseLineRow line={line} mode="edit" onCommit={vi.fn()} onDelete={vi.fn()} onDownloadAttachment={vi.fn()} />)
    expect(screen.queryByTestId('row-line-1-attachments-indicator')).toBeNull()
  })

  it('Edit carries a hover title tooltip naming the affordance', () => {
    render(<ExpenseLineRow line={line} mode="edit" onCommit={vi.fn()} onDelete={vi.fn()} onDownloadAttachment={vi.fn()} />)
    expect(screen.getByTestId('row-line-1-edit').getAttribute('title')).toBe('Edit this expense line')
    expect(screen.getByTestId('row-line-1-edit').getAttribute('aria-label')).toBe('Edit line “Pens”')
  })

  it('the Delete button carries a hover title tooltip and a line-naming aria-label', () => {
    render(<ExpenseLineRow line={line} mode="edit" onCommit={vi.fn()} onDelete={vi.fn()} onDownloadAttachment={vi.fn()} />)
    expect(screen.getByTestId('row-line-1-delete').getAttribute('title')).toBe('Delete this expense line')
    expect(screen.getByTestId('row-line-1-delete').getAttribute('aria-label')).toBe('Delete line “Pens”')
  })
})

describe('ExpenseLineRow — edit mode, expand/collapse', () => {
  it('clicking Edit expands the row to the full editable field layout and focuses the first field', () => {
    render(<ExpenseLineRow line={line} mode="edit" onCommit={vi.fn()} onDelete={vi.fn()} onDownloadAttachment={vi.fn()} />)

    expandRow()

    expect(screen.getByTestId('row-line-1-motivo')).not.toBeNull()
    expect(screen.getByTestId('row-line-1-date')).not.toBeNull()
    expect(document.activeElement).toBe(screen.getByTestId('row-line-1-date'))
    expect(screen.queryByTestId('row-line-1-edit')).toBeNull()
  })

  it('clicking Done collapses the row back to the summary and focuses the Edit button', () => {
    render(<ExpenseLineRow line={line} mode="edit" onCommit={vi.fn().mockResolvedValue(undefined)} onDelete={vi.fn()} onDownloadAttachment={vi.fn()} />)

    expandRow()
    fireEvent.click(screen.getByTestId('row-line-1-done'))

    expect(screen.queryByTestId('row-line-1-motivo')).toBeNull()
    expect(screen.getByTestId('row-line-1-edit')).not.toBeNull()
    expect(document.activeElement).toBe(screen.getByTestId('row-line-1-edit'))
  })

  it('Done commits a pending edit via the same commit path as blur-outside (an edit is never silently dropped)', async () => {
    const onCommit = vi.fn().mockResolvedValue(undefined)
    render(<ExpenseLineRow line={line} mode="edit" onCommit={onCommit} onDelete={vi.fn()} onDownloadAttachment={vi.fn()} />)

    expandRow()
    fireEvent.change(screen.getByTestId('row-line-1-motivo'), { target: { value: 'Pens and paper' } })
    fireEvent.click(screen.getByTestId('row-line-1-done'))

    await waitFor(() => expect(onCommit).toHaveBeenCalledWith(expect.objectContaining({ motivo: 'Pens and paper' })))
  })
})

describe('ExpenseLineRow — expanded edit form', () => {
  it('commits a single PUT with the whole payload when focus leaves the row, not per keystroke', () => {
    const onCommit = vi.fn().mockResolvedValue(undefined)
    render(<ExpenseLineRow line={line} mode="edit" onCommit={onCommit} onDelete={vi.fn()} onDownloadAttachment={vi.fn()} />)
    expandRow()

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
      currency: 'EUR',
    })
  })

  it('lets currency be changed independently of entity, committing a mismatched pair with no block', () => {
    const onCommit = vi.fn().mockResolvedValue(undefined)
    render(<ExpenseLineRow line={line} mode="edit" onCommit={onCommit} onDelete={vi.fn()} onDownloadAttachment={vi.fn()} />)
    expandRow()

    fireEvent.change(screen.getByTestId('row-line-1-currency'), { target: { value: 'USD' } })
    fireEvent.blur(screen.getByTestId('row-line-1-currency'), { relatedTarget: document.body })

    expect(onCommit).toHaveBeenCalledWith(expect.objectContaining({ entity: 'welld_it', currency: 'USD' }))
  })

  it('does NOT commit when focus moves to another field inside the same row', () => {
    const onCommit = vi.fn().mockResolvedValue(undefined)
    render(<ExpenseLineRow line={line} mode="edit" onCommit={onCommit} onDelete={vi.fn()} onDownloadAttachment={vi.fn()} />)
    expandRow()

    fireEvent.change(screen.getByTestId('row-line-1-motivo'), { target: { value: 'Pens and paper' } })
    fireEvent.blur(screen.getByTestId('row-line-1-motivo'), { relatedTarget: screen.getByTestId('row-line-1-amount') })

    expect(onCommit).not.toHaveBeenCalled()
  })

  it('does not re-commit when nothing changed', () => {
    const onCommit = vi.fn().mockResolvedValue(undefined)
    render(<ExpenseLineRow line={line} mode="edit" onCommit={onCommit} onDelete={vi.fn()} onDownloadAttachment={vi.fn()} />)
    expandRow()

    fireEvent.blur(screen.getByTestId('row-line-1-motivo'), { relatedTarget: document.body })

    expect(onCommit).not.toHaveBeenCalled()
  })

  it('shows km only once type is changed to travel_km, hides it for any other type', () => {
    render(<ExpenseLineRow line={line} mode="edit" onCommit={vi.fn()} onDelete={vi.fn()} onDownloadAttachment={vi.fn()} />)
    expandRow()

    expect(screen.queryByTestId('row-line-1-km')).toBeNull()

    fireEvent.change(screen.getByTestId('row-line-1-type'), { target: { value: 'travel_km' } })
    expect(screen.getByTestId('row-line-1-km')).not.toBeNull()

    fireEvent.change(screen.getByTestId('row-line-1-type'), { target: { value: 'postal' } })
    expect(screen.queryByTestId('row-line-1-km')).toBeNull()
  })

  it('renders the real AttachmentList in upload/remove mode (T17 fills the T16 seam)', () => {
    render(
      <ExpenseLineRow
        line={{ ...line, attachments: [attachment] }}
        mode="edit"
        onCommit={vi.fn()}
        onDelete={vi.fn()}
        onUploadAttachment={vi.fn()}
        onRemoveAttachment={vi.fn()}
        onDownloadAttachment={vi.fn()}
      />,
    )
    expandRow()

    expect(screen.queryByTestId('row-line-1-attachments-seam')).toBeNull()
    expect(screen.getByTestId('attachment-list-line-1')).not.toBeNull()
    expect(screen.getByTestId('attachment-attach-button-line-1')).not.toBeNull()
    expect(screen.getByTestId('attachment-remove-a1')).not.toBeNull()
  })
})

describe('ExpenseLineRow — line-delete confirm modal (post-close amendment)', () => {
  it('clicking Delete opens ConfirmDeleteModal naming the line, without calling onDelete yet', () => {
    const onDelete = vi.fn()
    render(<ExpenseLineRow line={line} mode="edit" onCommit={vi.fn()} onDelete={onDelete} onDownloadAttachment={vi.fn()} />)

    fireEvent.click(screen.getByTestId('row-line-1-delete'))

    expect(screen.getByTestId('row-line-1-delete-confirm-modal')).not.toBeNull()
    expect(screen.getByTestId('row-line-1-delete-confirm-modal').textContent).toContain('Stationery')
    expect(screen.getByTestId('row-line-1-delete-confirm-modal').textContent).toContain('Pens')
    expect(onDelete).not.toHaveBeenCalled()
  })

  it('confirming calls onDelete', async () => {
    const onDelete = vi.fn().mockResolvedValue(undefined)
    render(<ExpenseLineRow line={line} mode="edit" onCommit={vi.fn()} onDelete={onDelete} onDownloadAttachment={vi.fn()} />)

    fireEvent.click(screen.getByTestId('row-line-1-delete'))
    fireEvent.click(screen.getByTestId('row-line-1-delete-confirm-confirm'))

    await waitFor(() => expect(onDelete).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.queryByTestId('row-line-1-delete-confirm-modal')).toBeNull())
  })

  it('canceling does not call onDelete and keeps the line as a summary', () => {
    const onDelete = vi.fn()
    render(<ExpenseLineRow line={line} mode="edit" onCommit={vi.fn()} onDelete={onDelete} onDownloadAttachment={vi.fn()} />)

    fireEvent.click(screen.getByTestId('row-line-1-delete'))
    fireEvent.click(screen.getByTestId('row-line-1-delete-confirm-cancel'))

    expect(screen.queryByTestId('row-line-1-delete-confirm-modal')).toBeNull()
    expect(onDelete).not.toHaveBeenCalled()
    expect(screen.getByText('Pens')).not.toBeNull()
  })

  it('shows an inline error in the modal and keeps it open when onDelete rejects', async () => {
    const onDelete = vi.fn().mockRejectedValue(new Error('boom'))
    render(<ExpenseLineRow line={line} mode="edit" onCommit={vi.fn()} onDelete={onDelete} onDownloadAttachment={vi.fn()} />)

    fireEvent.click(screen.getByTestId('row-line-1-delete'))
    fireEvent.click(screen.getByTestId('row-line-1-delete-confirm-confirm'))

    await waitFor(() => expect(screen.getByTestId('row-line-1-delete-confirm-error')).not.toBeNull())
    expect(screen.getByTestId('row-line-1-delete-confirm-modal')).not.toBeNull()
  })
})

describe('ExpenseLineRow — read-only modes', () => {
  it('readOnly renders no inputs and no delete control', () => {
    render(<ExpenseLineRow line={line} mode="readOnly" onDownloadAttachment={vi.fn()} />)
    expect(screen.queryByTestId('row-line-1-motivo')).toBeNull()
    expect(screen.queryByTestId('row-line-1-delete')).toBeNull()
    expect(screen.queryByTestId('row-line-1-edit')).toBeNull()
    expect(screen.getByText('Pens')).not.toBeNull()
  })

  it('readOnly shows only the requested amount, not an approved figure', () => {
    render(<ExpenseLineRow line={line} mode="readOnly" onDownloadAttachment={vi.fn()} />)
    const row = screen.getByTestId('expense-line-row-line-1')
    expect(row.textContent).toContain('10,00 €')
    expect(row.textContent).not.toContain('Approved')
  })

  it('readOnly shows the entity and currency as two separate badges (post-close split, specs/007)', () => {
    render(<ExpenseLineRow line={{ ...line, entity: 'welld_it', currency: 'USD' }} mode="readOnly" onDownloadAttachment={vi.fn()} />)
    const row = screen.getByTestId('expense-line-row-line-1')
    expect(screen.getByTestId('entity-badge').textContent).toBe('🇮🇹WellD Italia')
    expect(screen.getByTestId('currency-badge').textContent).toBe('$USD')
    expect(row.textContent).not.toContain('WellD Italia · EUR')
  })

  it('readOnlyApproved shows both requested and approved (AC-3.2)', () => {
    const approvedLine: RefundLine = { ...line, approvedTotalCents: 800 }
    render(<ExpenseLineRow line={approvedLine} mode="readOnlyApproved" onDownloadAttachment={vi.fn()} />)
    const row = screen.getByTestId('expense-line-row-line-1')
    expect(row.textContent).toContain('10,00 €')
    expect(row.textContent).toContain('8,00 €')
  })

  it('readOnly/readOnlyApproved render attachments download-only — no upload trigger, no Remove button', () => {
    render(
      <ExpenseLineRow line={{ ...line, attachments: [attachment] }} mode="readOnly" onDownloadAttachment={vi.fn()} />,
    )
    expect(screen.getByTestId('attachment-download-a1')).not.toBeNull()
    expect(screen.queryByTestId('attachment-remove-a1')).toBeNull()
    expect(screen.queryByTestId('attachment-attach-button-line-1')).toBeNull()
  })
})

describe('ExpenseLineRow — review mode (T18, accounting)', () => {
  it('renders read-only fields (no edit inputs) plus a pre-filled approved-total input defaulting to the requested amount', () => {
    render(<ExpenseLineRow line={line} mode="review" onDownloadAttachment={vi.fn()} onApprovedTotalChange={vi.fn()} />)

    expect(screen.queryByTestId('row-line-1-motivo')).toBeNull()
    expect(screen.queryByTestId('row-line-1-delete')).toBeNull()
    const input = screen.getByTestId('row-line-1-approved-total') as HTMLInputElement
    expect(input.value).toBe('10.00')
  })

  it('pre-fills from an already-set approvedTotalCents, not the requested amount, when one exists', () => {
    render(
      <ExpenseLineRow
        line={{ ...line, approvedTotalCents: 750 }}
        mode="review"
        onDownloadAttachment={vi.fn()}
        onApprovedTotalChange={vi.fn()}
      />,
    )
    expect((screen.getByTestId('row-line-1-approved-total') as HTMLInputElement).value).toBe('7.50')
  })

  it('the approved-total input carries a full row-identity aria-label (design.md Accessibility)', () => {
    render(<ExpenseLineRow line={line} mode="review" onDownloadAttachment={vi.fn()} onApprovedTotalChange={vi.fn()} />)

    const input = screen.getByTestId('row-line-1-approved-total')
    expect(input.getAttribute('aria-label')).toBe('Approved total for 2026-07-01 · Pens · EUR')
  })

  it('write-on-change-only: does NOT call onApprovedTotalChange when the field blurs untouched', () => {
    const onApprovedTotalChange = vi.fn()
    render(<ExpenseLineRow line={line} mode="review" onDownloadAttachment={vi.fn()} onApprovedTotalChange={onApprovedTotalChange} />)

    fireEvent.blur(screen.getByTestId('row-line-1-approved-total'))

    expect(onApprovedTotalChange).not.toHaveBeenCalled()
  })

  it('calls onApprovedTotalChange with the new cents value once changed and blurred', async () => {
    const onApprovedTotalChange = vi.fn().mockResolvedValue(undefined)
    render(<ExpenseLineRow line={line} mode="review" onDownloadAttachment={vi.fn()} onApprovedTotalChange={onApprovedTotalChange} />)

    const input = screen.getByTestId('row-line-1-approved-total')
    fireEvent.change(input, { target: { value: '7.50' } })
    fireEvent.blur(input)

    await waitFor(() => expect(onApprovedTotalChange).toHaveBeenCalledWith(750))
  })

  it('reverting to the original default before blur still counts as untouched — no write', () => {
    const onApprovedTotalChange = vi.fn()
    render(<ExpenseLineRow line={line} mode="review" onDownloadAttachment={vi.fn()} onApprovedTotalChange={onApprovedTotalChange} />)

    const input = screen.getByTestId('row-line-1-approved-total')
    fireEvent.change(input, { target: { value: '7.50' } })
    fireEvent.change(input, { target: { value: '10.00' } })
    fireEvent.blur(input)

    expect(onApprovedTotalChange).not.toHaveBeenCalled()
  })

  it('shows an inline error on an invalid amount, without calling onApprovedTotalChange', () => {
    const onApprovedTotalChange = vi.fn()
    render(<ExpenseLineRow line={line} mode="review" onDownloadAttachment={vi.fn()} onApprovedTotalChange={onApprovedTotalChange} />)

    const input = screen.getByTestId('row-line-1-approved-total')
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.blur(input)

    expect(screen.getByTestId('row-line-1-approved-total-error').textContent).toBe('Enter a valid, non-negative amount.')
    expect(onApprovedTotalChange).not.toHaveBeenCalled()
  })

  it('renders attachments download-only (same as readOnly)', () => {
    render(
      <ExpenseLineRow
        line={{ ...line, attachments: [attachment] }}
        mode="review"
        onDownloadAttachment={vi.fn()}
        onApprovedTotalChange={vi.fn()}
      />,
    )
    expect(screen.getByTestId('attachment-download-a1')).not.toBeNull()
    expect(screen.queryByTestId('attachment-remove-a1')).toBeNull()
  })
})
