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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import ExpenseLineRow from './ExpenseLineRow'
import type { Attachment, MileageInfo, RefundLine } from '../lib/requestsApi'
import { ApiError } from '../lib/refundApi'
import { strings } from '../strings'

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

const appliedRate: NonNullable<MileageInfo['appliedRate']> = {
  ratePerKmMicros: 700000,
  ratePerKm: '0.70',
  validFrom: '2026-01-01',
  currency: 'CHF',
}

const submittedMileageLine: RefundLine = {
  id: 'line-km-1',
  date: '2026-07-01',
  type: 'travel_km',
  motivo: 'Client visit',
  entity: 'welld_ch',
  currency: 'CHF',
  requestedAmountCents: 16800,
  km: 240,
  approvedTotalCents: null,
  attachments: [],
  mileage: { km: 240, rateInEffect: true, appliedRate, computedAmountCents: 16800, snapshotted: true },
}

/** Clicks "Edit" on a collapsed summary row, expanding it to the full field form. */
const expandRow = (lineId = 'line-1') => fireEvent.click(screen.getByTestId(`row-${lineId}-edit`))

describe('ExpenseLineRow — edit mode, collapsed (default) summary', () => {
  it('renders a compact read-only summary — no field inputs — with Edit and Delete controls', () => {
    render(
      <ExpenseLineRow line={line} mode="edit" onCommit={vi.fn()} onDelete={vi.fn()} onDownloadAttachment={vi.fn()} />,
    )

    expect(screen.queryByTestId('row-line-1-motivo')).toBeNull()
    expect(screen.queryByTestId('row-line-1-date')).toBeNull()
    expect(screen.getByText('Pens')).not.toBeNull()
    expect(screen.getByTestId('expense-line-row-line-1').textContent).toContain('10,00 €')
    expect(screen.getByTestId('row-line-1-edit')).not.toBeNull()
    expect(screen.getByTestId('row-line-1-delete')).not.toBeNull()
  })

  it('shows entity and currency as two separate badges, same as the read-only presentation', () => {
    render(
      <ExpenseLineRow
        line={{ ...line, entity: 'welld_it', currency: 'USD' }}
        mode="edit"
        onCommit={vi.fn()}
        onDelete={vi.fn()}
        onDownloadAttachment={vi.fn()}
      />,
    )
    expect(screen.getByTestId('entity-badge').textContent).toBe('🇮🇹WellD Italia')
    expect(screen.getByTestId('currency-badge').textContent).toBe('$USD')
  })

  it('shows a small attachment indicator when the line has attachments, without the full upload UI', () => {
    render(
      <ExpenseLineRow
        line={{ ...line, attachments: [attachment] }}
        mode="edit"
        onCommit={vi.fn()}
        onDelete={vi.fn()}
        onDownloadAttachment={vi.fn()}
      />,
    )
    expect(screen.getByTestId('row-line-1-attachments-indicator').textContent).toContain('1 file')
    expect(screen.queryByTestId('attachment-attach-button-line-1')).toBeNull()
    expect(screen.queryByTestId('attachment-list-line-1')).toBeNull()
  })

  it('shows no attachment indicator when the line has no attachments', () => {
    render(
      <ExpenseLineRow line={line} mode="edit" onCommit={vi.fn()} onDelete={vi.fn()} onDownloadAttachment={vi.fn()} />,
    )
    expect(screen.queryByTestId('row-line-1-attachments-indicator')).toBeNull()
  })

  it('Edit carries a hover title tooltip naming the affordance', () => {
    render(
      <ExpenseLineRow line={line} mode="edit" onCommit={vi.fn()} onDelete={vi.fn()} onDownloadAttachment={vi.fn()} />,
    )
    expect(screen.getByTestId('row-line-1-edit').getAttribute('title')).toBe('Edit this expense line')
    expect(screen.getByTestId('row-line-1-edit').getAttribute('aria-label')).toBe('Edit line “Pens”')
  })

  it('the Delete button carries a hover title tooltip and a line-naming aria-label', () => {
    render(
      <ExpenseLineRow line={line} mode="edit" onCommit={vi.fn()} onDelete={vi.fn()} onDownloadAttachment={vi.fn()} />,
    )
    expect(screen.getByTestId('row-line-1-delete').getAttribute('title')).toBe('Delete this expense line')
    expect(screen.getByTestId('row-line-1-delete').getAttribute('aria-label')).toBe('Delete line “Pens”')
  })
})

