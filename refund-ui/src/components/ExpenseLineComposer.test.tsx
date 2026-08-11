/**
 * @vitest-environment jsdom
 *
 * Component tests for ExpenseLineComposer (T16, specs/007-refund-service/
 * tasks.md, AC-1.2). Covers: the km field's show/hide by expense type + its
 * aria-live announcement, "Add expense line" disabled-until-valid, a
 * successful add resetting the draft, and a failed add keeping the draft
 * and surfacing an inline error.
 *
 * T13 (specs/014-motivo-autocomplete/tasks.md) extends this file with the
 * motivo-autocomplete wiring: AC-1.1, AC-3.1–3.7, AC-5.1, AC-5.2, AC-5.3 and
 * AC-5.4. Those live HERE rather than in `MotivoSuggestField.test.tsx`
 * because they need the real `<form>` — most of all the AC-5.3/AC-5.4 pair,
 * which is meaningless without a form that can actually be submitted.
 *
 * `lib/suggestionsApi` and `lib/ratesApi` are mocked at module level: neither
 * `refund-api` endpoint may be reached from a component test, and mocking
 * `getEffectiveRate` is what lets AC-3.5 assert that the amount genuinely
 * re-derives from the PICKED entity.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import ExpenseLineComposer from './ExpenseLineComposer'
import { ApiError } from '../lib/refundApi'
import { getTripSuggestions } from '../lib/suggestionsApi'
import type { TripSuggestion } from '../lib/suggestionsApi'
import * as ratesApi from '../lib/ratesApi'
import { strings } from '../strings'

vi.mock('../lib/suggestionsApi')
vi.mock('../lib/ratesApi')

beforeEach(() => {
  // The automocks return `undefined`, which both consumers would then `.then()`
  // on — give each a benign default every test may override.
  vi.mocked(getTripSuggestions).mockResolvedValue([])
  vi.mocked(ratesApi.getEffectiveRate).mockResolvedValue({
    entity: 'welld_ch',
    date: '2026-07-16',
    currency: 'CHF',
    inEffect: true,
    ratePerKmMicros: 700000,
    ratePerKm: '0.70',
    validFrom: '2026-01-01',
  })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
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

describe('ExpenseLineComposer — travel_km hides Amount/Currency (specs/009-mileage-rate AC-1.1/1.5/1.6)', () => {
  it('renders MileageAmountField instead of Amount/Currency once type=travel_km is selected', () => {
    render(<ExpenseLineComposer onAdd={vi.fn()} />)
    fireEvent.change(screen.getByTestId('composer-type'), { target: { value: 'travel_km' } })

    expect(screen.queryByTestId('composer-amount')).toBeNull()
    expect(screen.queryByTestId('composer-currency')).toBeNull()
    expect(screen.getByTestId('mileage-amount-field')).not.toBeNull()
  })

  it('shows Amount/Currency (and no MileageAmountField) for any other type, unaffected (AC-1.5)', () => {
    render(<ExpenseLineComposer onAdd={vi.fn()} />)
    fireEvent.change(screen.getByTestId('composer-type'), { target: { value: 'postal' } })

    expect(screen.getByTestId('composer-amount')).not.toBeNull()
    expect(screen.getByTestId('composer-currency')).not.toBeNull()
    expect(screen.queryByTestId('mileage-amount-field')).toBeNull()
  })

  it('switching from travel_km back to a manual type restores Amount/Currency', () => {
    render(<ExpenseLineComposer onAdd={vi.fn()} />)
    fireEvent.change(screen.getByTestId('composer-type'), { target: { value: 'travel_km' } })
    expect(screen.queryByTestId('composer-amount')).toBeNull()

    fireEvent.change(screen.getByTestId('composer-type'), { target: { value: 'stationery' } })
    expect(screen.getByTestId('composer-amount')).not.toBeNull()
    expect(screen.getByTestId('composer-currency')).not.toBeNull()
    expect(screen.queryByTestId('mileage-amount-field')).toBeNull()
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

  it('stays disabled for travel_km until km > 0 is also filled — amount/currency are no longer part of the check (specs/009-mileage-rate AC-1.1/1.6)', () => {
    render(<ExpenseLineComposer onAdd={vi.fn()} />)
    fireEvent.change(screen.getByTestId('composer-date'), { target: { value: '2026-07-16' } })
    fireEvent.change(screen.getByTestId('composer-type'), { target: { value: 'travel_km' } })
    fireEvent.change(screen.getByTestId('composer-motivo'), { target: { value: 'Client visit' } })
    fireEvent.change(screen.getByTestId('composer-entity'), { target: { value: 'welld_it' } })
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

  it('calls onAdd with km but WITHOUT requestedAmountCents/currency for a travel_km line (specs/009-mileage-rate AC-1.1/1.6)', async () => {
    const onAdd = vi.fn().mockResolvedValue(undefined)
    render(<ExpenseLineComposer onAdd={onAdd} />)
    fireEvent.change(screen.getByTestId('composer-date'), { target: { value: '2026-07-16' } })
    fireEvent.change(screen.getByTestId('composer-type'), { target: { value: 'travel_km' } })
    fireEvent.change(screen.getByTestId('composer-motivo'), { target: { value: 'Client visit' } })
    fireEvent.change(screen.getByTestId('composer-entity'), { target: { value: 'welld_it' } })
    fireEvent.change(screen.getByTestId('composer-km'), { target: { value: '120' } })

    fireEvent.click(screen.getByTestId('composer-add-button'))

    await waitFor(() => {
      expect(onAdd).toHaveBeenCalledWith({
        date: '2026-07-16',
        type: 'travel_km',
        motivo: 'Client visit',
        entity: 'welld_it',
        km: 120,
      })
    })
  })

  it('keeps the draft and shows an inline error when onAdd rejects', async () => {
    const onAdd = vi
      .fn()
      .mockRejectedValue(
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

// ─────────────────────────────────────────────────────────────────────────
// Motivo autocomplete (T13, specs/014-motivo-autocomplete)
// ─────────────────────────────────────────────────────────────────────────

const LUGANO: TripSuggestion = {
  motivo: 'Milano → Lugano cliente ACME',
  normalisedMotivo: 'milano → lugano cliente acme',
  km: 62,
  entity: 'welld_ch',
  count: 14,
  lastUsedOn: '2026-07-28',
}

const MALPENSA: TripSuggestion = {
  motivo: 'Lugano → Aeroporto Malpensa',
  normalisedMotivo: 'lugano → aeroporto malpensa',
  km: 45,
  entity: 'welld_it',
  count: 9,
  lastUsedOn: '2026-06-02',
}

const motivoField = () => screen.getByTestId('composer-motivo') as HTMLInputElement
const composerForm = () => screen.getByTestId('expense-line-composer')

/**
 * A complete, addable `travel_km` draft with values DELIBERATELY different
 * from `LUGANO`'s, so a pick's overwrite (AC-3.4) and a non-pick submit
 * (AC-5.4) are each unambiguous.
 */
