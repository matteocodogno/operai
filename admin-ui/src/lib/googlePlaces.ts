/**
 * googlePlaces — the Google Places API (New) client module (T7,
 * specs/012-employee-address/tasks.md, refs AC-2.1, AC-2.2, AC-2.4, AC-2.5,
 * AC-3.2; ADR-0032; plan.md "Google Maps autocomplete").
 *
 * Browser-direct, never proxied through `auth` (ADR-0032 decision #1) — the
 * admin's browser calls Google using a public, referrer-restricted,
 * API-restricted, quota-capped key (`VITE_GOOGLE_MAPS_API_KEY`,
 * admin-ui's first `import.meta.env.VITE_*`).
 *
 * Uses Places API (New) via the Maps JavaScript API's dynamic-library
 * loader (`google.maps.importLibrary('places')`) — never the legacy
 * `Autocomplete`/`AutocompleteService` classes (closed to new customers,
 * plan.md "Rejected alternatives") and never the `PlaceAutocompleteElement`
 * web component (renders Google-owned DOM, fights this repo's
 * native-elements-only a11y posture, plan.md again).
 *
 * ⚠ `locationBias` is used for the CH/IT ranking preference (AC-2.4).
 * `includedRegionCodes` MUST NEVER be set on the constructed request — it is
 * a RESTRICTION, not a bias, and would make every non-CH/IT address
 * unreachable, silently violating AC-2.4 (ADR-0032 decision #3, plan.md R3).
 * `googlePlaces.test.ts` asserts the constructed request object HAS
 * `locationBias` and DOES NOT HAVE `includedRegionCodes`.
 *
 * Request contract, exactly per plan.md "Request contract — spelled out,
 * not left to feel":
 *   - Minimum 3 characters (after trim) before any request fires (AC-2.1).
 *   - 300ms debounce of input idleness.
 *   - In-flight supersession: a stale response (superseded by a later
 *     keystroke) is discarded via a monotonic sequence number.
 *   - A 3000ms per-request cap; a request that hasn't settled by then is
 *     treated as "no suggestions" (AC-3.2 — never a hanging spinner).
 *   - Max 5 rendered suggestions.
 *   - One `AutocompleteSessionToken` per editing session — minted on first
 *     keystroke, passed to every suggest call, consumed by the terminating
 *     `place.fetchFields()`; a new token begins after each completed
 *     selection or 3 minutes of idleness (correct per-session billing).
 *   - `includedPrimaryTypes: ['address']` (a TYPE filter, excludes
 *     businesses/POIs — not geographic, so it does not affect AC-2.4).
 *   - Details field mask `['addressComponents', 'location']` only (minimal
 *     billing tier).
 *
 * AC-3.2 — every failure mode (SDK load failure, a suggest request that
 * errors, times out, or is rate-limited) is swallowed here and reported to
 * the caller as an empty suggestion list / `null` details — this module
 * NEVER throws out of `search()`/`selectSuggestion()` in a way a consumer
 * would need to catch to stay in a working state. A `console.warn` is the
 * only observable trace, matching plan.md's "Failure modes" table.
 */

// ---------------------------------------------------------------------------
// Minimal local typings for the slice of the Google Places API (New) this
// module actually calls — no `@types/google.maps` dependency is added
// (outside this task's touch: list), so these are hand-written and
// intentionally narrow.
// ---------------------------------------------------------------------------

export interface GoogleAddressComponent {
  longText?: string
  shortText?: string
  types: string[]
}

interface GoogleLatLng {
  lat: () => number
  lng: () => number
}

interface GooglePlace {
  addressComponents?: GoogleAddressComponent[]
  location?: GoogleLatLng | null
  fetchFields: (options: { fields: string[] }) => Promise<unknown>
}

interface GooglePlacePrediction {
  placeId: string
  text?: { text: string }
  mainText?: { text: string } | null
  secondaryText?: { text: string } | null
  toPlace: () => GooglePlace
}

interface GoogleAutocompleteSuggestion {
  placePrediction: GooglePlacePrediction | null
}

interface GooglePlacesLibrary {
  AutocompleteSessionToken: new () => unknown
  AutocompleteSuggestion: {
    fetchAutocompleteSuggestions: (
      request: AutocompleteRequestShape,
    ) => Promise<{ suggestions: GoogleAutocompleteSuggestion[] }>
  }
}