describe('ExpenseLineRow — edit mode, expand/collapse', () => {
  it('clicking Edit expands the row to the full editable field layout and focuses the first field', () => {
    render(
      <ExpenseLineRow line={line} mode="edit" onCommit={vi.fn()} onDelete={vi.fn()} onDownloadAttachment={vi.fn()} />,
    )

    expandRow()

    expect(screen.getByTestId('row-line-1-motivo')).not.toBeNull()
    expect(screen.getByTestId('row-line-1-date')).not.toBeNull()
    expect(document.activeElement).toBe(screen.getByTestId('row-line-1-date'))
    expect(screen.queryByTestId('row-line-1-edit')).toBeNull()
  })

  it('clicking Done collapses the row back to the summary and focuses the Edit button', () => {
    render(
      <ExpenseLineRow
        line={line}
        mode="edit"
        onCommit={vi.fn().mockResolvedValue(undefined)}
        onDelete={vi.fn()}
        onDownloadAttachment={vi.fn()}
      />,
    )

    expandRow()
    fireEvent.click(screen.getByTestId('row-line-1-done'))

    expect(screen.queryByTestId('row-line-1-motivo')).toBeNull()
    expect(screen.getByTestId('row-line-1-edit')).not.toBeNull()
    expect(document.activeElement).toBe(screen.getByTestId('row-line-1-edit'))
  })

  it('Done commits a pending edit via the same commit path as blur-outside (an edit is never silently dropped)', async () => {
    const onCommit = vi.fn().mockResolvedValue(undefined)
    render(
      <ExpenseLineRow line={line} mode="edit" onCommit={onCommit} onDelete={vi.fn()} onDownloadAttachment={vi.fn()} />,
    )

    expandRow()
    fireEvent.change(screen.getByTestId('row-line-1-motivo'), { target: { value: 'Pens and paper' } })
    fireEvent.click(screen.getByTestId('row-line-1-done'))

    await waitFor(() => expect(onCommit).toHaveBeenCalledWith(expect.objectContaining({ motivo: 'Pens and paper' })))
  })
})