const fillMileageDraft = () => {
  fireEvent.change(screen.getByTestId('composer-date'), { target: { value: '2026-07-16' } })
  fireEvent.change(screen.getByTestId('composer-type'), { target: { value: 'travel_km' } })
  fireEvent.change(motivoField(), { target: { value: 'Trasferta a mano' } })
  fireEvent.change(screen.getByTestId('composer-entity'), { target: { value: 'welld_it' } })
  fireEvent.change(screen.getByTestId('composer-km'), { target: { value: '11' } })
}

/** Runs the field's 150 ms corpus debounce (and, at 600 ms, the rate field's 400 ms one). */
const advance = async (ms = 200) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

/** Focuses Motivo, types `query`, and lets the corpus land. */
const openSuggestions = async (query = 'lugano') => {
  fireEvent.focus(motivoField())
  fireEvent.change(motivoField(), { target: { value: query } })
  await advance()
}

/**
 * Presses Enter on the Motivo field THE WAY A BROWSER DOES.
 *
 * This helper is the whole point of the AC-5.3/AC-5.4 pair. jsdom implements
 * neither implicit form submission nor the ordering that makes the bug
 * dangerous, so a plain `fireEvent.keyDown(input, { key: 'Enter' })` never
 * submits and a MISSING `preventDefault()` would look perfectly green.
 *
 * Two details make this faithful rather than approximate:
 *
 *  1. The submit is dispatched only when nothing cancelled the keydown — which
 *     is exactly the browser's rule for a default action.
 *  2. Both dispatches happen with the RAW DOM inside ONE `act()`, not through
 *     `fireEvent`. `fireEvent` wraps each call in its own `act()`, which
 *     flushes React in between — so the submit handler would read the
 *     ALREADY-UPDATED draft and the defect would look benign. In a real
 *     browser the implicit submission is the keydown's default action and runs
 *     before React flushes, so `handleSubmit` still closes over the PRE-PICK
 *     draft. Batching both dispatches into one `act()` reproduces that.
 *
 * Remove `event.preventDefault()` from `MotivoSuggestField`'s
 * `Enter && open && active >= 0` branch and the AC-5.3 test below goes red
 * with `onAdd` called carrying the PRE-PICK km and entity under the new
 * motivo — wrong money, no error, nothing on screen.
 */