declare global {
  interface Window {
    google?: {
      maps?: {
        importLibrary?: (name: string) => Promise<unknown>
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Constants — plan.md's request contract, named so tests assert against the
// same source of truth rather than a duplicated magic number.
// ---------------------------------------------------------------------------

export const MIN_QUERY_LENGTH = 3
export const DEBOUNCE_MS = 300
export const REQUEST_TIMEOUT_MS = 3000
export const MAX_SUGGESTIONS = 5
export const SESSION_IDLE_MS = 3 * 60 * 1000

/** Rectangle covering Switzerland + Italy (incl. Sicily/Sardinia) — AC-2.4. */
export const CH_IT_LOCATION_BIAS = { west: 5.9, south: 35.4, east: 18.6, north: 47.9 } as const

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

export type AddressLocale = 'it' | 'en'

/** The six structured components this feature captures (plan.md AddressInput, minus lat/lng). */
export type AddressComponents = {
  countryCode: string
  city: string
  street: string
  houseNumber: string
  postalCode: string
  region: string
}

export type PlaceSuggestion = {
  id: string
  mainText: string
  secondaryText: string
}

export type PlaceDetails = {
  components: AddressComponents
  latitude: number | null
  longitude: number | null
}

export type AutocompleteRequestShape = {
  input: string
  sessionToken: unknown
  includedPrimaryTypes: string[]
  locationBias: typeof CH_IT_LOCATION_BIAS
  language: string
}

// ---------------------------------------------------------------------------
// Pure helpers — the parts that are safe and meaningful to unit-test
// directly, with no SDK involved.
// ---------------------------------------------------------------------------

/**
 * Builds the request object passed to
 * `AutocompleteSuggestion.fetchAutocompleteSuggestions()`.
 *
 * ⚠ Deliberately never adds `includedRegionCodes` — see this module's doc
 * comment and plan.md R3 / ADR-0032. `locationBias` is a preference;
 * `includedRegionCodes` would be a restriction and would break AC-2.4.
 */
export const buildAutocompleteRequest = (
  input: string,
  sessionToken: unknown,
  language: AddressLocale,
): AutocompleteRequestShape => ({
  input,
  sessionToken,
  includedPrimaryTypes: ['address'],
  locationBias: CH_IT_LOCATION_BIAS,
  language,
})

/** Rounds a coordinate to `decimals` places (default 6dp — plan.md "Money/precision note"). */
export const quantizeCoordinate = (value: number, decimals = 6): number => {
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}

const firstLongText = (components: GoogleAddressComponent[], ...types: string[]): string => {
  for (const type of types) {
    const found = components.find((c) => c.types.includes(type))
    if (found?.longText) return found.longText
  }
  return ''
}

const countryShortText = (components: GoogleAddressComponent[]): string => {
  const found = components.find((c) => c.types.includes('country'))
  return (found?.shortText ?? found?.longText ?? '').toUpperCase()
}

/**
 * Maps Google's `addressComponents` onto our six fields (plan.md "Component
 * mapping (AC-2.2)"), including the `locality` → `postal_town` →
 * `administrative_area_level_3` → `administrative_area_level_2` fallback
 * chain for `city` (an IT comune is often `administrative_area_level_3`).
 * `houseNumber` is frequently absent for a route-level prediction (plan.md
 * R9) — left empty here, never invented.
 */
export const mapAddressComponents = (components: GoogleAddressComponent[]): AddressComponents => ({
  countryCode: countryShortText(components),
  city: firstLongText(
    components,
    'locality',
    'postal_town',
    'administrative_area_level_3',
    'administrative_area_level_2',
  ),
  street: firstLongText(components, 'route'),
  houseNumber: firstLongText(components, 'street_number'),
  postalCode: firstLongText(components, 'postal_code'),
  region: firstLongText(components, 'administrative_area_level_1'),
})

// ---------------------------------------------------------------------------
// The lazy SDK loader — real, network-touching code. Idempotent: concurrent
// callers share the same in-flight promise; a failed load is not cached, so
// a later attempt (e.g. after the admin's connection recovers) can retry.
// ---------------------------------------------------------------------------

const BOOTSTRAP_SCRIPT_ID = 'admin-ui-google-maps-bootstrap'

let placesLibraryPromise: Promise<GooglePlacesLibrary> | null = null

const injectBootstrapScript = (apiKey: string): Promise<void> =>
  new Promise((resolve, reject) => {
    if (document.getElementById(BOOTSTRAP_SCRIPT_ID)) {
      resolve()
      return
    }
    const script = document.createElement('script')
    script.id = BOOTSTRAP_SCRIPT_ID
    script.async = true
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&loading=async&libraries=places&v=weekly`
    script.onload = () => resolve()
    script.onerror = () => reject(new Error('Failed to load the Google Maps script.'))
    document.head.appendChild(script)
  })

/**
 * Lazily loads the Places (New) library — called on first focus of the
 * Street field (plan.md "lazy-loaded on first focus"), never at app load.
 * Rejects (never throws synchronously) when the key is missing, the script
 * fails to load, or `importLibrary` never materializes — every caller in
 * this module treats a rejection here as "suggestions unavailable", not a
 * fatal error (AC-3.2).
 */
export const loadPlacesLibrary = (): Promise<GooglePlacesLibrary> => {
  if (placesLibraryPromise) return placesLibraryPromise

  placesLibraryPromise = (async () => {
    const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined
    if (!apiKey) {
      throw new Error('VITE_GOOGLE_MAPS_API_KEY is not set — address suggestions are disabled.')
    }
    if (!window.google?.maps?.importLibrary) {
      await injectBootstrapScript(apiKey)
    }
    if (!window.google?.maps?.importLibrary) {
      throw new Error('Google Maps failed to initialize.')
    }
    return (await window.google.maps.importLibrary('places')) as GooglePlacesLibrary
  })()

  // Do not cache a rejection — a later call (e.g. a subsequent focus) should
  // be free to retry rather than being permanently stuck on one failure.
  placesLibraryPromise.catch(() => {
    placesLibraryPromise = null
  })

  return placesLibraryPromise
}

// ---------------------------------------------------------------------------
// The stateful suggester — debounce + supersession + timeout + session-token
// lifecycle, all in one place so AC-2.1/AC-2.4/AC-2.5/AC-3.2 have a single
// owner. Dependency-injectable (`deps.loadPlacesLibrary`) purely so
// `googlePlaces.test.ts` can drive it with fake timers against a fake
// library instead of the real network/SDK.
// ---------------------------------------------------------------------------

export type AddressSuggesterOptions = {
  /**
   * Called with a GENUINE, completed result list — including an empty array
   * for AC-3.1 ("the request genuinely completes with zero results", design.md).
   * The caller (`AddressSection.tsx`) is expected to show its "no matching
   * suggestions" caption for an empty array here — this is the ONE signal
   * that distinguishes AC-3.1 from AC-3.2, so it must never be reused for a
   * degraded/failed search (see `onDegraded` below).
   */
  onResults: (suggestions: PlaceSuggestion[]) => void
  /** The debounce has elapsed and a request is about to fire — drives the "Searching…" caption (design.md). Optional; a caller that doesn't render a searching indicator may omit it. */
  onSearchStart?: () => void
  /**
   * AC-3.2 — the request errored, timed out (3000ms cap), or was
   * rate-limited. Deliberately a SEPARATE callback from `onResults([])`: the
   * caller must show NOTHING for this case (no caption, no error, no
   * lingering spinner) — conflating it with `onResults([])` would make the
   * silent-degradation state indistinguishable from AC-3.1's "no matching
   * suggestions" caption, which design.md requires to visibly differ.
   */
  onDegraded?: () => void
  /** The query is shorter than MIN_QUERY_LENGTH — no request was ever attempted; visually identical to idle (design.md). */
  onBelowThreshold?: () => void
  language: AddressLocale
}

export type AddressSuggesterDeps = {
  loadPlacesLibrary: () => Promise<GooglePlacesLibrary>
}

const defaultDeps: AddressSuggesterDeps = { loadPlacesLibrary }

export type AddressSuggester = {
  /** Debounced, min-length-gated, supersession-safe search (AC-2.1). */
  search: (rawQuery: string) => void
  /** Resolves a previously-suggested id to full details (AC-2.2/AC-2.5), or `null` on any failure (AC-3.2) — never throws. */
  selectSuggestion: (id: string) => Promise<PlaceDetails | null>
  /** Clears pending state (e.g. the field was cleared by hand) without ending the editing session's token. */
  reset: () => void
  /** Cancels any pending debounce/in-flight work — call on unmount. */
  dispose: () => void
}

export const createAddressSuggester = (
  options: AddressSuggesterOptions,
  deps: AddressSuggesterDeps = defaultDeps,
): AddressSuggester => {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  let sequence = 0
  let sessionToken: unknown = null
  let lastActivityAt = 0
  let predictionsById = new Map<string, GooglePlacePrediction>()
  let currentAbort: AbortController | null = null

  const clearDebounce = () => {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer)
      debounceTimer = null
    }
  }

  const abortInFlight = () => {
    currentAbort?.abort()
    currentAbort = null
  }

  const ensureSessionToken = async (): Promise<{ library: GooglePlacesLibrary; token: unknown }> => {
    const library = await deps.loadPlacesLibrary()
    if (sessionToken === null) {
      sessionToken = new library.AutocompleteSessionToken()
    }
    return { library, token: sessionToken }
  }

  const runSearch = (query: string, mySequence: number) => {
    abortInFlight()
    const abort = new AbortController()
    currentAbort = abort

    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('address suggestion request timed out')), REQUEST_TIMEOUT_MS)
      abort.signal.addEventListener('abort', () => clearTimeout(timer))
    })

    ensureSessionToken()
      .then(({ library, token }) =>
        Promise.race([
          library.AutocompleteSuggestion.fetchAutocompleteSuggestions(
            buildAutocompleteRequest(query, token, options.language),
          ),
          timeoutPromise,
        ]),
      )
      .then((response) => {
        if (mySequence !== sequence || abort.signal.aborted) return // superseded — discard (AC-2.1 in-flight supersession)
        const nextPredictions = new Map<string, GooglePlacePrediction>()
        const suggestions: PlaceSuggestion[] = []
        for (const suggestion of response.suggestions.slice(0, MAX_SUGGESTIONS)) {
          const prediction = suggestion.placePrediction
          if (!prediction) continue
          nextPredictions.set(prediction.placeId, prediction)
          suggestions.push({
            id: prediction.placeId,
            mainText: prediction.mainText?.text ?? prediction.text?.text ?? '',
            secondaryText: prediction.secondaryText?.text ?? '',
          })
        }
        predictionsById = nextPredictions
        options.onResults(suggestions)
      })
      .catch((error: unknown) => {
        if (mySequence !== sequence || abort.signal.aborted) return
        // AC-3.2 — a load failure, a suggest failure, a timeout, or a
        // rate-limit are ALL folded into "degraded". No error is ever
        // surfaced to the caller; this is the one, deliberate silent path —
        // kept OUT of `onResults` so it can never be confused with AC-3.1's
        // genuine, captioned "no matching suggestions" outcome.
        console.warn('[admin-ui] address suggestions unavailable:', error)
        predictionsById = new Map()
        options.onDegraded?.()
      })
  }

  return {
    search(rawQuery: string) {
      const query = rawQuery.trim()
      clearDebounce()
      sequence += 1
      const mySequence = sequence

      if (query.length < MIN_QUERY_LENGTH) {
        abortInFlight()
        predictionsById = new Map()
        options.onBelowThreshold?.()
        return
      }

      const now = Date.now()
      if (sessionToken !== null && now - lastActivityAt > SESSION_IDLE_MS) {
        sessionToken = null // a new editing session begins after a long idle gap
      }
      lastActivityAt = now

      debounceTimer = setTimeout(() => {
        debounceTimer = null
        options.onSearchStart?.()
        runSearch(query, mySequence)
      }, DEBOUNCE_MS)
    },

    async selectSuggestion(id: string): Promise<PlaceDetails | null> {
      const prediction = predictionsById.get(id)
      if (!prediction) return null
      try {
        const place = prediction.toPlace()
        await place.fetchFields({ fields: ['addressComponents', 'location'] })
        const components = mapAddressComponents(place.addressComponents ?? [])
        const latitude = place.location ? quantizeCoordinate(place.location.lat()) : null
        const longitude = place.location ? quantizeCoordinate(place.location.lng()) : null
        // A completed selection terminates the session (correct per-session
        // billing) — the next keystroke starts a fresh one.
        sessionToken = null
        return { components, latitude, longitude }
      } catch (error) {
        console.warn('[admin-ui] address details unavailable:', error)
        sessionToken = null
        return null
      }
    },

    reset() {
      clearDebounce()
      abortInFlight()
      sequence += 1
      predictionsById = new Map()
    },

    dispose() {
      clearDebounce()
      abortInFlight()
    },
  }
}