describe('ExpenseLineRow — expanded edit form', () => {
  it('commits a single PUT with the whole payload when focus leaves the row, not per keystroke', () => {
    const onCommit = vi.fn().mockResolvedValue(undefined)
    render(
      <ExpenseLineRow line={line} mode="edit" onCommit={onCommit} onDelete={vi.fn()} onDownloadAttachment={vi.fn()} />,
    )
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
    render(
      <ExpenseLineRow line={line} mode="edit" onCommit={onCommit} onDelete={vi.fn()} onDownloadAttachment={vi.fn()} />,
    )
    expandRow()

    fireEvent.change(screen.getByTestId('row-line-1-currency'), { target: { value: 'USD' } })
    fireEvent.blur(screen.getByTestId('row-line-1-currency'), { relatedTarget: document.body })

    expect(onCommit).toHaveBeenCalledWith(expect.objectContaining({ entity: 'welld_it', currency: 'USD' }))
  })

  it('does NOT commit when focus moves to another field inside the same row', () => {
    const onCommit = vi.fn().mockResolvedValue(undefined)
    render(
      <ExpenseLineRow line={line} mode="edit" onCommit={onCommit} onDelete={vi.fn()} onDownloadAttachment={vi.fn()} />,
    )
    expandRow()

    fireEvent.change(screen.getByTestId('row-line-1-motivo'), { target: { value: 'Pens and paper' } })
    fireEvent.blur(screen.getByTestId('row-line-1-motivo'), { relatedTarget: screen.getByTestId('row-line-1-amount') })

    expect(onCommit).not.toHaveBeenCalled()
  })

  it('does not re-commit when nothing changed', () => {
    const onCommit = vi.fn().mockResolvedValue(undefined)
    render(
      <ExpenseLineRow line={line} mode="edit" onCommit={onCommit} onDelete={vi.fn()} onDownloadAttachment={vi.fn()} />,
    )
    expandRow()

    fireEvent.blur(screen.getByTestId('row-line-1-motivo'), { relatedTarget: document.body })

    expect(onCommit).not.toHaveBeenCalled()
  })

  it('shows km only once type is changed to travel_km, hides it for any other type', () => {
    render(
      <ExpenseLineRow line={line} mode="edit" onCommit={vi.fn()} onDelete={vi.fn()} onDownloadAttachment={vi.fn()} />,
    )
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
    render(
      <ExpenseLineRow line={line} mode="edit" onCommit={vi.fn()} onDelete={onDelete} onDownloadAttachment={vi.fn()} />,
    )

    fireEvent.click(screen.getByTestId('row-line-1-delete'))

    expect(screen.getByTestId('row-line-1-delete-confirm-modal')).not.toBeNull()
    expect(screen.getByTestId('row-line-1-delete-confirm-modal').textContent).toContain('Stationery')
    expect(screen.getByTestId('row-line-1-delete-confirm-modal').textContent).toContain('Pens')
    expect(onDelete).not.toHaveBeenCalled()
  })

  it('confirming calls onDelete', async () => {
    const onDelete = vi.fn().mockResolvedValue(undefined)
    render(
      <ExpenseLineRow line={line} mode="edit" onCommit={vi.fn()} onDelete={onDelete} onDownloadAttachment={vi.fn()} />,
    )

    fireEvent.click(screen.getByTestId('row-line-1-delete'))
    fireEvent.click(screen.getByTestId('row-line-1-delete-confirm-confirm'))

    await waitFor(() => expect(onDelete).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.queryByTestId('row-line-1-delete-confirm-modal')).toBeNull())
  })

  it('canceling does not call onDelete and keeps the line as a summary', () => {
    const onDelete = vi.fn()
    render(
      <ExpenseLineRow line={line} mode="edit" onCommit={vi.fn()} onDelete={onDelete} onDownloadAttachment={vi.fn()} />,
    )

    fireEvent.click(screen.getByTestId('row-line-1-delete'))
    fireEvent.click(screen.getByTestId('row-line-1-delete-confirm-cancel'))

    expect(screen.queryByTestId('row-line-1-delete-confirm-modal')).toBeNull()
    expect(onDelete).not.toHaveBeenCalled()
    expect(screen.getByText('Pens')).not.toBeNull()
  })

  it('shows an inline error in the modal and keeps it open when onDelete rejects', async () => {
    const onDelete = vi.fn().mockRejectedValue(new Error('boom'))
    render(
      <ExpenseLineRow line={line} mode="edit" onCommit={vi.fn()} onDelete={onDelete} onDownloadAttachment={vi.fn()} />,
    )

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
    render(
      <ExpenseLineRow
        line={{ ...line, entity: 'welld_it', currency: 'USD' }}
        mode="readOnly"
        onDownloadAttachment={vi.fn()}
      />,
    )
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
    render(
      <ExpenseLineRow
        line={line}
        mode="review"
        onDownloadAttachment={vi.fn()}
        onApprovedTotalChange={onApprovedTotalChange}
      />,
    )

    fireEvent.blur(screen.getByTestId('row-line-1-approved-total'))

    expect(onApprovedTotalChange).not.toHaveBeenCalled()
  })

  it('calls onApprovedTotalChange with the new cents value once changed and blurred', async () => {
    const onApprovedTotalChange = vi.fn().mockResolvedValue(undefined)
    render(
      <ExpenseLineRow
        line={line}
        mode="review"
        onDownloadAttachment={vi.fn()}
        onApprovedTotalChange={onApprovedTotalChange}
      />,
    )

    const input = screen.getByTestId('row-line-1-approved-total')
    fireEvent.change(input, { target: { value: '7.50' } })
    fireEvent.blur(input)

    await waitFor(() => expect(onApprovedTotalChange).toHaveBeenCalledWith(750))
  })

  it('reverting to the original default before blur still counts as untouched — no write', () => {
    const onApprovedTotalChange = vi.fn()
    render(
      <ExpenseLineRow
        line={line}
        mode="review"
        onDownloadAttachment={vi.fn()}
        onApprovedTotalChange={onApprovedTotalChange}
      />,
    )

    const input = screen.getByTestId('row-line-1-approved-total')
    fireEvent.change(input, { target: { value: '7.50' } })
    fireEvent.change(input, { target: { value: '10.00' } })
    fireEvent.blur(input)

    expect(onApprovedTotalChange).not.toHaveBeenCalled()
  })

  it('shows an inline error on an invalid amount, without calling onApprovedTotalChange', () => {
    const onApprovedTotalChange = vi.fn()
    render(
      <ExpenseLineRow
        line={line}
        mode="review"
        onDownloadAttachment={vi.fn()}
        onApprovedTotalChange={onApprovedTotalChange}
      />,
    )

    const input = screen.getByTestId('row-line-1-approved-total')
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.blur(input)

    expect(screen.getByTestId('row-line-1-approved-total-error').textContent).toBe(
      'Enter a valid, non-negative amount.',
    )
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

// -----------------------------------------------------------------------------
// specs/009-mileage-rate — travel_km lines: hidden amount/currency + the
// live MileageAmountField in expanded edit mode (AC-1.1/1.5/1.6), and the
// "Rate applied" dt/dd + km-annotation across every summaryCore render
// (AC-6.4, AC-1.7/1.8).
// -----------------------------------------------------------------------------

describe('ExpenseLineRow — edit mode, expanded, travel_km (specs/009-mileage-rate)', () => {
  const kmLine: RefundLine = {
    ...line,
    id: 'km-1',
    type: 'travel_km',
    km: 50,
    mileage: { km: 50, rateInEffect: true, appliedRate: null, computedAmountCents: null, snapshotted: false },
  }

  it('hides Amount/Currency and renders MileageAmountField instead', () => {
    render(
      <ExpenseLineRow line={kmLine} mode="edit" onCommit={vi.fn()} onDelete={vi.fn()} onDownloadAttachment={vi.fn()} />,
    )
    fireEvent.click(screen.getByTestId('row-km-1-edit'))

    expect(screen.queryByTestId('row-km-1-amount')).toBeNull()
    expect(screen.queryByTestId('row-km-1-currency')).toBeNull()
    expect(screen.getByTestId('mileage-amount-field')).not.toBeNull()
    // km itself is unaffected — still the plain existing field.
    expect(screen.getByTestId('row-km-1-km')).not.toBeNull()
  })

  it('shows Amount/Currency (no MileageAmountField) once switched to a non-km type', () => {
    render(
      <ExpenseLineRow line={kmLine} mode="edit" onCommit={vi.fn()} onDelete={vi.fn()} onDownloadAttachment={vi.fn()} />,
    )
    fireEvent.click(screen.getByTestId('row-km-1-edit'))
    fireEvent.change(screen.getByTestId('row-km-1-type'), { target: { value: 'postal' } })

    expect(screen.getByTestId('row-km-1-amount')).not.toBeNull()
    expect(screen.getByTestId('row-km-1-currency')).not.toBeNull()
    expect(screen.queryByTestId('mileage-amount-field')).toBeNull()
  })

  it('commits a PUT with km but WITHOUT requestedAmountCents/currency (AC-1.1/1.6)', async () => {
    const onCommit = vi.fn().mockResolvedValue(undefined)
    render(
      <ExpenseLineRow
        line={kmLine}
        mode="edit"
        onCommit={onCommit}
        onDelete={vi.fn()}
        onDownloadAttachment={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByTestId('row-km-1-edit'))

    fireEvent.change(screen.getByTestId('row-km-1-km'), { target: { value: '75' } })
    fireEvent.blur(screen.getByTestId('row-km-1-km'), { relatedTarget: document.body })

    await waitFor(() =>
      expect(onCommit).toHaveBeenCalledWith({
        date: kmLine.date,
        type: 'travel_km',
        motivo: kmLine.motivo,
        entity: kmLine.entity,
        km: 75,
      }),
    )
  })
})

describe('ExpenseLineRow — summaryCore, travel_km (specs/009-mileage-rate)', () => {
  it('collapsed edit-mode summary appends the live applied rate next to km, and shows the live computed amount (AC-1.7/1.8)', () => {
    const draftKmLine: RefundLine = {
      ...line,
      id: 'km-2',
      currency: 'CHF',
      requestedAmountCents: 16800,
      type: 'travel_km',
      km: 240,
      mileage: { km: 240, rateInEffect: true, appliedRate, computedAmountCents: 16800, snapshotted: false },
    }
    render(
      <ExpenseLineRow
        line={draftKmLine}
        mode="edit"
        onCommit={vi.fn()}
        onDelete={vi.fn()}
        onDownloadAttachment={vi.fn()}
      />,
    )

    const row = screen.getByTestId('expense-line-row-km-2')
    expect(row.textContent).toContain('240 km × 0,70 CHF/km')
    expect(row.textContent).toContain('168,00 CHF')
  })

  it('shows "—" for the Requested amount when the mileage line is blocked (no rate in effect, AC-2.2)', () => {
    const blockedLine: RefundLine = {
      ...line,
      id: 'km-3',
      type: 'travel_km',
      km: 10,
      mileage: { km: 10, rateInEffect: false, appliedRate: null, computedAmountCents: null, snapshotted: false },
    }
    render(
      <ExpenseLineRow
        line={blockedLine}
        mode="edit"
        onCommit={vi.fn()}
        onDelete={vi.fn()}
        onDownloadAttachment={vi.fn()}
      />,
    )

    const row = screen.getByTestId('expense-line-row-km-3')
    expect(row.textContent).toContain('—')
    expect(row.textContent).not.toContain('CHF')
  })

  it('renders "Rate applied" with the rate and valid-from once a travel_km line has ever been submitted (AC-6.4)', () => {
    render(<ExpenseLineRow line={submittedMileageLine} mode="readOnly" onDownloadAttachment={vi.fn()} />)

    const row = screen.getByTestId('expense-line-row-line-km-1')
    expect(row.textContent).toContain('Rate applied')
    expect(row.textContent).toContain('0,70 CHF/km')
    expect(row.textContent).toContain('valid from')
  })

  it('renders "Rate applied" in review mode too, without disturbing the approved-total input (AC-6.1/6.4)', () => {
    render(
      <ExpenseLineRow
        line={submittedMileageLine}
        mode="review"
        onDownloadAttachment={vi.fn()}
        onApprovedTotalChange={vi.fn()}
      />,
    )

    expect(screen.getByTestId('expense-line-row-line-km-1').textContent).toContain('Rate applied')
    const input = screen.getByTestId('row-line-km-1-approved-total') as HTMLInputElement
    expect(input.value).toBe('168.00')
  })

  it('renders "Rate applied" in readOnlyApproved mode too', () => {
    render(<ExpenseLineRow line={submittedMileageLine} mode="readOnlyApproved" onDownloadAttachment={vi.fn()} />)
    expect(screen.getByTestId('expense-line-row-line-km-1').textContent).toContain('Rate applied')
  })

  it('omits the "Rate applied" row for a legacy pre-feature line (appliedRate null) — amount only, no error (AC-1.7, R3)', () => {
    const legacyLine: RefundLine = {
      ...submittedMileageLine,
      id: 'legacy-1',
      mileage: { km: 240, rateInEffect: true, appliedRate: null, computedAmountCents: null, snapshotted: true },
    }
    render(<ExpenseLineRow line={legacyLine} mode="readOnly" onDownloadAttachment={vi.fn()} />)

    const row = screen.getByTestId('expense-line-row-legacy-1')
    expect(row.textContent).not.toContain('Rate applied')
    expect(row.textContent).toContain('168,00 CHF') // the stored amount still renders exactly as before this feature
  })

  it('omits the "Rate applied" row and the km-annotation for a non-travel_km line (mileage: null), unaffected (AC-1.5)', () => {
    render(<ExpenseLineRow line={line} mode="readOnly" onDownloadAttachment={vi.fn()} />)
    const row = screen.getByTestId('expense-line-row-line-1')
    expect(row.textContent).not.toContain('Rate applied')
  })

  it('omits the "Rate applied" row for a fixture that predates this field entirely (mileage undefined) — no crash', () => {
    render(
      <ExpenseLineRow line={line} mode="edit" onCommit={vi.fn()} onDelete={vi.fn()} onDownloadAttachment={vi.fn()} />,
    )
    expect(screen.getByTestId('expense-line-row-line-1').textContent).not.toContain('Rate applied')
  })
})

// -----------------------------------------------------------------------------
// Debounced auto-save (content-app auto-save, specs/NNN) — fake timers so the
// 1500ms debounce and its cancellation-on-flush can be asserted deterministically.
// -----------------------------------------------------------------------------

describe('ExpenseLineRow — debounced auto-save (edit mode, expanded)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('auto-commits a single PUT ~1500ms after the last edit to a valid, dirty line', async () => {
    const onCommit = vi.fn().mockResolvedValue(undefined)
    render(
      <ExpenseLineRow line={line} mode="edit" onCommit={onCommit} onDelete={vi.fn()} onDownloadAttachment={vi.fn()} />,
    )
    expandRow()

    fireEvent.change(screen.getByTestId('row-line-1-motivo'), { target: { value: 'Pens and paper' } })
    expect(onCommit).not.toHaveBeenCalled()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1499)
    })
    expect(onCommit).not.toHaveBeenCalled()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenCalledWith(expect.objectContaining({ motivo: 'Pens and paper' }))
  })

  it('resets the debounce clock on every further edit — only the last edit is auto-saved', async () => {
    const onCommit = vi.fn().mockResolvedValue(undefined)
    render(
      <ExpenseLineRow line={line} mode="edit" onCommit={onCommit} onDelete={vi.fn()} onDownloadAttachment={vi.fn()} />,
    )
    expandRow()

    fireEvent.change(screen.getByTestId('row-line-1-motivo'), { target: { value: 'Pens' } })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    fireEvent.change(screen.getByTestId('row-line-1-motivo'), { target: { value: 'Pens and paper' } })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(onCommit).not.toHaveBeenCalled() // only 1000ms since the latest edit — not yet 1500ms

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenCalledWith(expect.objectContaining({ motivo: 'Pens and paper' }))
  })

  it('does NOT auto-save an incomplete/invalid draft, even after 1500ms — never a spurious PUT', async () => {
    const onCommit = vi.fn().mockResolvedValue(undefined)
    render(
      <ExpenseLineRow line={line} mode="edit" onCommit={onCommit} onDelete={vi.fn()} onDownloadAttachment={vi.fn()} />,
    )
    expandRow()

    // Clearing motivo (a required field) makes the draft incomplete per isLineDraftComplete.
    fireEvent.change(screen.getByTestId('row-line-1-motivo'), { target: { value: '' } })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000)
    })
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('blur-outside flushes immediately and cancels the pending debounce — no double-PUT', async () => {
    const onCommit = vi.fn().mockResolvedValue(undefined)
    render(
      <ExpenseLineRow line={line} mode="edit" onCommit={onCommit} onDelete={vi.fn()} onDownloadAttachment={vi.fn()} />,
    )
    expandRow()

    fireEvent.change(screen.getByTestId('row-line-1-motivo'), { target: { value: 'Pens and paper' } })

    await act(async () => {
      fireEvent.blur(screen.getByTestId('row-line-1-motivo'), { relatedTarget: document.body })
    })
    expect(onCommit).toHaveBeenCalledTimes(1)

    // The debounce timer scheduled by the earlier keystroke must not also fire.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })
    expect(onCommit).toHaveBeenCalledTimes(1)
  })

  it('Done flushes immediately and cancels the pending debounce — no double-PUT', async () => {
    const onCommit = vi.fn().mockResolvedValue(undefined)
    render(
      <ExpenseLineRow line={line} mode="edit" onCommit={onCommit} onDelete={vi.fn()} onDownloadAttachment={vi.fn()} />,
    )
    expandRow()

    fireEvent.change(screen.getByTestId('row-line-1-motivo'), { target: { value: 'Pens and paper' } })

    await act(async () => {
      fireEvent.click(screen.getByTestId('row-line-1-done'))
    })
    expect(onCommit).toHaveBeenCalledTimes(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })
    expect(onCommit).toHaveBeenCalledTimes(1)
  })

  it('cancels the pending debounce timer on unmount (no act warning, no stray commit)', async () => {
    const onCommit = vi.fn().mockResolvedValue(undefined)
    const { unmount } = render(
      <ExpenseLineRow line={line} mode="edit" onCommit={onCommit} onDelete={vi.fn()} onDownloadAttachment={vi.fn()} />,
    )
    expandRow()

    fireEvent.change(screen.getByTestId('row-line-1-motivo'), { target: { value: 'Pens and paper' } })
    unmount()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000)
    })
    expect(onCommit).not.toHaveBeenCalled()
  })
})

