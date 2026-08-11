/**
 * @vitest-environment jsdom
 *
 * Unit tests for src/lib/suggestionsApi.ts (T9, specs/014-motivo-autocomplete/
 * tasks.md, AC-5.2).
 *
 * Strategy mirrors `ratesApi.test.ts` / `refundApi.test.ts`: `shell/session`'s
 * `apiFetch` is mocked at module level so the exact URL and `RequestInit` sent
 * are inspectable, and the base URL comes from `VITE_REFUND_API_URL` via
 * `vi.stubEnv` rather than being hardcoded.
 *
 * Note the deliberate shape of the last two cases: this layer THROWS on a
 * non-2xx and on an abort. Swallowing every failure into "no suggestions" is
 * `MotivoSuggestField`'s job alone (AC-5.2, plan.md "### Client contract") —
 * if this module ever starts resolving to `[]` instead, a future non-composer
 * caller would silently inherit a swallow it never asked for.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('shell/session', () => ({
  apiFetch: vi.fn(),
}))

import { apiFetch } from 'shell/session'
import { ApiError } from './refundApi'
import { getTripSuggestions } from './suggestionsApi'
import type { TripSuggestion } from './suggestionsApi'

const REFUND_API_URL = 'http://refund-api.test'

const suggestion: TripSuggestion = {
  motivo: 'Milano → Lugano  cliente ACME',
  normalisedMotivo: 'milano → lugano cliente acme',
  km: 62,
  entity: 'welld_ch',
  count: 14,
  lastUsedOn: '2026-07-28',
}

const makeResponse = (status: number, body: unknown = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

beforeEach(() => {
  vi.stubEnv('VITE_REFUND_API_URL', REFUND_API_URL)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

describe('getTripSuggestions', () => {
  it('GETs /line-suggestions?type=travel_km and unwraps the suggestions array', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(makeResponse(200, { type: 'travel_km', suggestions: [suggestion] }))

    const result = await getTripSuggestions(new AbortController().signal)

    expect(result).toEqual([suggestion])
    const [url] = vi.mocked(apiFetch).mock.calls[0]
    expect(String(url)).toBe(`${REFUND_API_URL}/line-suggestions?type=travel_km`)
  })

  it('sends NO caller-controlled selector beyond type — no q, no userId, no cursor (AC-4.3)', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(makeResponse(200, { type: 'travel_km', suggestions: [] }))

    await getTripSuggestions(new AbortController().signal)

    const [url, init] = vi.mocked(apiFetch).mock.calls[0]
    expect(new URL(String(url)).search).toBe('?type=travel_km')
    expect(init?.method).toBeUndefined()
    expect(init?.body).toBeUndefined()
  })

  it('forwards the AbortSignal all the way to the fetch (plan D2)', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(makeResponse(200, { type: 'travel_km', suggestions: [] }))
    const controller = new AbortController()

    await getTripSuggestions(controller.signal)

    const [, init] = vi.mocked(apiFetch).mock.calls[0]
    expect(init?.signal).toBe(controller.signal)
  })

  it('resolves to an empty array when the caller simply has no past trips', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(makeResponse(200, { type: 'travel_km', suggestions: [] }))

    await expect(getTripSuggestions(new AbortController().signal)).resolves.toEqual([])
  })

  it.each([
    [403, 'Forbidden'],
    [503, 'Service Unavailable'],
    [500, 'Internal Server Error'],
  ])(
    'REJECTS with ApiError on %i — this layer never swallows (the swallow is MotivoSuggestField’s)',
    async (status, title) => {
      vi.mocked(apiFetch).mockResolvedValueOnce(makeResponse(status, { type: 'about:blank', title, status }))

      await expect(getTripSuggestions(new AbortController().signal)).rejects.toBeInstanceOf(ApiError)
    },
  )

  it('propagates a rejection from the transport (network failure / abort) untouched', async () => {
    vi.mocked(apiFetch).mockRejectedValueOnce(new DOMException('The operation was aborted.', 'AbortError'))

    await expect(getTripSuggestions(new AbortController().signal)).rejects.toMatchObject({ name: 'AbortError' })
  })
})
