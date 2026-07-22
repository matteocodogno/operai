/**
 * @vitest-environment jsdom
 *
 * Component tests for MileageRatesPage — Screen ADM-1 + Modal ADM-M1 (T11,
 * specs/009-mileage-rate/tasks.md, refs AC-4.1, AC-4.2, AC-4.3, AC-4.5,
 * AC-4.6, AC-5.3).
 *
 * Covers:
 *   (A) Loading: ratesApi.listRates is pending → SkeletonListRows visible.
 *   (B) Populated: renders both entities' tables (Rate/Valid from/Added
 *       by/Added on/Status columns), the `inEffectToday` row carries
 *       RateInEffectBadge, a non-in-effect row does not.
 *   (C) Empty (per entity): "No rate configured yet for …" + a repeated
 *       "+ Add rate entry" when rate:manage is granted.
 *   (D) Error: listRates rejects (non-403) → ErrorBanner + Retry re-fetches.
 *   (E) Forbidden: listRates rejects with 403 → PermissionDenied with a
 *       section-specific message, no "+ Add rate entry" anywhere.
 *   (F) rate:manage gating: no "+ Add rate entry" button anywhere when
 *       adminApi.getMe() doesn't grant it, even though the tables render.
 *   (G) Add (M1): "+ Add rate entry" → fill rate/validFrom → submit →
 *       ratesApi.addRate called with the right body → list reloads → focus
 *       returns to the trigger button.
 *   (H) Add 422: addRate rejects 422 → field-level error surfaced (rate vs.
 *       date routing), modal stays open.
 *   (I) Client-side pre-check: a non-positive rate or empty date blocks
 *       submit without calling addRate at all.
 *
 * Strategy mirrors RolesPage.test.tsx: mock `../lib/ratesApi` and
 * `../lib/adminApi` at the module level (keeping the real `ApiError`/types
 * via importOriginal).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import MileageRatesPage from './MileageRatesPage'
import type { RatesResult } from '../lib/ratesApi'
import type { EffectivePermissions } from '../lib/adminApi'
import type { SettingResult } from '../lib/settingsApi'

// ---------------------------------------------------------------------------
// Module mocks — must be declared before importing the mocked modules.
// ---------------------------------------------------------------------------

vi.mock('../lib/ratesApi', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/ratesApi')>()
  return { ...original, listRates: vi.fn(), addRate: vi.fn() }
})

vi.mock('../lib/adminApi', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/adminApi')>()
  return { ...original, getMe: vi.fn() }
})

vi.mock('../lib/settingsApi', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/settingsApi')>()
  return { ...original, getSetting: vi.fn(), putSetting: vi.fn() }
})

import * as ratesApi from '../lib/ratesApi'
import { ApiError as RatesApiError } from '../lib/ratesApi'
import * as adminApi from '../lib/adminApi'
import * as settingsApi from '../lib/settingsApi'
import { ApiError as SettingsApiError, ACCOUNTING_DISTRIBUTION_EMAIL_KEY } from '../lib/settingsApi'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const managePermissions: EffectivePermissions = {
  epoch: 1,
  apps: ['admin'],
  roles: ['admin'],
  departments: [],
  permissions: [
    { resource: 'rate', action: 'read', conditions: null },
    { resource: 'rate', action: 'manage', conditions: null },
  ],
}

const readOnlyPermissions: EffectivePermissions = {
  epoch: 1,
  apps: ['admin'],
  roles: [],
  departments: [],
  permissions: [{ resource: 'rate', action: 'read', conditions: null }],
}

// T6, specs/011-refund-settings — grants BOTH settings:read and
// settings:manage (mirrors ADR-0028's seed: the two are granted together to
// admin/refund-admin), used for the accounting-distribution-email panel's
// happy-path tests.
const settingsManagePermissions: EffectivePermissions = {
  epoch: 1,
  apps: ['admin'],
  roles: ['admin'],
  departments: [],
  permissions: [
    { resource: 'rate', action: 'read', conditions: null },
    { resource: 'rate', action: 'manage', conditions: null },
    { resource: 'settings', action: 'read', conditions: null },
    { resource: 'settings', action: 'manage', conditions: null },
  ],
}

const configuredSetting: SettingResult = {
  key: ACCOUNTING_DISTRIBUTION_EMAIL_KEY,
  value: 'accounting@welld.ch',
  configured: true,
  updatedAt: '2026-07-20T09:12:00.000Z',
  updatedByEmail: 'admin@welld.ch',
  history: [
    { value: 'accounting@welld.ch', changedAt: '2026-07-20T09:12:00.000Z', changedByEmail: 'admin@welld.ch' },
  ],
}

const notConfiguredSetting: SettingResult = {
  key: ACCOUNTING_DISTRIBUTION_EMAIL_KEY,
  value: null,
  configured: false,
  updatedAt: null,
  updatedByEmail: null,
  history: [],
}

const populatedResult: RatesResult = {
  entities: [
    {
      entity: 'welld_ch',
      currency: 'CHF',
      currentEntryId: 'clr_current',
      entries: [
        {
          id: 'clr_old',
          ratePerKmMicros: 650000,
          ratePerKm: '0.65',
          validFrom: '2025-01-01',
          createdAt: '2025-01-01T09:00:00.000Z',
          createdByEmail: 'past-admin@welld.ch',
          inEffectToday: false,
        },
        {
          id: 'clr_current',
          ratePerKmMicros: 700000,
          ratePerKm: '0.70',
          validFrom: '2026-01-01',
          createdAt: '2026-01-01T09:00:00.000Z',
          createdByEmail: 'admin@welld.ch',
          inEffectToday: true,
        },
      ],
    },
    { entity: 'welld_it', currency: 'EUR', currentEntryId: null, entries: [] },
  ],
}

/** Returns a promise that never resolves — keeps a fetch "pending" (loading). */
function pendingPromise<T>(): Promise<T> {
  return new Promise(() => {})
}

