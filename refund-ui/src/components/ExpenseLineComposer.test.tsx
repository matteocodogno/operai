/**
 * @vitest-environment jsdom
 *
 * Component tests for ExpenseLineComposer (T16, specs/007-refund-service/
 * tasks.md, AC-1.2). Covers: the km field's show/hide by expense type + its
 * aria-live announcement, "Add expense line" disabled-until-valid, a
 * successful add resetting the draft, and a failed add keeping the draft
 * and surfacing an inline error.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import ExpenseLineComposer from './ExpenseLineComposer'
import { ApiError } from '../lib/refundApi'

afterEach(() => {
  cleanup()
})

const fillNonKmLine = () => {
  fireEvent.change(screen.getByTestId('composer-date'), { target: { value: '2026-07-16' } })
  fireEvent.change(screen.getByTestId('composer-type'), { target: { value: 'stationery' } })
  fireEvent.change(screen.getByTestId('composer-motivo'), { target: { value: 'Pens' } })
  fireEvent.change(screen.getByTestId('composer-amount'), { target: { value: '10.00' } })
  fireEvent.change(screen.getByTestId('composer-entity'), { target: { value: 'welld_it' } })
  fireEvent.change(screen.getByTestId('composer-currency'), { target: { value: 'EUR' } })
}

describe('ExpenseLineComposer — km show/hide', () => {
  it('does not render the km field for the default (no type selected) state', () => {
    render(<ExpenseLineComposer onAdd={vi.fn()} />)
    expect(screen.queryByTestId('composer-km')).toBeNull()
  })

  it('renders the km field only once type=travel_km is selected, and announces it via aria-live', () => {
    render(<ExpenseLineComposer onAdd={vi.fn()} />)

    fireEvent.change(screen.getByTestId('composer-type'), { target: { value: 'travel_km' } })

    const km = screen.getByTestId('composer-km')
    expect(km).not.toBeNull()
    expect(km.getAttribute('aria-required')).toBe('true')
    expect(screen.getByTestId('composer-km-status').textContent).toContain('Mileage field added')
  })

  it('removes the km field and re-announces when switching away from travel_km', () => {
    render(<ExpenseLineComposer onAdd={vi.fn()} />)

    fireEvent.change(screen.getByTestId('composer-type'), { target: { value: 'travel_km' } })
    expect(screen.getByTestId('composer-km')).not.toBeNull()

    fireEvent.change(screen.getByTestId('composer-type'), { target: { value: 'stationery' } })
    expect(screen.queryByTestId('composer-km')).toBeNull()
    expect(screen.getByTestId('composer-km-status').textContent).toContain('Mileage field removed')
  })

  it('does NOT render km for any other type (AC-1.2: not shown/not required)', () => {
    render(<ExpenseLineComposer onAdd={vi.fn()} />)
    fireEvent.change(screen.getByTestId('composer-type'), { target: { value: 'postal' } })
    expect(screen.queryByTestId('composer-km')).toBeNull()
  })
})

describe('ExpenseLineComposer — Add disabled-until-valid', () => {
  it('"Add expense line" is disabled with an empty draft', () => {
    render(<ExpenseLineComposer onAdd={vi.fn()} />)
    expect(screen.getByTestId('composer-add-button')).toHaveProperty('disabled', true)
  })

  it('enables once every required field for a non-km type is filled', () => {
    render(<ExpenseLineComposer onAdd={vi.fn()} />)
    fillNonKmLine()
    expect(screen.getByTestId('composer-add-button')).toHaveProperty('disabled', false)
  })

  it('stays disabled for travel_km until km > 0 is also filled', () => {
    render(<ExpenseLineComposer onAdd={vi.fn()} />)
    fireEvent.change(screen.getByTestId('composer-date'), { target: { value: '2026-07-16' } })
    fireEvent.change(screen.getByTestId('composer-type'), { target: { value: 'travel_km' } })
    fireEvent.change(screen.getByTestId('composer-motivo'), { target: { value: 'Client visit' } })
    fireEvent.change(screen.getByTestId('composer-amount'), { target: { value: '45.50' } })
    fireEvent.change(screen.getByTestId('composer-entity'), { target: { value: 'welld_it' } })
    fireEvent.change(screen.getByTestId('composer-currency'), { target: { value: 'EUR' } })
    expect(screen.getByTestId('composer-add-button')).toHaveProperty('disabled', true)

    fireEvent.change(screen.getByTestId('composer-km'), { target: { value: '0' } })
    expect(screen.getByTestId('composer-add-button')).toHaveProperty('disabled', true)

    fireEvent.change(screen.getByTestId('composer-km'), { target: { value: '120' } })
    expect(screen.getByTestId('composer-add-button')).toHaveProperty('disabled', false)
  })

  it('stays disabled until currency is also selected, independent of entity (no default, deliberate choice)', () => {
    render(<ExpenseLineComposer onAdd={vi.fn()} />)
    fireEvent.change(screen.getByTestId('composer-date'), { target: { value: '2026-07-16' } })
    fireEvent.change(screen.getByTestId('composer-type'), { target: { value: 'stationery' } })
    fireEvent.change(screen.getByTestId('composer-motivo'), { target: { value: 'Pens' } })
    fireEvent.change(screen.getByTestId('composer-amount'), { target: { value: '10.00' } })
    fireEvent.change(screen.getByTestId('composer-entity'), { target: { value: 'welld_it' } })
    expect(screen.getByTestId('composer-add-button')).toHaveProperty('disabled', true)

    fireEvent.change(screen.getByTestId('composer-currency'), { target: { value: 'EUR' } })
    expect(screen.getByTestId('composer-add-button')).toHaveProperty('disabled', false)
  })
})

describe('ExpenseLineComposer — submit behavior', () => {
  it('calls onAdd with the full payload and resets the draft on success', async () => {
    const onAdd = vi.fn().mockResolvedValue(undefined)
    render(<ExpenseLineComposer onAdd={onAdd} />)
    fillNonKmLine()

    fireEvent.click(screen.getByTestId('composer-add-button'))

    await waitFor(() => {
      expect(onAdd).toHaveBeenCalledWith({
        date: '2026-07-16',
        type: 'stationery',
        motivo: 'Pens',
        requestedAmountCents: 1000,
        entity: 'welld_it',
        currency: 'EUR',
      })
    })
    await waitFor(() => {
      expect((screen.getByTestId('composer-motivo') as HTMLInputElement).value).toBe('')
    })
    expect((screen.getByTestId('composer-type') as HTMLSelectElement).value).toBe('')
    expect((screen.getByTestId('composer-currency') as HTMLSelectElement).value).toBe('')
  })

  it('allows a mismatched entity/currency pair (e.g. WellD Italia + USD) with no client-side block', async () => {
    const onAdd = vi.fn().mockResolvedValue(undefined)
    render(<ExpenseLineComposer onAdd={onAdd} />)
    fireEvent.change(screen.getByTestId('composer-date'), { target: { value: '2026-07-16' } })
    fireEvent.change(screen.getByTestId('composer-type'), { target: { value: 'stationery' } })
    fireEvent.change(screen.getByTestId('composer-motivo'), { target: { value: 'Client dinner' } })
    fireEvent.change(screen.getByTestId('composer-amount'), { target: { value: '30.00' } })
    fireEvent.change(screen.getByTestId('composer-entity'), { target: { value: 'welld_it' } })
    fireEvent.change(screen.getByTestId('composer-currency'), { target: { value: 'USD' } })

    expect(screen.getByTestId('composer-add-button')).toHaveProperty('disabled', false)
    fireEvent.click(screen.getByTestId('composer-add-button'))

    await waitFor(() => {
      expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({ entity: 'welld_it', currency: 'USD' }))
    })
  })

  it('keeps the draft and shows an inline error when onAdd rejects', async () => {
    const onAdd = vi.fn().mockRejectedValue(
      new ApiError({ type: 'about:blank', title: 'Unprocessable Entity', status: 422, detail: 'km is required' }),
    )
    render(<ExpenseLineComposer onAdd={onAdd} />)
    fillNonKmLine()

    fireEvent.click(screen.getByTestId('composer-add-button'))

    await waitFor(() => {
      expect(screen.getByTestId('composer-error').textContent).toBe('km is required')
    })
    expect((screen.getByTestId('composer-motivo') as HTMLInputElement).value).toBe('Pens')
  })
})