const pressEnterOnMotivo = (): { defaultPrevented: boolean } => {
  const motivo = motivoField()
  const form = composerForm()
  let notCancelled = true
  act(() => {
    notCancelled = motivo.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    if (notCancelled) {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    }
  })
  return { defaultPrevented: !notCancelled }
}

describe('ExpenseLineComposer — the field is inert outside travel_km (AC-1.1)', () => {
  it('renders a plain Motivo input and requests nothing for the default (no type) state', async () => {
    vi.useFakeTimers()
    render(<ExpenseLineComposer onAdd={vi.fn()} />)

    await openSuggestions('lugano')

    expect(getTripSuggestions).not.toHaveBeenCalled()
    expect(motivoField().hasAttribute('role')).toBe(false)
    expect(screen.queryByTestId('composer-motivo-listbox')).toBeNull()
    vi.useRealTimers()
  })

  it('renders a plain Motivo input and requests nothing for any other expense type', async () => {
    vi.useFakeTimers()
    render(<ExpenseLineComposer onAdd={vi.fn()} />)
    fireEvent.change(screen.getByTestId('composer-type'), { target: { value: 'stationery' } })

    await openSuggestions('lugano')

    expect(getTripSuggestions).not.toHaveBeenCalled()
    expect(motivoField().hasAttribute('role')).toBe(false)
    vi.useRealTimers()
  })

  it('keeps the SAME DOM node (and its id/testid) when the type changes — focus and caret survive', () => {
    render(<ExpenseLineComposer onAdd={vi.fn()} />)
    const before = motivoField()
    expect(before.id).toBe('composer-motivo')

    fireEvent.change(screen.getByTestId('composer-type'), { target: { value: 'travel_km' } })
    const afterEnable = motivoField()
    // Assert the ARIA state HERE, while travel_km is still selected — the node
    // is literally the same object throughout, so a later read would see the
    // attributes of whatever type is selected at that moment.
    expect(afterEnable).toBe(before)
    expect(afterEnable.getAttribute('role')).toBe('combobox')

    fireEvent.change(screen.getByTestId('composer-type'), { target: { value: 'stationery' } })
    const afterDisable = motivoField()

    expect(afterDisable).toBe(before)
    expect(afterDisable.hasAttribute('role')).toBe(false)
    expect(afterDisable.id).toBe('composer-motivo')
    expect(afterDisable.getAttribute('data-testid')).toBe('composer-motivo')
  })
})