// -----------------------------------------------------------------------------
// onSaveOutcome — reports the tone/message of every commit (debounced or
// flushed) so a page-level toast can surface it.
// -----------------------------------------------------------------------------

describe('ExpenseLineRow — onSaveOutcome', () => {
  it('reports a success outcome with the "Changes stored" copy when a commit succeeds', async () => {
    const onCommit = vi.fn().mockResolvedValue(undefined)
    const onSaveOutcome = vi.fn()
    render(
      <ExpenseLineRow
        line={line}
        mode="edit"
        onCommit={onCommit}
        onDelete={vi.fn()}
        onDownloadAttachment={vi.fn()}
        onSaveOutcome={onSaveOutcome}
      />,
    )
    expandRow()

    fireEvent.change(screen.getByTestId('row-line-1-motivo'), { target: { value: 'Pens and paper' } })
    await act(async () => {
      fireEvent.click(screen.getByTestId('row-line-1-done'))
    })

    expect(onSaveOutcome).toHaveBeenCalledWith({
      tone: 'success',
      message: strings.pages.requestDetail.lines.savedToast,
    })
  })

  it('reports an error outcome with the RFC 7807 detail when a commit fails', async () => {
    const onCommit = vi
      .fn()
      .mockRejectedValue(
        new ApiError({
          type: 'about:blank',
          title: 'Unprocessable Entity',
          status: 422,
          detail: 'km is required for this type.',
        }),
      )
    const onSaveOutcome = vi.fn()
    render(
      <ExpenseLineRow
        line={line}
        mode="edit"
        onCommit={onCommit}
        onDelete={vi.fn()}
        onDownloadAttachment={vi.fn()}
        onSaveOutcome={onSaveOutcome}
      />,
    )
    expandRow()

    // Use blur-outside (not Done) — Done unconditionally collapses the row
    // even on failure, which would remove the inline error node this test
    // also asserts on.
    fireEvent.change(screen.getByTestId('row-line-1-motivo'), { target: { value: 'Pens and paper' } })
    await act(async () => {
      fireEvent.blur(screen.getByTestId('row-line-1-motivo'), { relatedTarget: document.body })
    })

    expect(onSaveOutcome).toHaveBeenCalledWith({ tone: 'error', message: 'km is required for this type.' })
    expect(screen.getByTestId('row-line-1-error').textContent).toBe('km is required for this type.')
  })

  it('falls back to the generic updateError copy when the failure is not an ApiError', async () => {
    const onCommit = vi.fn().mockRejectedValue(new Error('network down'))
    const onSaveOutcome = vi.fn()
    render(
      <ExpenseLineRow
        line={line}
        mode="edit"
        onCommit={onCommit}
        onDelete={vi.fn()}
        onDownloadAttachment={vi.fn()}
        onSaveOutcome={onSaveOutcome}
      />,
    )
    expandRow()

    fireEvent.change(screen.getByTestId('row-line-1-motivo'), { target: { value: 'Pens and paper' } })
    await act(async () => {
      fireEvent.click(screen.getByTestId('row-line-1-done'))
    })

    expect(onSaveOutcome).toHaveBeenCalledWith({
      tone: 'error',
      message: strings.pages.requestDetail.lines.updateError,
    })
  })
})