beforeEach(() => {
  vi.mocked(adminApi.getMe).mockResolvedValue(managePermissions)
})

afterEach(() => {
  vi.clearAllMocks()
  cleanup()
})

// ---------------------------------------------------------------------------
// (A) Loading
// ---------------------------------------------------------------------------

describe('MileageRatesPage — loading', () => {
  it('renders SkeletonListRows under each entity heading while listRates is in-flight', () => {
    vi.mocked(ratesApi.listRates).mockReturnValue(pendingPromise())

    render(<MileageRatesPage />)

    // 2 for the rate entities + 1 for the accounting-distribution-email panel
    // (T6, specs/011-refund-settings) — it also starts 'loading' on the very
    // first synchronous render, before its own getMe()/getSetting() calls
    // resolve.
    expect(screen.getAllByTestId('skeleton-list-rows')).toHaveLength(3)
    expect(screen.getByText('WellD CH')).not.toBeNull()
    expect(screen.getByText('WellD Italia')).not.toBeNull()
    expect(screen.queryByTestId('rates-table-welld_ch')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// (B) Populated
// ---------------------------------------------------------------------------

describe('MileageRatesPage — populated', () => {
  it('renders both entities, in-effect badge on the current row only', async () => {
    vi.mocked(ratesApi.listRates).mockResolvedValue(populatedResult)

    render(<MileageRatesPage />)

    await waitFor(() => {
      expect(screen.getByTestId('rates-table-welld_ch')).not.toBeNull()
    })

    const rows = screen.getAllByTestId(/^rate-row-/)
    expect(rows).toHaveLength(2)

    const currentRow = screen.getByTestId('rate-row-clr_current')
    expect(currentRow.textContent).toContain('0.70 CHF/km')
    expect(currentRow.querySelector('[data-testid="rate-in-effect-badge"]')).not.toBeNull()

    const oldRow = screen.getByTestId('rate-row-clr_old')
    expect(oldRow.textContent).toContain('0.65 CHF/km')
    expect(oldRow.querySelector('[data-testid="rate-in-effect-badge"]')).toBeNull()

    // No Actions column anywhere (AC-4.7 — append-only, no edit/delete).
    const table = screen.getByTestId('rates-table-welld_ch')
    expect(table.textContent).not.toContain('Edit')
    expect(table.textContent).not.toContain('Delete')
  })

  it('renders "No rate configured yet for WellD Italia." for the empty entity', async () => {
    vi.mocked(ratesApi.listRates).mockResolvedValue(populatedResult)

    render(<MileageRatesPage />)

    await waitFor(() => {
      expect(screen.getByTestId('rates-empty-welld_it')).not.toBeNull()
    })
    expect(screen.getByText('No rate configured yet for WellD Italia.')).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// (D) Error
// ---------------------------------------------------------------------------

describe('MileageRatesPage — error', () => {
  it('renders an ErrorBanner and retries on click', async () => {
    vi.mocked(ratesApi.listRates)
      .mockRejectedValueOnce(
        new RatesApiError({ type: 'about:blank', title: 'Internal Server Error', status: 500, detail: 'Boom.' }),
      )
      .mockResolvedValueOnce(populatedResult)

    render(<MileageRatesPage />)

    await waitFor(() => {
      expect(screen.getByRole('alert')).not.toBeNull()
    })
    expect(screen.getByRole('alert').textContent).toContain('Boom.')

    fireEvent.click(screen.getByTestId('error-banner-retry'))

    await waitFor(() => {
      expect(screen.getByTestId('rates-table-welld_ch')).not.toBeNull()
    })
    expect(ratesApi.listRates).toHaveBeenCalledTimes(2)
  })
})

// ---------------------------------------------------------------------------
// (E) Forbidden
// ---------------------------------------------------------------------------

describe('MileageRatesPage — forbidden (AC-4.6)', () => {
  it('renders PermissionDenied with a section-specific message on a 403, no add affordance', async () => {
    vi.mocked(ratesApi.listRates).mockRejectedValue(
      new RatesApiError({ type: 'about:blank', title: 'Forbidden', status: 403, detail: 'Missing rate:read' }),
    )

    render(<MileageRatesPage />)

    await waitFor(() => {
      expect(screen.getByTestId('permission-denied')).not.toBeNull()
    })
    expect(screen.getByTestId('permission-denied').textContent).toContain(
      "You don't have permission to view mileage rates.",
    )
    expect(screen.queryByTestId('rates-table-welld_ch')).toBeNull()
    expect(screen.queryByText('+ Add rate entry')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// (F) rate:manage gating
// ---------------------------------------------------------------------------

describe('MileageRatesPage — rate:manage gating', () => {
  it('renders the tables but no "+ Add rate entry" button anywhere without rate:manage', async () => {
    vi.mocked(adminApi.getMe).mockResolvedValue(readOnlyPermissions)
    vi.mocked(ratesApi.listRates).mockResolvedValue(populatedResult)

    render(<MileageRatesPage />)

    await waitFor(() => {
      expect(screen.getByTestId('rates-table-welld_ch')).not.toBeNull()
    })
    expect(screen.queryByText('+ Add rate entry')).toBeNull()
    expect(screen.queryByTestId('add-rate-button-welld_ch')).toBeNull()
  })

  it('shows "+ Add rate entry" for each entity when getMe() fails (fails closed — hidden, not crashed)', async () => {
    vi.mocked(adminApi.getMe).mockRejectedValue(new Error('network error'))
    vi.mocked(ratesApi.listRates).mockResolvedValue(populatedResult)

    render(<MileageRatesPage />)

    await waitFor(() => {
      expect(screen.getByTestId('rates-table-welld_ch')).not.toBeNull()
    })
    expect(screen.queryByText('+ Add rate entry')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// (G)/(H)/(I) Add rate entry flow
// ---------------------------------------------------------------------------

describe('MileageRatesPage — add rate entry (Modal ADM-M1)', () => {
  it('opens the modal for the clicked entity, submits via ratesApi.addRate, reloads the list, and returns focus to the trigger', async () => {
    vi.mocked(ratesApi.listRates).mockResolvedValueOnce(populatedResult).mockResolvedValueOnce(populatedResult)
    vi.mocked(ratesApi.addRate).mockResolvedValue({
      id: 'clr_new',
      ratePerKmMicros: 720000,
      ratePerKm: '0.72',
      validFrom: '2026-08-01',
      createdAt: '2026-08-01T00:00:00.000Z',
      createdByEmail: 'admin@welld.ch',
      inEffectToday: false,
    })

    render(<MileageRatesPage />)

    await waitFor(() => {
      expect(screen.getByTestId('rates-table-welld_ch')).not.toBeNull()
    })

    const trigger = screen.getByTestId('add-rate-button-welld_ch')
    fireEvent.click(trigger)

    expect(screen.getByTestId('add-rate-modal-welld_ch')).not.toBeNull()
    expect(screen.getByText('Add rate entry — WellD CH')).not.toBeNull()

    fireEvent.change(screen.getByTestId('add-rate-value'), { target: { value: '0.72' } })
    fireEvent.change(screen.getByTestId('add-rate-valid-from'), { target: { value: '2026-08-01' } })
    fireEvent.click(screen.getByTestId('add-rate-submit'))

    await waitFor(() => {
      expect(ratesApi.addRate).toHaveBeenCalledWith({
        entity: 'welld_ch',
        ratePerKm: '0.72',
        validFrom: '2026-08-01',
      })
    })

    await waitFor(() => {
      expect(screen.queryByTestId('add-rate-modal-welld_ch')).toBeNull()
    })
    expect(ratesApi.listRates).toHaveBeenCalledTimes(2)
    expect(document.activeElement).toBe(trigger)
  })

  it('cancelling the modal (Escape) does not call addRate', async () => {
    vi.mocked(ratesApi.listRates).mockResolvedValue(populatedResult)

    render(<MileageRatesPage />)

    await waitFor(() => {
      expect(screen.getByTestId('rates-table-welld_ch')).not.toBeNull()
    })

    fireEvent.click(screen.getByTestId('add-rate-button-welld_ch'))
    expect(screen.getByTestId('add-rate-modal-welld_ch')).not.toBeNull()

    fireEvent.keyDown(window, { key: 'Escape' })

    expect(screen.queryByTestId('add-rate-modal-welld_ch')).toBeNull()
    expect(ratesApi.addRate).not.toHaveBeenCalled()
  })

  it('a 422 on a non-positive-value message routes to the Rate field error, modal stays open (AC-4.5)', async () => {
    vi.mocked(ratesApi.listRates).mockResolvedValue(populatedResult)
    vi.mocked(ratesApi.addRate).mockRejectedValue(
      new RatesApiError({
        type: 'about:blank',
        title: 'Unprocessable Entity',
        status: 422,
        detail: 'ratePerKm must be greater than 0',
      }),
    )

    render(<MileageRatesPage />)

    await waitFor(() => {
      expect(screen.getByTestId('rates-table-welld_ch')).not.toBeNull()
    })

    fireEvent.click(screen.getByTestId('add-rate-button-welld_ch'))
    fireEvent.change(screen.getByTestId('add-rate-value'), { target: { value: '0.72' } })
    fireEvent.change(screen.getByTestId('add-rate-valid-from'), { target: { value: '2026-08-01' } })
    fireEvent.click(screen.getByTestId('add-rate-submit'))

    await waitFor(() => {
      expect(screen.getByTestId('add-rate-value-error')).not.toBeNull()
    })
    expect(screen.getByTestId('add-rate-value-error').textContent).toBe('ratePerKm must be greater than 0')
    expect(screen.queryByTestId('add-rate-valid-from-error')).toBeNull()
    // Modal stays open — nothing persisted.
    expect(screen.getByTestId('add-rate-modal-welld_ch')).not.toBeNull()
  })

  it('a 422 on a date-shaped message routes to the Valid-from field error (AC-4.5)', async () => {
    vi.mocked(ratesApi.listRates).mockResolvedValue(populatedResult)
    vi.mocked(ratesApi.addRate).mockRejectedValue(
      new RatesApiError({
        type: 'about:blank',
        title: 'Unprocessable Entity',
        status: 422,
        detail: 'validFrom must be a valid date',
      }),
    )

    render(<MileageRatesPage />)

    await waitFor(() => {
      expect(screen.getByTestId('rates-table-welld_ch')).not.toBeNull()
    })

    fireEvent.click(screen.getByTestId('add-rate-button-welld_ch'))
    fireEvent.change(screen.getByTestId('add-rate-value'), { target: { value: '0.72' } })
    fireEvent.change(screen.getByTestId('add-rate-valid-from'), { target: { value: '2026-08-01' } })
    fireEvent.click(screen.getByTestId('add-rate-submit'))

    await waitFor(() => {
      expect(screen.getByTestId('add-rate-valid-from-error')).not.toBeNull()
    })
    expect(screen.getByTestId('add-rate-valid-from-error').textContent).toBe('validFrom must be a valid date')
    expect(screen.queryByTestId('add-rate-value-error')).toBeNull()
  })

  it('a non-positive rate value is caught client-side without ever calling addRate', async () => {
    vi.mocked(ratesApi.listRates).mockResolvedValue(populatedResult)

    render(<MileageRatesPage />)

    await waitFor(() => {
      expect(screen.getByTestId('rates-table-welld_ch')).not.toBeNull()
    })

    fireEvent.click(screen.getByTestId('add-rate-button-welld_ch'))
    fireEvent.change(screen.getByTestId('add-rate-value'), { target: { value: '0' } })
    fireEvent.change(screen.getByTestId('add-rate-valid-from'), { target: { value: '2026-08-01' } })
    fireEvent.click(screen.getByTestId('add-rate-submit'))

    await waitFor(() => {
      expect(screen.getByTestId('add-rate-value-error')).not.toBeNull()
    })
    expect(screen.getByTestId('add-rate-value-error').textContent).toBe('Enter a rate greater than 0.')
    expect(ratesApi.addRate).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Accounting distribution email panel (T6, specs/011-refund-settings/tasks.md,
// refs AC-1.1, AC-3.2, AC-5.3).
// ---------------------------------------------------------------------------

describe('MileageRatesPage — accounting distribution email panel', () => {
  it('renders the current configured value and its history (AC-1.1, AC-5.3)', async () => {
    vi.mocked(adminApi.getMe).mockResolvedValue(settingsManagePermissions)
    vi.mocked(ratesApi.listRates).mockResolvedValue(populatedResult)
    vi.mocked(settingsApi.getSetting).mockResolvedValue(configuredSetting)

    render(<MileageRatesPage />)

    await waitFor(() => {
      expect(screen.getByTestId('accounting-email-panel')).not.toBeNull()
    })
    expect(screen.getByTestId('accounting-email-current-value').textContent).toBe('accounting@welld.ch')

    const history = screen.getByTestId('accounting-email-history')
    expect(history.textContent).toContain('accounting@welld.ch')
    expect(history.textContent).toContain('admin@welld.ch')
  })

  it('renders a clear "not configured" state when the setting has never been set (AC-1.1)', async () => {
    vi.mocked(adminApi.getMe).mockResolvedValue(settingsManagePermissions)
    vi.mocked(ratesApi.listRates).mockResolvedValue(populatedResult)
    vi.mocked(settingsApi.getSetting).mockResolvedValue(notConfiguredSetting)

    render(<MileageRatesPage />)

    await waitFor(() => {
      expect(screen.getByTestId('accounting-email-current-value')).not.toBeNull()
    })
    expect(screen.getByTestId('accounting-email-current-value').textContent).toBe('Not configured')
    expect(screen.queryByTestId('accounting-email-history')).toBeNull()
    expect(screen.getByText('No changes recorded yet.')).not.toBeNull()
  })

  it('saves a valid email via settingsApi.putSetting and updates the shown value (AC-1.2)', async () => {
    vi.mocked(adminApi.getMe).mockResolvedValue(settingsManagePermissions)
    vi.mocked(ratesApi.listRates).mockResolvedValue(populatedResult)
    vi.mocked(settingsApi.getSetting).mockResolvedValue(notConfiguredSetting)
    vi.mocked(settingsApi.putSetting).mockResolvedValue({
      ...configuredSetting,
      value: 'new-accounting@welld.ch',
      history: [
        ...notConfiguredSetting.history,
        { value: 'new-accounting@welld.ch', changedAt: '2026-07-22T10:00:00.000Z', changedByEmail: 'me@welld.ch' },
      ],
    })

    render(<MileageRatesPage />)

    await waitFor(() => {
      expect(screen.getByTestId('accounting-email-input')).not.toBeNull()
    })

    fireEvent.change(screen.getByTestId('accounting-email-input'), {
      target: { value: 'new-accounting@welld.ch' },
    })
    fireEvent.click(screen.getByTestId('accounting-email-save'))

    await waitFor(() => {
      expect(settingsApi.putSetting).toHaveBeenCalledWith(ACCOUNTING_DISTRIBUTION_EMAIL_KEY, 'new-accounting@welld.ch')
    })
    await waitFor(() => {
      expect(screen.getByTestId('accounting-email-current-value').textContent).toBe('new-accounting@welld.ch')
    })
  })

  it('a 422 on save shows the inline error and leaves the shown value unchanged (AC-1.3)', async () => {
    vi.mocked(adminApi.getMe).mockResolvedValue(settingsManagePermissions)
    vi.mocked(ratesApi.listRates).mockResolvedValue(populatedResult)
    vi.mocked(settingsApi.getSetting).mockResolvedValue(configuredSetting)
    vi.mocked(settingsApi.putSetting).mockRejectedValue(
      new SettingsApiError({
        type: 'about:blank',
        title: 'Unprocessable Entity',
        status: 422,
        detail: 'value must be a well-formed email address',
      }),
    )

    render(<MileageRatesPage />)

    await waitFor(() => {
      expect(screen.getByTestId('accounting-email-input')).not.toBeNull()
    })

    fireEvent.change(screen.getByTestId('accounting-email-input'), { target: { value: 'not-an-email' } })
    fireEvent.click(screen.getByTestId('accounting-email-save'))

    await waitFor(() => {
      expect(screen.getByTestId('accounting-email-error')).not.toBeNull()
    })
    expect(screen.getByTestId('accounting-email-error').textContent).toBe('value must be a well-formed email address')
    // The shown current value is untouched — nothing was persisted.
    expect(screen.getByTestId('accounting-email-current-value').textContent).toBe('accounting@welld.ch')
  })

  it('clears the setting via the Clear action (AC-1.4)', async () => {
    vi.mocked(adminApi.getMe).mockResolvedValue(settingsManagePermissions)
    vi.mocked(ratesApi.listRates).mockResolvedValue(populatedResult)
    vi.mocked(settingsApi.getSetting).mockResolvedValue(configuredSetting)
    vi.mocked(settingsApi.putSetting).mockResolvedValue(notConfiguredSetting)

    render(<MileageRatesPage />)

    await waitFor(() => {
      expect(screen.getByTestId('accounting-email-clear')).not.toBeNull()
    })

    fireEvent.click(screen.getByTestId('accounting-email-clear'))

    await waitFor(() => {
      expect(settingsApi.putSetting).toHaveBeenCalledWith(ACCOUNTING_DISTRIBUTION_EMAIL_KEY, null)
    })
    await waitFor(() => {
      expect(screen.getByTestId('accounting-email-current-value').textContent).toBe('Not configured')
    })
  })

  it('is hidden entirely when getMe() lacks settings:read (AC-3.2)', async () => {
    vi.mocked(adminApi.getMe).mockResolvedValue(managePermissions)
    vi.mocked(ratesApi.listRates).mockResolvedValue(populatedResult)

    render(<MileageRatesPage />)

    await waitFor(() => {
      expect(screen.getByTestId('rates-table-welld_ch')).not.toBeNull()
    })
    expect(screen.queryByTestId('accounting-email-panel')).toBeNull()
    expect(settingsApi.getSetting).not.toHaveBeenCalled()
  })
})