describe('ExpenseLineComposer — picking a suggestion fills the trip’s stable facts (AC-3.x)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.mocked(getTripSuggestions).mockResolvedValue([LUGANO, MALPENSA])
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  const pickFirstSuggestion = async () => {
    await openSuggestions('lugano')
    expect(screen.getAllByRole('option').length).toBeGreaterThan(0)
    fireEvent.click(screen.getByTestId('composer-motivo-option-0'))
    await advance()
  }

  it('overwrites motivo, km and entity — even when all three were already typed (AC-3.1, AC-3.4)', async () => {
    render(<ExpenseLineComposer onAdd={vi.fn()} />)
    fillMileageDraft()
    expect(motivoField().value).toBe('Trasferta a mano')

    await pickFirstSuggestion()

    expect(motivoField().value).toBe(LUGANO.motivo)
    expect((screen.getByTestId('composer-km') as HTMLInputElement).value).toBe('62')
    expect((screen.getByTestId('composer-entity') as HTMLSelectElement).value).toBe('welld_ch')
  })

  it('leaves the expense DATE untouched — a new claim is a new date (AC-3.2)', async () => {
    render(<ExpenseLineComposer onAdd={vi.fn()} />)
    fillMileageDraft()

    await pickFirstSuggestion()

    expect((screen.getByTestId('composer-date') as HTMLInputElement).value).toBe('2026-07-16')
    // The suggestion's own last-used date is never carried forward.
    expect((screen.getByTestId('composer-date') as HTMLInputElement).value).not.toBe(LUGANO.lastUsedOn)
  })

  it('introduces no amount and no currency control (AC-3.3, specs/009)', async () => {
    render(<ExpenseLineComposer onAdd={vi.fn()} />)
    fillMileageDraft()

    await pickFirstSuggestion()

    expect(screen.queryByTestId('composer-amount')).toBeNull()
    expect(screen.queryByTestId('composer-currency')).toBeNull()
    expect(screen.getByTestId('mileage-amount-field')).not.toBeNull()
  })

  it('closes the list and re-derives the amount from the PICKED entity (AC-3.5)', async () => {
    render(<ExpenseLineComposer onAdd={vi.fn()} />)
    fillMileageDraft()
    await advance(600)
    vi.mocked(ratesApi.getEffectiveRate).mockClear()

    await pickFirstSuggestion()
    await advance(600)

    expect(screen.queryByTestId('composer-motivo-listbox')).toBeNull()
    expect(ratesApi.getEffectiveRate).toHaveBeenCalledWith('welld_ch', '2026-07-16')
  })

  it('leaves all three filled fields ordinarily editable — never locked or read-only (AC-3.6)', async () => {
    render(<ExpenseLineComposer onAdd={vi.fn()} />)
    fillMileageDraft()
    await pickFirstSuggestion()

    const km = screen.getByTestId('composer-km') as HTMLInputElement
    const entity = screen.getByTestId('composer-entity') as HTMLSelectElement
    expect(motivoField().readOnly).toBe(false)
    expect(motivoField().disabled).toBe(false)
    expect(km.readOnly).toBe(false)
    expect(km.disabled).toBe(false)
    expect(entity.disabled).toBe(false)

    fireEvent.change(motivoField(), { target: { value: 'Milano → Lugano rientro' } })
    fireEvent.change(km, { target: { value: '64' } })
    fireEvent.change(entity, { target: { value: 'welld_it' } })

    expect(motivoField().value).toBe('Milano → Lugano rientro')
    expect(km.value).toBe('64')
    expect(entity.value).toBe('welld_it')
  })

  it('saves nothing — the line still has to be added explicitly (AC-3.7)', async () => {
    const onAdd = vi.fn().mockResolvedValue(undefined)
    render(<ExpenseLineComposer onAdd={onAdd} />)
    fillMileageDraft()

    await pickFirstSuggestion()
    expect(onAdd).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('composer-add-button'))
    await advance()

    expect(onAdd).toHaveBeenCalledWith({
      date: '2026-07-16',
      type: 'travel_km',
      motivo: LUGANO.motivo,
      entity: 'welld_ch',
      km: 62,
    })
  })

  it('announces the multi-field change on the EXISTING polite status line, naming the untouched date (AC-5.6)', async () => {
    render(<ExpenseLineComposer onAdd={vi.fn()} />)
    fillMileageDraft()

    await pickFirstSuggestion()

    expect(screen.getByTestId('composer-km-status').textContent).toBe(
      strings.pages.requestDetail.composer.suggestionApplied(LUGANO.motivo, LUGANO.km, strings.badges.entity.welld_ch),
    )
  })

  it('re-arms the corpus fetch after a successful add, so the trip just claimed is suggestible (plan D6)', async () => {
    const onAdd = vi.fn().mockResolvedValue(undefined)
    render(<ExpenseLineComposer onAdd={onAdd} />)
    fillMileageDraft()
    await openSuggestions('lugano')
    expect(getTripSuggestions).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByTestId('composer-add-button'))
    await advance()
    expect(onAdd).toHaveBeenCalledTimes(1)

    // A successful add resets the WHOLE draft, type included, so the employee
    // re-picks Travel by car for the next line — which is the moment the
    // re-armed corpus fetch actually fires.
    fireEvent.change(screen.getByTestId('composer-type'), { target: { value: 'travel_km' } })
    await openSuggestions('lugano')

    expect(getTripSuggestions).toHaveBeenCalledTimes(2)
  })
})

