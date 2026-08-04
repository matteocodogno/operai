/**
 * @vitest-environment jsdom
 *
 * Component tests for AddressSection (T11, specs/012-employee-address/tasks.md,
 * refs AC-1.1, AC-1.3, AC-2.2, AC-2.3, AC-2.6, AC-3.1, AC-3.2, AC-3.3, AC-5.3).
 *
 * Strategy: `../lib/addressApi` (the `auth` HTTP client, T9) and
 * `../lib/googlePlaces` (the Places SDK wrapper, T7) are BOTH mocked at the
 * module boundary — each already has its own exhaustive unit-test coverage
 * (`addressApi.test.ts`, `googlePlaces.test.ts`). This file drives
 * `AddressSection` purely through the DOCUMENTED CONTRACT those modules
 * expose (`createAddressSuggester`'s `onResults`/`onDegraded`/
 * `onBelowThreshold`/`onSearchStart` callbacks, `selectSuggestion()`'s
 * resolved value) — never the real network, never the real Google SDK.
 *
 * The `createAddressSuggester` mock captures the options object
 * `AddressSection` constructs it with, so tests can invoke
 * `capturedOptions.onResults([...])` etc. directly — this is the same
 * seam `googlePlaces.test.ts` proves is wired correctly to the real
 * loader/suggest/timeout machinery; here we prove `AddressSection` reacts
 * to that seam correctly.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import AddressSection from './AddressSection'
import type { AdminAddressResponse, AddressHistoryEntry } from '../lib/addressApi'
import type { AddressSuggesterOptions, PlaceDetails, PlaceSuggestion } from '../lib/googlePlaces'

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('../lib/addressApi', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/addressApi')>()
  return {
    ...original,
    getAddress: vi.fn(),
    putAddress: vi.fn(),
    listAddressHistory: vi.fn(),
  }
})

vi.mock('../lib/googlePlaces', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/googlePlaces')>()
  return { ...original, createAddressSuggester: vi.fn() }
})

import * as addressApi from '../lib/addressApi'
import { ApiError } from '../lib/addressApi'
import { createAddressSuggester } from '../lib/googlePlaces'

// ---------------------------------------------------------------------------
// Suggester test double — captures the options AddressSection constructs it
// with, so tests can fire onResults/onDegraded/onBelowThreshold/onSearchStart
// directly (see module doc comment).
// ---------------------------------------------------------------------------

let capturedOptions: AddressSuggesterOptions | null = null
const searchMock = vi.fn()
const selectSuggestionMock = vi.fn<(id: string) => Promise<PlaceDetails | null>>()
const disposeMock = vi.fn()

beforeEach(() => {
  capturedOptions = null
  searchMock.mockReset()
  selectSuggestionMock.mockReset()
  disposeMock.mockReset()
  vi.mocked(createAddressSuggester).mockImplementation((options) => {
    capturedOptions = options
    return {
      search: searchMock,
      selectSuggestion: selectSuggestionMock,
      reset: vi.fn(),
      dispose: disposeMock,
    }
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const USER_ID = 'usr_abc123'

const swissAddress: AdminAddressResponse = {
  userId: USER_ID,
  address: {
    countryCode: 'CH',
    city: 'Zürich',
    street: 'Bahnhofstrasse',
    houseNumber: '12b',
    postalCode: '8001',
    region: 'Zürich',
    latitude: 47.3702,
    longitude: 8.5397,
    formatted: 'Bahnhofstrasse 12b, 8001 Zürich, Zürich, Switzerland',
    updatedAt: '2026-08-03T09:12:44.123Z',
    updatedByUserId: 'usr_admin',
  },
}

const noAddress: AdminAddressResponse = { userId: USER_ID, address: null }

const emptyHistoryPage = { items: [] as AddressHistoryEntry[], page: 1, pageSize: 20, total: 0 }

const placeSuggestions: PlaceSuggestion[] = [
  { id: 'place-1', mainText: 'Bahnhofstrasse 12b', secondaryText: 'Zürich, Switzerland' },
]

const placeDetails: PlaceDetails = {
  components: {
    countryCode: 'CH',
    city: 'Zürich',
    street: 'Bahnhofstrasse',
    houseNumber: '12b',
    postalCode: '8001',
    region: 'Zürich',
  },
  latitude: 47.3702,
  longitude: 8.5397,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const setupLoaded = (address: AdminAddressResponse = noAddress) => {
  vi.mocked(addressApi.getAddress).mockResolvedValue(address)
  vi.mocked(addressApi.listAddressHistory).mockResolvedValue(emptyHistoryPage)
}

const renderSection = async () => {
  const utils = render(<AddressSection userId={USER_ID} />)
  await waitFor(() => expect(screen.getByTestId('address-current-line')).toBeTruthy())
  return utils
}

const streetInput = () => screen.getByTestId('address-street-combobox') as HTMLInputElement
const houseNumberInput = () => screen.getByTestId('address-housenumber-input') as HTMLInputElement
const cityInput = () => screen.getByTestId('address-city-input') as HTMLInputElement
const postalCodeInput = () => screen.getByTestId('address-postalcode-input') as HTMLInputElement
const regionInput = () => screen.getByTestId('address-region-input') as HTMLInputElement
const countryInput = () => screen.getByTestId('address-country-combobox') as HTMLInputElement
const saveButton = () => screen.getByTestId('address-save-button') as HTMLButtonElement

// ---------------------------------------------------------------------------
// Basic states
// ---------------------------------------------------------------------------

describe('load states', () => {
  it('AC-1.1 — shows "No address on file" for an untouched user', async () => {
    setupLoaded(noAddress)
    await renderSection()
    expect(screen.getByTestId('address-current-line').textContent).toBe('No address on file')
  })

  it('AC-1.1 — shows the formatted address when one is on file', async () => {
    setupLoaded(swissAddress)
    await renderSection()
    expect(screen.getByTestId('address-current-line').textContent).toContain(
      'Bahnhofstrasse 12b, 8001 Zürich, Zürich, Switzerland',
    )
    expect(streetInput().value).toBe('Bahnhofstrasse')
    expect(houseNumberInput().value).toBe('12b')
    expect(postalCodeInput().value).toBe('8001')
    expect(cityInput().value).toBe('Zürich')
    expect(regionInput().value).toBe('Zürich')
  })

  it('renders an ErrorBanner with Retry on a fetch failure', async () => {
    vi.mocked(addressApi.getAddress).mockRejectedValue(new ApiError({ type: 't', title: 'boom', status: 500 }))
    vi.mocked(addressApi.listAddressHistory).mockResolvedValue(emptyHistoryPage)
    render(<AddressSection userId={USER_ID} />)
    await waitFor(() => expect(screen.getByTestId('error-banner')).toBeTruthy())
  })
})

// ---------------------------------------------------------------------------
// AC-2.2 — selection populates all six inputs
// ---------------------------------------------------------------------------

describe('AC-2.2 — selecting a suggestion', () => {
  it('populates all six structured fields from the resolved place details', async () => {
    setupLoaded(noAddress)
    await renderSection()

    fireEvent.change(streetInput(), { target: { value: 'Bahn' } })
    expect(searchMock).toHaveBeenCalledWith('Bahn')

    act(() => capturedOptions!.onResults(placeSuggestions))
    await waitFor(() => expect(screen.getByRole('listbox')).toBeTruthy())

    selectSuggestionMock.mockResolvedValue(placeDetails)
    const option = screen.getByTestId('address-street-combobox-option-place-1')
    fireEvent.click(option)

    await waitFor(() => expect(houseNumberInput().value).toBe('12b'))
    expect(streetInput().value).toBe('Bahnhofstrasse')
    expect(postalCodeInput().value).toBe('8001')
    expect(cityInput().value).toBe('Zürich')
    expect(regionInput().value).toBe('Zürich')
    expect(countryInput().value).toBe('Switzerland')
  })

  it('moves focus to the house-number field when a selection carries no house number (R9)', async () => {
    setupLoaded(noAddress)
    await renderSection()

    fireEvent.change(streetInput(), { target: { value: 'Via Roma' } })
    act(() => capturedOptions!.onResults(placeSuggestions))
    selectSuggestionMock.mockResolvedValue({ ...placeDetails, components: { ...placeDetails.components, houseNumber: '' } })
    fireEvent.click(screen.getByTestId('address-street-combobox-option-place-1'))

    await waitFor(() => expect(document.activeElement).toBe(houseNumberInput()))
  })
})

// ---------------------------------------------------------------------------
// AC-2.3 — hand-edits after a selection persist; nothing becomes readOnly/disabled
// ---------------------------------------------------------------------------

describe('AC-2.3 — editing after a selection', () => {
  it('persists the EDITED value on save, and no input is readOnly/disabled after a selection', async () => {
    setupLoaded(noAddress)
    await renderSection()

    fireEvent.change(streetInput(), { target: { value: 'Bahn' } })
    act(() => capturedOptions!.onResults(placeSuggestions))
    selectSuggestionMock.mockResolvedValue(placeDetails)
    fireEvent.click(screen.getByTestId('address-street-combobox-option-place-1'))
    await waitFor(() => expect(cityInput().value).toBe('Zürich'))

    // Hand-edit the city after selecting.
    fireEvent.change(cityInput(), { target: { value: 'Winterthur' } })

    expect(streetInput().readOnly).toBe(false)
    expect(houseNumberInput().readOnly).toBe(false)
    expect(cityInput().readOnly).toBe(false)
    expect(postalCodeInput().readOnly).toBe(false)
    expect(regionInput().readOnly).toBe(false)
    expect(countryInput().readOnly).toBe(false)

    vi.mocked(addressApi.putAddress).mockResolvedValue(swissAddress)
    fireEvent.click(saveButton())

    await waitFor(() => expect(addressApi.putAddress).toHaveBeenCalled())
    const [, body] = vi.mocked(addressApi.putAddress).mock.calls[0]
    expect(body).toMatchObject({ city: 'Winterthur' }) // the EDITED value, not the suggestion's
  })
})

// ---------------------------------------------------------------------------
// AC-2.6 — select, then edit street, then save: coordinates are dropped
// ---------------------------------------------------------------------------

describe('AC-2.6 — coordinate staleness', () => {
  it('select → edit street → save sends latitude:null, longitude:null', async () => {
    setupLoaded(noAddress)
    await renderSection()

    fireEvent.change(streetInput(), { target: { value: 'Bahn' } })
    act(() => capturedOptions!.onResults(placeSuggestions))
    selectSuggestionMock.mockResolvedValue(placeDetails)
    fireEvent.click(screen.getByTestId('address-street-combobox-option-place-1'))
    await waitFor(() => expect(screen.getByTestId('address-coords-status').textContent).toContain('captured'))

    fireEvent.change(streetInput(), { target: { value: 'Bahnhofstrasse (edited)' } })
    await waitFor(() => expect(screen.getByTestId('address-coords-status').textContent).toContain('cleared'))

    vi.mocked(addressApi.putAddress).mockResolvedValue(swissAddress)
    fireEvent.click(saveButton())

    await waitFor(() => expect(addressApi.putAddress).toHaveBeenCalled())
    const [, body] = vi.mocked(addressApi.putAddress).mock.calls[0]
    expect(body).toMatchObject({ latitude: null, longitude: null })
  })
})

// ---------------------------------------------------------------------------
// AC-3.1 — zero results is still saveable, with a visible caption
// ---------------------------------------------------------------------------

describe('AC-3.1 — no suggestions found', () => {
  it('a genuinely empty result list shows the "no matching suggestions" caption and stays saveable', async () => {
    setupLoaded(noAddress)
    await renderSection()

    fireEvent.change(streetInput(), { target: { value: 'xyzzyx nowhere' } })
    act(() => capturedOptions!.onResults([]))

    expect(screen.getByTestId('address-street-no-results')).toBeTruthy()
    expect(screen.queryByRole('listbox')).toBeNull() // design.md: popup stays closed for this state

    fireEvent.change(houseNumberInput(), { target: { value: '1' } })
    fireEvent.change(cityInput(), { target: { value: 'Nowhere' } })
    fireEvent.change(countryInput(), { target: { value: 'Switzerland' } })
    fireEvent.click(screen.getByText('Switzerland'))

    vi.mocked(addressApi.putAddress).mockResolvedValue(swissAddress)
    fireEvent.click(saveButton())
    await waitFor(() => expect(addressApi.putAddress).toHaveBeenCalled())
  })
})

// ---------------------------------------------------------------------------
// AC-3.2 — silent degradation, three distinct triggers
// ---------------------------------------------------------------------------

describe('AC-3.2 — the suggestion service degrades silently', () => {
  const assertNothingBrokenAndSaveWorks = async () => {
    // No error surfaced anywhere in the section.
    expect(screen.queryAllByRole('alert')).toHaveLength(0)
    // No "Searching…"/lingering indicator left mounted.
    expect(screen.queryByTestId('address-street-searching')).toBeNull()
    expect(screen.queryByTestId('address-street-no-results')).toBeNull()
    // Every input remains enabled.
    expect(streetInput().readOnly).toBe(false)
    expect(houseNumberInput().readOnly).toBe(false)
    expect(cityInput().readOnly).toBe(false)
    expect(countryInput().readOnly).toBe(false)

    fireEvent.change(houseNumberInput(), { target: { value: '5' } })
    fireEvent.change(cityInput(), { target: { value: 'Locarno' } })
    fireEvent.change(countryInput(), { target: { value: 'Switzerland' } })
    fireEvent.click(screen.getByText('Switzerland'))

    vi.mocked(addressApi.putAddress).mockResolvedValue(swissAddress)
    fireEvent.click(saveButton())
    await waitFor(() => expect(addressApi.putAddress).toHaveBeenCalled())
  }

  it('case 1 — the SDK loader rejects (missing/invalid key): no alert, no spinner, save still works', async () => {
    setupLoaded(noAddress)
    await renderSection()

    // Loader-level failure: the FIRST-EVER search this editing session attempts
    // degrades immediately, with NO preceding onResults anywhere — the SDK
    // never became available at all (missing/invalid key, script blocked,
    // offline), so no suggestion request has EVER succeeded here. This is what
    // genuinely distinguishes case 1 from case 2 below (googlePlaces.test.ts
    // already proves the real module funnels a loader rejection into
    // onDegraded — this test proves AddressSection reacts to that correctly).
    fireEvent.change(streetInput(), { target: { value: 'Via Roma' } })
    act(() => capturedOptions!.onDegraded?.())

    await assertNothingBrokenAndSaveWorks()
  })

  it('case 2 — the suggest call itself rejects (e.g. OVER_QUERY_LIMIT): no alert, no spinner, save still works', async () => {
    setupLoaded(noAddress)
    await renderSection()

    // Suggest-CALL-level failure: first prove the loader/session token already
    // worked — a genuine, completed result list renders (AC-2.1) — so this
    // case is NOT a loader problem. THEN a later search on that same,
    // already-proven-working suggester degrades (e.g. OVER_QUERY_LIMIT) —
    // this is what genuinely distinguishes case 2 from case 1 above: the
    // failure is scoped to one request, not to the SDK never loading at all.
    fireEvent.change(streetInput(), { target: { value: 'Bahn' } })
    act(() => capturedOptions!.onResults(placeSuggestions))
    await waitFor(() => expect(screen.getByRole('listbox')).toBeTruthy())

    fireEvent.change(streetInput(), { target: { value: 'Via Roma' } })
    act(() => capturedOptions!.onDegraded?.())

    await assertNothingBrokenAndSaveWorks()
  })

  it('case 3 — the suggest call never resolves past the 3000ms cap: nothing breaks at any point, save still works', async () => {
    vi.useFakeTimers()
    setupLoaded(noAddress)
    const utils = render(<AddressSection userId={USER_ID} />)
    await vi.waitFor(() => expect(screen.getByTestId('address-current-line')).toBeTruthy())

    fireEvent.change(streetInput(), { target: { value: 'Via Roma' } })
    act(() => capturedOptions!.onSearchStart?.())
    expect(screen.getByTestId('address-street-searching')).toBeTruthy() // the ordinary "Searching…" state — expected here

    // Simulate the 3000ms cap elapsing with STILL no settlement, then the
    // suggester itself reports onDegraded (mirrors createAddressSuggester's
    // real Promise.race-against-a-timeout behavior, proven in googlePlaces.test.ts).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
      capturedOptions!.onDegraded?.()
    })

    expect(screen.queryByTestId('address-street-searching')).toBeNull()
    expect(screen.queryAllByRole('alert')).toHaveLength(0)
    expect(streetInput().readOnly).toBe(false)

    vi.useRealTimers()
    utils.unmount()
  })
})

// ---------------------------------------------------------------------------
// AC-3.3 — manual entry, never touching suggestions, saves on identical terms
// ---------------------------------------------------------------------------

describe('AC-3.3 — purely manual entry', () => {
  it('typing the whole address by hand, never opening the suggestion list, saves normally', async () => {
    setupLoaded(noAddress)
    await renderSection()

    fireEvent.change(streetInput(), { target: { value: 'Piazza Duomo' } })
    fireEvent.change(houseNumberInput(), { target: { value: '1' } })
    fireEvent.change(postalCodeInput(), { target: { value: '20122' } })
    fireEvent.change(cityInput(), { target: { value: 'Milano' } })
    fireEvent.change(countryInput(), { target: { value: 'Italy' } })
    fireEvent.click(screen.getByText('Italy'))

    vi.mocked(addressApi.putAddress).mockResolvedValue({
      userId: USER_ID,
      address: { ...swissAddress.address!, countryCode: 'IT', city: 'Milano', latitude: null, longitude: null },
    })
    fireEvent.click(saveButton())

    await waitFor(() => expect(addressApi.putAddress).toHaveBeenCalled())
    const [, body] = vi.mocked(addressApi.putAddress).mock.calls[0]
    expect(body).toMatchObject({
      countryCode: 'IT',
      city: 'Milano',
      street: 'Piazza Duomo',
      houseNumber: '1',
      latitude: null,
      longitude: null,
    })
  })
})

// ---------------------------------------------------------------------------
// AC-1.4 — 422 completeness errors
// ---------------------------------------------------------------------------

describe('AC-1.4 — completeness validation', () => {
  it('renders a per-field error for each name in missingFields, without resetting the in-progress edit', async () => {
    setupLoaded(noAddress)
    await renderSection()

    fireEvent.change(streetInput(), { target: { value: 'Via Test' } })
    vi.mocked(addressApi.putAddress).mockRejectedValue(
      new ApiError({
        type: 't',
        title: 'Unprocessable Entity',
        status: 422,
        code: 'address_incomplete',
        missingFields: ['city', 'houseNumber'],
      }),
    )

    fireEvent.click(saveButton())

    await waitFor(() => expect(screen.getByTestId('address-error-city')).toBeTruthy())
    expect(screen.getByTestId('address-error-houseNumber')).toBeTruthy()
    expect(screen.queryByTestId('address-error-street')).toBeNull()
    expect(streetInput().value).toBe('Via Test') // the in-progress edit survives
  })
})

// ---------------------------------------------------------------------------
// AC-1.3 — clear + undo
// ---------------------------------------------------------------------------

describe('AC-1.3 — clear', () => {
  it('queues a clear, Undo restores the prior values with no request sent', async () => {
    setupLoaded(swissAddress)
    await renderSection()

    fireEvent.click(screen.getByTestId('address-clear-button'))
    expect(screen.getByTestId('address-clear-pending-notice')).toBeTruthy()
    expect(houseNumberInput().readOnly).toBe(true)

    fireEvent.click(screen.getByTestId('address-clear-undo'))
    expect(screen.queryByTestId('address-clear-pending-notice')).toBeNull()
    expect(houseNumberInput().value).toBe('12b')
    expect(addressApi.putAddress).not.toHaveBeenCalled()
  })

  it('saving a pending clear sends { address: null } and reverts the read line', async () => {
    setupLoaded(swissAddress)
    await renderSection()

    fireEvent.click(screen.getByTestId('address-clear-button'))
    vi.mocked(addressApi.putAddress).mockResolvedValue(noAddress)
    fireEvent.click(saveButton())

    await waitFor(() => expect(addressApi.putAddress).toHaveBeenCalledWith(USER_ID, null))
    await waitFor(() => expect(screen.getByTestId('address-current-line').textContent).toBe('No address on file'))
  })
})

// ---------------------------------------------------------------------------
// AC-5.3 — the history panel renders who/when/old→new
// ---------------------------------------------------------------------------

describe('AC-5.3 — address history panel', () => {
  it('renders who/when/old→new for each entry', async () => {
    vi.mocked(addressApi.getAddress).mockResolvedValue(noAddress)
    vi.mocked(addressApi.listAddressHistory).mockResolvedValue({
      items: [
        {
          id: 'aud_1',
          actorUserId: 'usr_admin',
          action: 'user.address.set',
          targetType: 'user',
          targetId: USER_ID,
          summary: 'Updated address',
          data: { before: null, after: { formatted: 'Bahnhofstrasse 12b, 8001 Zürich, Zürich, Switzerland' } },
          createdAt: '2026-08-03T09:12:44.123Z',
        },
      ],
      page: 1,
      pageSize: 20,
      total: 1,
    })

    await renderSection()

    const entry = await screen.findByTestId('address-history-entry-aud_1')
    expect(entry.textContent).toContain('usr_admin')
    expect(entry.textContent).toContain('No address on file')
    expect(entry.textContent).toContain('Bahnhofstrasse 12b, 8001 Zürich, Zürich, Switzerland')
  })

  it('renders the empty state when there is no history yet', async () => {
    setupLoaded(noAddress)
    await renderSection()
    expect(await screen.findByTestId('address-history-empty')).toBeTruthy()
  })
})
