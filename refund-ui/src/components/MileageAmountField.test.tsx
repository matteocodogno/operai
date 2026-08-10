/**
 * @vitest-environment jsdom
 *
 * Component tests for MileageAmountField (T13, specs/009-mileage-rate/
 * tasks.md, AC-1.2/1.3/1.8/2.2/2.4). `lib/ratesApi.ts` is mocked at the
 * module level (refund-api's `rates/` module doesn't exist yet — see
 * ratesApi.ts's own doc comment) so every state transition (Idle →
 * Calculating → Computed/Blocked/Error) is driven deterministically with
 * fake timers, mirroring ExpenseLineRow.test.tsx's own debounce-testing
 * convention (`vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync`).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import MileageAmountField from './MileageAmountField'
import * as ratesApi from '../lib/ratesApi'

vi.mock('../lib/ratesApi')

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('MileageAmountField — Idle', () => {
  it('shows the idle prompt and no currency badge when entity/date/km are all still empty', () => {
    render(<MileageAmountField entity="" date="" km="" />)
    expect(screen.getByTestId('mileage-amount-status').textContent).toBe('Enter a distance to calculate the amount.')
    expect(screen.queryByTestId('currency-badge')).toBeNull()
  })

  it('shows the entity-derived currency badge once an entity is picked, even before km is entered', () => {
    render(<MileageAmountField entity="welld_ch" date="" km="" />)
    expect(screen.getByTestId('currency-badge').textContent).toBe('CHFCHF')
  })

  it('stays Idle (no fetch) for a non-positive km', () => {
    render(<MileageAmountField entity="welld_ch" date="2026-07-15" km="0" />)
    expect(ratesApi.getEffectiveRate).not.toHaveBeenCalled()
    expect(screen.getByTestId('mileage-amount-status').textContent).toBe('Enter a distance to calculate the amount.')
  })
})

describe('MileageAmountField — Calculating / Computed (AC-1.2/1.8)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('debounces before fetching, and shows the full km × rate = amount breakdown once resolved', async () => {
    vi.mocked(ratesApi.getEffectiveRate).mockResolvedValue({
      entity: 'welld_ch',
      date: '2026-07-15',
      currency: 'CHF',
      inEffect: true,
      ratePerKmMicros: 700000,
      ratePerKm: '0.70',
      validFrom: '2026-01-01',
    })

    render(<MileageAmountField entity="welld_ch" date="2026-07-15" km="240" />)

    // Nothing is "in flight" yet during the debounce window itself.
    expect(ratesApi.getEffectiveRate).not.toHaveBeenCalled()
    expect(screen.queryByTestId('mileage-amount-loading')).toBeNull()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(400)
    })

    expect(ratesApi.getEffectiveRate).toHaveBeenCalledWith('welld_ch', '2026-07-15')
    expect(screen.getByTestId('mileage-amount-status').textContent).toBe('240 km × 0,70 CHF/km = 168,00 CHF')
    expect(screen.queryByTestId('mileage-amount-loading')).toBeNull()
  })

  it('never blanks a previously computed breakdown while a new fetch is in flight', async () => {
    vi.mocked(ratesApi.getEffectiveRate).mockResolvedValue({
      entity: 'welld_ch',
      date: '2026-07-15',
      currency: 'CHF',
      inEffect: true,
      ratePerKmMicros: 700000,
      ratePerKm: '0.70',
      validFrom: '2026-01-01',
    })

    const { rerender } = render(<MileageAmountField entity="welld_ch" date="2026-07-15" km="240" />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400)
    })
    expect(screen.getByTestId('mileage-amount-status').textContent).toContain('168,00 CHF')

    // Change km — a new debounced fetch is scheduled, but the last breakdown must stay visible
    // throughout, including once the fetch itself starts after the debounce elapses.
    rerender(<MileageAmountField entity="welld_ch" date="2026-07-15" km="241" />)
    expect(screen.getByTestId('mileage-amount-status').textContent).toContain('168,00 CHF')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(400)
    })
    expect(screen.getByTestId('mileage-amount-status').textContent).toContain('168,70 CHF')
  })

  it('resets the debounce on every further edit before it fires', async () => {
    vi.mocked(ratesApi.getEffectiveRate).mockResolvedValue({
      entity: 'welld_ch',
      date: '2026-07-15',
      currency: 'CHF',
      inEffect: true,
      ratePerKmMicros: 700000,
      ratePerKm: '0.70',
      validFrom: '2026-01-01',
    })

    const { rerender } = render(<MileageAmountField entity="welld_ch" date="2026-07-15" km="24" />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })
    rerender(<MileageAmountField entity="welld_ch" date="2026-07-15" km="240" />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })
    expect(ratesApi.getEffectiveRate).not.toHaveBeenCalled()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    expect(ratesApi.getEffectiveRate).toHaveBeenCalledTimes(1)
    expect(ratesApi.getEffectiveRate).toHaveBeenCalledWith('welld_ch', '2026-07-15')
  })

  it('re-resolves against the new entity/date when either changes (AC-1.3/2.4)', async () => {
    vi.mocked(ratesApi.getEffectiveRate).mockResolvedValue({
      entity: 'welld_it',
      date: '2026-08-01',
      currency: 'EUR',
      inEffect: true,
      ratePerKmMicros: 500000,
      ratePerKm: '0.50',
      validFrom: '2026-01-01',
    })

    const { rerender } = render(<MileageAmountField entity="welld_ch" date="2026-07-15" km="100" />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400)
    })
    expect(ratesApi.getEffectiveRate).toHaveBeenLastCalledWith('welld_ch', '2026-07-15')

    rerender(<MileageAmountField entity="welld_it" date="2026-08-01" km="100" />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400)
    })
    expect(ratesApi.getEffectiveRate).toHaveBeenLastCalledWith('welld_it', '2026-08-01')
  })
})

describe('MileageAmountField — Blocked (AC-2.2)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows a persistent, non-alert "no rate configured" message and the response currency', async () => {
    vi.mocked(ratesApi.getEffectiveRate).mockResolvedValue({
      entity: 'welld_it',
      date: '2026-07-15',
      currency: 'EUR',
      inEffect: false,
    })

    render(<MileageAmountField entity="welld_it" date="2026-07-15" km="50" />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400)
    })

    const status = screen.getByTestId('mileage-amount-status')
    expect(status.textContent).toBe('No mileage rate configured yet for WellD Italia.')
    expect(status.getAttribute('role')).toBe('status')
    expect(screen.getByTestId('currency-badge').textContent).toBe('€EUR')
  })
})

describe('MileageAmountField — Fetch error', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows an assertive role="alert" message on a network/5xx failure, and retries automatically on the next edit', async () => {
    vi.mocked(ratesApi.getEffectiveRate).mockRejectedValueOnce(new Error('network down'))
    vi.mocked(ratesApi.getEffectiveRate).mockResolvedValueOnce({
      entity: 'welld_ch',
      date: '2026-07-15',
      currency: 'CHF',
      inEffect: true,
      ratePerKmMicros: 700000,
      ratePerKm: '0.70',
      validFrom: '2026-01-01',
    })

    const { rerender } = render(<MileageAmountField entity="welld_ch" date="2026-07-15" km="240" />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400)
    })

    const status = screen.getByTestId('mileage-amount-status')
    expect(status.textContent).toBe('Could not calculate the mileage amount. Try again.')
    expect(status.getAttribute('role')).toBe('alert')

    // No dedicated Retry button — any further edit re-triggers the fetch.
    rerender(<MileageAmountField entity="welld_ch" date="2026-07-15" km="241" />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400)
    })
    expect(screen.getByTestId('mileage-amount-status').textContent).toContain('168,70 CHF')
  })
})

describe('MileageAmountField — stale-response guard', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('ignores an earlier in-flight fetch that resolves after a newer one has already settled', async () => {
    let resolveFirst!: (value: ratesApi.EffectiveRate) => void
    const firstPromise = new Promise<ratesApi.EffectiveRate>((resolve) => {
      resolveFirst = resolve
    })
    vi.mocked(ratesApi.getEffectiveRate).mockReturnValueOnce(firstPromise).mockResolvedValueOnce({
      entity: 'welld_ch',
      date: '2026-07-15',
      currency: 'CHF',
      inEffect: true,
      ratePerKmMicros: 700000,
      ratePerKm: '0.70',
      validFrom: '2026-01-01',
    })

    const { rerender } = render(<MileageAmountField entity="welld_ch" date="2026-07-15" km="10" />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400)
    })
    expect(ratesApi.getEffectiveRate).toHaveBeenCalledTimes(1)

    // A second edit fires a second (faster-resolving) fetch before the first settles.
    rerender(<MileageAmountField entity="welld_ch" date="2026-07-15" km="240" />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400)
    })
    expect(screen.getByTestId('mileage-amount-status').textContent).toContain('168,00 CHF')

    // The stale first response now resolves — it must NOT overwrite the newer, already-settled result.
    await act(async () => {
      resolveFirst({
        entity: 'welld_ch',
        date: '2026-07-15',
        currency: 'CHF',
        inEffect: true,
        ratePerKmMicros: 700000,
        ratePerKm: '0.70',
        validFrom: '2026-01-01',
      })
    })
    expect(screen.getByTestId('mileage-amount-status').textContent).toContain('168,00 CHF')
    expect(screen.getByTestId('mileage-amount-status').textContent).not.toContain('7,00 CHF')
  })
})