describe('ExpenseLineComposer — the Enter trap: AC-5.3 and AC-5.4 as a pair', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.mocked(getTripSuggestions).mockResolvedValue([LUGANO, MALPENSA])
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('AC-5.3: Enter on a HIGHLIGHTED option picks it and the form is NOT submitted', async () => {
    const onAdd = vi.fn().mockResolvedValue(undefined)
    render(<ExpenseLineComposer onAdd={onAdd} />)
    // A COMPLETE draft — the only configuration in which a missing
    // preventDefault() actually posts a line, and therefore the only one worth
    // testing. With an incomplete draft the composer's `if (!canAdd) return`
    // guard would mask the defect.
    fillMileageDraft()
    await openSuggestions('lugano')
    expect(screen.getByTestId('composer-add-button')).toHaveProperty('disabled', false)

    fireEvent.keyDown(motivoField(), { key: 'ArrowDown' })
    expect(motivoField().getAttribute('aria-activedescendant')).toBe('composer-motivo-option-0')

    const { defaultPrevented } = pressEnterOnMotivo()
    await advance()

    expect(defaultPrevented).toBe(true)
    expect(onAdd).not.toHaveBeenCalled()
    // The pick landed, and the pre-pick km/entity are gone — this is exactly
    // the pair of values a leaked submit would have posted.
    expect(motivoField().value).toBe(LUGANO.motivo)
    expect((screen.getByTestId('composer-km') as HTMLInputElement).value).toBe('62')
    expect((screen.getByTestId('composer-entity') as HTMLSelectElement).value).toBe('welld_ch')
  })

  it('AC-5.4: Enter with NOTHING highlighted submits exactly as it does today', async () => {
    const onAdd = vi.fn().mockResolvedValue(undefined)
    render(<ExpenseLineComposer onAdd={onAdd} />)
    fillMileageDraft()
    await openSuggestions('lugano')
    expect(screen.getByTestId('composer-motivo-listbox')).not.toBeNull()
    expect(motivoField().hasAttribute('aria-activedescendant')).toBe(false)

    const { defaultPrevented } = pressEnterOnMotivo()
    await advance()

    expect(defaultPrevented).toBe(false)
    // The hand-typed draft is posted verbatim — no suggestion was applied.
    expect(onAdd).toHaveBeenCalledTimes(1)
    expect(onAdd).toHaveBeenCalledWith({
      date: '2026-07-16',
      type: 'travel_km',
      motivo: 'lugano',
      entity: 'welld_it',
      km: 11,
    })
  })

  it('AC-5.4: Enter with no list open at all is likewise untouched', async () => {
    const onAdd = vi.fn().mockResolvedValue(undefined)
    render(<ExpenseLineComposer onAdd={onAdd} />)
    fillMileageDraft()
    await openSuggestions('nessun risultato qui')
    expect(screen.queryByTestId('composer-motivo-listbox')).toBeNull()

    const { defaultPrevented } = pressEnterOnMotivo()
    await advance()

    expect(defaultPrevented).toBe(false)
    expect(onAdd).toHaveBeenCalledTimes(1)
  })
})

describe('ExpenseLineComposer — the autocomplete never gets in the way (AC-5.1, AC-5.2)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('AC-5.1: a novel motivo that matches nothing composes and adds exactly as before', async () => {
    vi.mocked(getTripSuggestions).mockResolvedValue([LUGANO])
    const onAdd = vi.fn().mockResolvedValue(undefined)
    render(<ExpenseLineComposer onAdd={onAdd} />)
    fillMileageDraft()

    await openSuggestions('Prima volta a Bellinzona')

    expect(screen.queryByTestId('composer-motivo-listbox')).toBeNull()
    expect(motivoField().value).toBe('Prima volta a Bellinzona')

    fireEvent.click(screen.getByTestId('composer-add-button'))
    await advance()

    expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({ motivo: 'Prima volta a Bellinzona', km: 11 }))
  })

  it.each([
    [
      '503 (auth outage, fail-closed)',
      new ApiError({ type: 'about:blank', title: 'Service Unavailable', status: 503 }),
    ],
    ['403 (capability absent)', new ApiError({ type: 'about:blank', title: 'Forbidden', status: 403 })],
    ['a network failure', new TypeError('Failed to fetch')],
  ])(
    'AC-5.2: a corpus fetch failing with %s surfaces NO error in the composer and still adds the line',
    async (_label, failure) => {
      vi.mocked(getTripSuggestions).mockRejectedValue(failure)
      const onAdd = vi.fn().mockResolvedValue(undefined)
      render(<ExpenseLineComposer onAdd={onAdd} />)
      fillMileageDraft()

      await openSuggestions('lugano')

      expect(getTripSuggestions).toHaveBeenCalledTimes(1)
      // The composer's own error surface must stay untouched — the swallow
      // happens inside MotivoSuggestField and never reaches this component.
      expect(screen.queryByTestId('composer-error')).toBeNull()
      expect(screen.queryByTestId('composer-motivo-listbox')).toBeNull()
      expect(screen.queryAllByRole('alert')).toHaveLength(0)

      fireEvent.click(screen.getByTestId('composer-add-button'))
      await advance()

      expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({ motivo: 'lugano', km: 11 }))
      expect(screen.queryByTestId('composer-error')).toBeNull()
    },
  )
})
