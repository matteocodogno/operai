/**
 * Unit tests for src/lib/googlePlaces.ts (T7, specs/012-employee-address/tasks.md,
 * refs AC-2.1, AC-2.2, AC-2.4, AC-2.5, AC-3.2).
 *
 * `createAddressSuggester` is driven with fake timers against an injected
 * fake `GooglePlacesLibrary` (`deps.loadPlacesLibrary`) — no real network,
 * no real Google SDK. This proves the debounce/supersession/timeout state
 * machine and the request-shape contract (the single most consequential
 * regression surface named by plan.md R3 / this feature's dispatch brief:
 * `locationBias` present, `includedRegionCodes` absent) without depending on
 * a browser-loaded script.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CH_IT_LOCATION_BIAS,
  DEBOUNCE_MS,
  MAX_SUGGESTIONS,
  MIN_QUERY_LENGTH,
  REQUEST_TIMEOUT_MS,
  buildAutocompleteRequest,
  createAddressSuggester,
  mapAddressComponents,
  quantizeCoordinate,
} from './googlePlaces'
import type { GoogleAddressComponent } from './googlePlaces'

// ---------------------------------------------------------------------------
// A fake GooglePlacesLibrary — just enough surface for the suggester to
// drive: a session-token constructor and a mockable
// `fetchAutocompleteSuggestions`.
// ---------------------------------------------------------------------------

class FakeSessionToken {}

const makePrediction = (id: string, main = `${id} main`, secondary = `${id} secondary`) => ({
  placeId: id,
  mainText: { text: main },
  secondaryText: { text: secondary },
  toPlace: vi.fn(),
})

const fetchAutocompleteSuggestions = vi.fn()

const fakeLibrary = {
  AutocompleteSessionToken: FakeSessionToken,
  AutocompleteSuggestion: { fetchAutocompleteSuggestions },
}

const loadPlacesLibrary = vi.fn().mockResolvedValue(fakeLibrary)

beforeEach(() => {
  vi.useFakeTimers()
  fetchAutocompleteSuggestions.mockReset()
  loadPlacesLibrary.mockClear()
  loadPlacesLibrary.mockResolvedValue(fakeLibrary)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// buildAutocompleteRequest — the single most consequential regression
// surface in this feature (dispatch brief item #1 / plan.md R3).
// ---------------------------------------------------------------------------

describe('buildAutocompleteRequest', () => {
  it('has locationBias set to the CH+IT rectangle', () => {
    const request = buildAutocompleteRequest('Bahnhofstrasse', 'token', 'en')
    expect(request.locationBias).toEqual(CH_IT_LOCATION_BIAS)
  })

  it('does NOT set includedRegionCodes — a restriction, never a bias (AC-2.4)', () => {
    const request = buildAutocompleteRequest('Bahnhofstrasse', 'token', 'en')
    expect(request).not.toHaveProperty('includedRegionCodes')
    expect(Object.keys(request).sort()).toEqual(
      ['includedPrimaryTypes', 'input', 'language', 'locationBias', 'sessionToken'].sort(),
    )
  })

  it('restricts to street-level place types (a type filter, not geographic)', () => {
    const request = buildAutocompleteRequest('Via Roma', 'token', 'it')
    expect(request.includedPrimaryTypes).toEqual(['street_address', 'route', 'premise', 'subpremise'])
  })

  it("never sends the LEGACY 'address' type — Places API (New) 400s on it", () => {
    // Regression guard. `['address']` is a legacy Autocomplete `types` value;
    // the new API rejects the whole request with
    // `400 INVALID_ARGUMENT — Invalid included_primary_types 'address'`.
    // AC-3.2's silent degradation then swallows it, so EVERY suggestion request
    // fails with nothing visibly wrong — which is precisely how it shipped
    // undetected (observed 2026-08-07). The previous version of this test
    // asserted the broken value, so it locked the bug in rather than catching
    // it: a unit test can only prove the request SHAPE, never that Google
    // accepts it.
    const request = buildAutocompleteRequest('Via Roma', 'token', 'it')
    expect(request.includedPrimaryTypes).not.toContain('address')
    // Also guard the other too-broad option: `geocode` is accepted by the API
    // but offers cities as suggestions, which can never satisfy AC-1.4's
    // house-number requirement.
    expect(request.includedPrimaryTypes).not.toContain('geocode')
  })

  it('carries the requested language', () => {
    expect(buildAutocompleteRequest('x', 't', 'it').language).toBe('it')
    expect(buildAutocompleteRequest('x', 't', 'en').language).toBe('en')
  })
})

// ---------------------------------------------------------------------------
// mapAddressComponents — component mapping incl. the fallback chain (AC-2.2)
// ---------------------------------------------------------------------------

describe('mapAddressComponents', () => {
  const swissFixture: GoogleAddressComponent[] = [
    { longText: 'Bahnhofstrasse', shortText: 'Bahnhofstrasse', types: ['route'] },
    { longText: '12b', shortText: '12b', types: ['street_number'] },
    { longText: '8001', shortText: '8001', types: ['postal_code'] },
    { longText: 'Zürich', shortText: 'Zürich', types: ['locality', 'political'] },
    { longText: 'Zürich', shortText: 'ZH', types: ['administrative_area_level_1', 'political'] },
    { longText: 'Switzerland', shortText: 'CH', types: ['country', 'political'] },
  ]

  it('maps a full Swiss fixture to all six fields', () => {
    expect(mapAddressComponents(swissFixture)).toEqual({
      countryCode: 'CH',
      city: 'Zürich',
      street: 'Bahnhofstrasse',
      houseNumber: '12b',
      postalCode: '8001',
      region: 'Zürich',
    })
  })

  it('upper-cases the country short code', () => {
    const lower: GoogleAddressComponent[] = [{ longText: 'Italy', shortText: 'it', types: ['country'] }]
    expect(mapAddressComponents(lower).countryCode).toBe('IT')
  })

  it('falls back locality → postal_town → administrative_area_level_3 → administrative_area_level_2 for city', () => {
    const postalTownOnly: GoogleAddressComponent[] = [
      { longText: 'Some Town', types: ['postal_town'] },
      { longText: 'IT', shortText: 'IT', types: ['country'] },
    ]
    expect(mapAddressComponents(postalTownOnly).city).toBe('Some Town')

    // IT comune is frequently administrative_area_level_3 — plan.md's named case.
    const italianComune: GoogleAddressComponent[] = [
      { longText: 'Bologna', types: ['administrative_area_level_3'] },
      { longText: 'IT', shortText: 'IT', types: ['country'] },
    ]
    expect(mapAddressComponents(italianComune).city).toBe('Bologna')

    const provinceFallback: GoogleAddressComponent[] = [
      { longText: 'Some Province', types: ['administrative_area_level_2'] },
    ]
    expect(mapAddressComponents(provinceFallback).city).toBe('Some Province')
  })

  it('leaves houseNumber empty for a route-level prediction with no street_number (plan.md R9)', () => {
    const routeOnly: GoogleAddressComponent[] = [
      { longText: 'Via Roma', types: ['route'] },
      { longText: 'IT', shortText: 'IT', types: ['country'] },
    ]
    const mapped = mapAddressComponents(routeOnly)
    expect(mapped.houseNumber).toBe('')
    expect(mapped.street).toBe('Via Roma')
  })

  it('leaves postalCode/region empty when absent — they are optional (never invented)', () => {
    const minimal: GoogleAddressComponent[] = [
      { longText: 'Via Roma', types: ['route'] },
      { longText: '1', types: ['street_number'] },
      { longText: 'Roma', types: ['locality'] },
      { longText: 'IT', shortText: 'IT', types: ['country'] },
    ]
    const mapped = mapAddressComponents(minimal)
    expect(mapped.postalCode).toBe('')
    expect(mapped.region).toBe('')
  })
})

// ---------------------------------------------------------------------------
// quantizeCoordinate
// ---------------------------------------------------------------------------

describe('quantizeCoordinate', () => {
  it('rounds to 6 decimal places by default', () => {
    expect(quantizeCoordinate(47.370199999)).toBe(47.3702)
    expect(quantizeCoordinate(8.539699999)).toBe(8.5397)
  })

  it('does not distort an already-6dp value', () => {
    expect(quantizeCoordinate(47.370201)).toBe(47.370201)
  })
})

// ---------------------------------------------------------------------------
// createAddressSuggester — debounce / min-length / supersession / timeout
// ---------------------------------------------------------------------------

describe('createAddressSuggester', () => {
  it('makes zero calls for fewer than MIN_QUERY_LENGTH characters, and reports onBelowThreshold (not onResults)', async () => {
    expect(MIN_QUERY_LENGTH).toBe(3)
    const onResults = vi.fn()
    const onBelowThreshold = vi.fn()
    const suggester = createAddressSuggester({ onResults, onBelowThreshold, language: 'en' }, { loadPlacesLibrary })

    suggester.search('ab')
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 10)

    expect(fetchAutocompleteSuggestions).not.toHaveBeenCalled()
    expect(onBelowThreshold).toHaveBeenCalledTimes(1) // clears immediately, not debounced
    expect(onResults).not.toHaveBeenCalled() // AC-3.1's caption path must never fire for "too short", not a genuine zero-result search
  })

  it('fires exactly one request after the 300ms debounce for 3+ characters', async () => {
    fetchAutocompleteSuggestions.mockResolvedValue({ suggestions: [] })
    const onResults = vi.fn()
    const suggester = createAddressSuggester({ onResults, language: 'en' }, { loadPlacesLibrary })

    suggester.search('via')
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS - 50)
    expect(fetchAutocompleteSuggestions).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(50)
    expect(fetchAutocompleteSuggestions).toHaveBeenCalledTimes(1)
  })

  it('rapid typing before the debounce elapses fires exactly one request, for the LAST value', async () => {
    fetchAutocompleteSuggestions.mockResolvedValue({ suggestions: [] })
    const suggester = createAddressSuggester({ onResults: vi.fn(), language: 'en' }, { loadPlacesLibrary })

    suggester.search('vi')
    await vi.advanceTimersByTimeAsync(100)
    suggester.search('via')
    await vi.advanceTimersByTimeAsync(100)
    suggester.search('viale')
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 10)

    expect(fetchAutocompleteSuggestions).toHaveBeenCalledTimes(1)
    const [request] = fetchAutocompleteSuggestions.mock.calls[0] as [{ input: string }]
    expect(request.input).toBe('viale')
  })

  it('discards a stale response superseded by a later search (in-flight supersession)', async () => {
    const onResults = vi.fn()
    let resolveFirst: (value: { suggestions: unknown[] }) => void = () => {}
    fetchAutocompleteSuggestions.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve
        }),
    )
    const suggester = createAddressSuggester({ onResults, language: 'en' }, { loadPlacesLibrary })

    suggester.search('via roma')
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    expect(fetchAutocompleteSuggestions).toHaveBeenCalledTimes(1)

    // A second, newer search starts before the first resolves.
    fetchAutocompleteSuggestions.mockResolvedValueOnce({ suggestions: [] })
    suggester.search('via milano')
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)

    onResults.mockClear()
    // The stale first request now resolves — its result must be discarded.
    resolveFirst({ suggestions: [{ placePrediction: makePrediction('stale') }] })
    await vi.advanceTimersByTimeAsync(0)

    expect(onResults).not.toHaveBeenCalledWith([
      { id: 'stale', mainText: 'stale main', secondaryText: 'stale secondary' },
    ])
  })

  it('caps at MAX_SUGGESTIONS and maps id/mainText/secondaryText', async () => {
    const predictions = Array.from({ length: 8 }, (_, i) => ({ placePrediction: makePrediction(`p${i}`) }))
    fetchAutocompleteSuggestions.mockResolvedValue({ suggestions: predictions })
    const onResults = vi.fn()
    const suggester = createAddressSuggester({ onResults, language: 'en' }, { loadPlacesLibrary })

    suggester.search('bahnhofstrasse')
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    await vi.advanceTimersByTimeAsync(0)

    expect(MAX_SUGGESTIONS).toBe(5)
    const lastCall = onResults.mock.calls[onResults.mock.calls.length - 1]?.[0] as unknown[]
    expect(lastCall).toHaveLength(5)
    expect(lastCall[0]).toEqual({ id: 'p0', mainText: 'p0 main', secondaryText: 'p0 secondary' })
  })

  it('AC-3.2 — a request that never resolves past the 3000ms cap fires onDegraded, never onResults (never a hang)', async () => {
    fetchAutocompleteSuggestions.mockImplementationOnce(() => new Promise(() => {})) // never settles
    const onResults = vi.fn()
    const onDegraded = vi.fn()
    const suggester = createAddressSuggester({ onResults, onDegraded, language: 'en' }, { loadPlacesLibrary })

    suggester.search('via lunga')
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    expect(REQUEST_TIMEOUT_MS).toBe(3000)
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 10)

    expect(onDegraded).toHaveBeenCalledTimes(1)
    expect(onResults).not.toHaveBeenCalled() // must never be confused with AC-3.1's captioned "genuine zero results"
  })

  it('AC-3.2 — a rejected suggest call fires onDegraded, never surfaced as onResults([]) or an error', async () => {
    fetchAutocompleteSuggestions.mockRejectedValueOnce(new Error('OVER_QUERY_LIMIT'))
    const onResults = vi.fn()
    const onDegraded = vi.fn()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const suggester = createAddressSuggester({ onResults, onDegraded, language: 'en' }, { loadPlacesLibrary })

    suggester.search('via roma')
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    await vi.advanceTimersByTimeAsync(0)

    expect(onDegraded).toHaveBeenCalledTimes(1)
    expect(onResults).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('AC-3.2 — a loader rejection (missing/invalid key) fires onDegraded, never onResults', async () => {
    const failingLoader = vi.fn().mockRejectedValue(new Error('VITE_GOOGLE_MAPS_API_KEY is not set'))
    const onResults = vi.fn()
    const onDegraded = vi.fn()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const suggester = createAddressSuggester(
      { onResults, onDegraded, language: 'en' },
      { loadPlacesLibrary: failingLoader },
    )

    suggester.search('via roma')
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    await vi.advanceTimersByTimeAsync(0)

    expect(onDegraded).toHaveBeenCalledTimes(1)
    expect(onResults).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('AC-3.1 — a genuinely completed search with zero results fires onResults([]), not onDegraded', async () => {
    fetchAutocompleteSuggestions.mockResolvedValueOnce({ suggestions: [] })
    const onResults = vi.fn()
    const onDegraded = vi.fn()
    const suggester = createAddressSuggester({ onResults, onDegraded, language: 'en' }, { loadPlacesLibrary })

    suggester.search('xyzzyx nowhere')
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    await vi.advanceTimersByTimeAsync(0)

    expect(onResults).toHaveBeenCalledWith([])
    expect(onDegraded).not.toHaveBeenCalled()
  })

  it('calls onSearchStart once the debounce elapses and the request is about to fire', async () => {
    fetchAutocompleteSuggestions.mockResolvedValue({ suggestions: [] })
    const onSearchStart = vi.fn()
    const suggester = createAddressSuggester(
      { onResults: vi.fn(), onSearchStart, language: 'en' },
      { loadPlacesLibrary },
    )

    suggester.search('bahnhofstrasse')
    expect(onSearchStart).not.toHaveBeenCalled() // not yet — still debouncing
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    expect(onSearchStart).toHaveBeenCalledTimes(1)
  })

  describe('selectSuggestion', () => {
    it('maps the resolved place to components + quantized coordinates and clears the session token', async () => {
      const location = { lat: () => 47.370199999, lng: () => 8.539699999 }
      const prediction = makePrediction('p0')
      vi.mocked(prediction.toPlace).mockReturnValue({
        addressComponents: [
          { longText: 'Bahnhofstrasse', types: ['route'] },
          { longText: '12b', types: ['street_number'] },
          { longText: 'Zürich', types: ['locality'] },
          { longText: 'CH', shortText: 'CH', types: ['country'] },
        ],
        location,
        fetchFields: vi.fn().mockResolvedValue(undefined),
      })
      fetchAutocompleteSuggestions.mockResolvedValue({ suggestions: [{ placePrediction: prediction }] })

      const suggester = createAddressSuggester({ onResults: vi.fn(), language: 'en' }, { loadPlacesLibrary })
      suggester.search('bahnhofstrasse')
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
      await vi.advanceTimersByTimeAsync(0)

      const details = await suggester.selectSuggestion('p0')
      expect(details).toEqual({
        components: {
          countryCode: 'CH',
          city: 'Zürich',
          street: 'Bahnhofstrasse',
          houseNumber: '12b',
          postalCode: '',
          region: '',
        },
        latitude: 47.3702,
        longitude: 8.5397,
      })
    })

    it('returns null for an unknown id (never throws)', async () => {
      const suggester = createAddressSuggester({ onResults: vi.fn(), language: 'en' }, { loadPlacesLibrary })
      await expect(suggester.selectSuggestion('unknown')).resolves.toBeNull()
    })

    it('AC-3.2 — a fetchFields failure resolves to null, never throws', async () => {
      const prediction = makePrediction('p0')
      vi.mocked(prediction.toPlace).mockReturnValue({
        fetchFields: vi.fn().mockRejectedValue(new Error('network error')),
      })
      fetchAutocompleteSuggestions.mockResolvedValue({ suggestions: [{ placePrediction: prediction }] })
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      const suggester = createAddressSuggester({ onResults: vi.fn(), language: 'en' }, { loadPlacesLibrary })
      suggester.search('bahnhofstrasse')
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
      await vi.advanceTimersByTimeAsync(0)

      await expect(suggester.selectSuggestion('p0')).resolves.toBeNull()
      warnSpy.mockRestore()
    })
  })
})
