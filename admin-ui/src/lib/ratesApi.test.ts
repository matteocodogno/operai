/**
 * @vitest-environment jsdom
 *
 * Unit tests for src/lib/ratesApi.ts — typed API client for refund-api's
 * mileage-rate management surface (T10, specs/009-mileage-rate/tasks.md).
 *
 * Strategy mirrors adminApi.test.ts exactly:
 *   • `shell/session`'s `apiFetch` is mocked at the module level so tests
 *     control the raw Response objects and inspect exactly what was sent.
 *   • `getRefundApiBaseUrl` is mocked too, proving the base URL comes from
 *     the SHELL (T9) — never admin-ui's own `import.meta.env` (a remote ships
 *     no `VITE_REFUND_API_URL` of its own; plan.md's explicit call-path
 *     decision + Risk R8(b)).
 *   • Every operation is checked for: (a) correct HTTP method + URL built
 *     against the shell-provided base, (b) correct JSON request body (where
 *     applicable), (c) a successful response parsed to the typed shape, (d) a
 *     non-2xx response mapped to `ApiError` with the right status/detail.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Module mock — apiFetch + getRefundApiBaseUrl are replaced with vi.fn()s for
// all tests. `shell/session` is a federated module (bare specifier, only
// resolvable at runtime via @module-federation/vite); vitest.config.ts
// aliases it to a local stub purely to satisfy Vite's import-analysis, and
// this vi.mock overrides that with a full test double — same pattern as
// adminApi.test.ts.
// ---------------------------------------------------------------------------

vi.mock('shell/session', () => ({
  apiFetch: vi.fn(),
  getRefundApiBaseUrl: vi.fn(),
}))

import { apiFetch, getRefundApiBaseUrl } from 'shell/session'
import { ApiError, addRate, listRates } from './ratesApi'
import type { AddRateInput, ApiProblem, RateEntry, RatesResult } from './ratesApi'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REFUND_API_URL = 'http://refund-api.test'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const fixedEntry: RateEntry = {
  id: 'clr_abc',
  ratePerKmMicros: 700000,
  ratePerKm: '0.70',
  validFrom: '2026-01-01',
  createdAt: '2026-07-20T09:12:00.000Z',
  createdByEmail: 'admin@welld.ch',
  inEffectToday: true,
}

const fixedRatesResult: RatesResult = {
  entities: [
    { entity: 'welld_ch', currency: 'CHF', currentEntryId: fixedEntry.id, entries: [fixedEntry] },
    { entity: 'welld_it', currency: 'EUR', currentEntryId: null, entries: [] },
  ],
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeResponse = (status: number, body: unknown = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

const okResponse = (body: unknown): Response => makeResponse(200, body)

const problemResponse = (status: number, title: string, detail?: string, instance?: string): Response =>
  makeResponse(status, {
    type: `https://httpstatuses.com/${status}`,
    title,
    status,
    detail,
    instance,
  } satisfies ApiProblem)

const lastCall = (): { url: string; init: RequestInit | undefined } => {
  const mockFn = vi.mocked(apiFetch)
  const calls = mockFn.mock.calls
  expect(calls.length).toBeGreaterThan(0)
  const [input, init] = calls[calls.length - 1]
  return { url: String(input), init }
}

const expectApiError = async (fn: () => Promise<unknown>, status: number): Promise<ApiError> => {
  let thrown: unknown
  try {
    await fn()
  } catch (err) {
    thrown = err
  }
  expect(thrown).toBeInstanceOf(ApiError)
  expect((thrown as ApiError).status).toBe(status)
  return thrown as ApiError
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.mocked(getRefundApiBaseUrl).mockReturnValue(REFUND_API_URL)
})

afterEach(() => {
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// Base URL wiring (T9/T10 — the shell, not admin-ui's own env)
// ---------------------------------------------------------------------------

describe('base URL wiring', () => {
  it('listRates() builds its request URL from getRefundApiBaseUrl(), not import.meta.env', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(okResponse(fixedRatesResult))

    await listRates()

    expect(getRefundApiBaseUrl).toHaveBeenCalled()
    const { url } = lastCall()
    expect(url).toBe(`${REFUND_API_URL}/rates`)
  })

  it('every call goes through the shared shell/session apiFetch (Bearer + trusted-origin machinery)', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(okResponse(fixedRatesResult))

    await listRates()

    expect(apiFetch).toHaveBeenCalledOnce()
  })
})

// ---------------------------------------------------------------------------
// listRates()
// ---------------------------------------------------------------------------

describe('listRates()', () => {
  it('issues GET /rates and returns the per-entity history (AC-4.1/4.3, also AC-5.3)', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(okResponse(fixedRatesResult))

    const result = await listRates()

    const { url, init } = lastCall()
    expect(url).toBe(`${REFUND_API_URL}/rates`)
    expect(init?.method).toBeUndefined()
    expect(init?.body).toBeUndefined()
    expect(result).toEqual(fixedRatesResult)
  })

  it('throws ApiError on 403 (missing rate:read, AC-4.6)', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(problemResponse(403, 'Forbidden', 'Missing capability: rate:read'))

    const err = await expectApiError(() => listRates(), 403)
    expect(err.detail).toBe('Missing capability: rate:read')
  })

  it('throws ApiError on 401 (no session)', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(problemResponse(401, 'Unauthorized'))
    await expectApiError(() => listRates(), 401)
  })
})

// ---------------------------------------------------------------------------
// addRate()
// ---------------------------------------------------------------------------

describe('addRate()', () => {
  const input: AddRateInput = { entity: 'welld_ch', ratePerKm: '0.72', validFrom: '2026-08-01' }

  it('issues POST /rates with the body and returns the created entry on 201 (AC-4.2)', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(makeResponse(201, fixedEntry))

    const result = await addRate(input)

    const { url, init } = lastCall()
    expect(url).toBe(`${REFUND_API_URL}/rates`)
    expect(init?.method).toBe('POST')
    expect(init?.headers).toMatchObject({ 'Content-Type': 'application/json' })
    expect(JSON.parse(init?.body as string)).toEqual(input)
    expect(result).toEqual(fixedEntry)
  })

  it('throws ApiError on 422 with a field-identifying detail (non-positive rate, AC-4.5)', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(
      problemResponse(422, 'Unprocessable Entity', 'ratePerKm must be greater than 0'),
    )

    const err = await expectApiError(() => addRate({ ...input, ratePerKm: '0' }), 422)
    expect(err.detail).toBe('ratePerKm must be greater than 0')
  })

  it('throws ApiError on 422 for a missing/invalid validFrom (AC-4.5)', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(
      problemResponse(422, 'Unprocessable Entity', 'validFrom must be a valid date'),
    )

    const err = await expectApiError(() => addRate({ ...input, validFrom: 'not-a-date' }), 422)
    expect(err.detail).toBe('validFrom must be a valid date')
  })

  it('throws ApiError on 403 (missing rate:manage, AC-4.6)', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(problemResponse(403, 'Forbidden', 'Missing capability: rate:manage'))
    await expectApiError(() => addRate(input), 403)
  })

  it('throws ApiError on 401 (no session)', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(problemResponse(401, 'Unauthorized'))
    await expectApiError(() => addRate(input), 401)
  })

  it('a non-Problem-JSON error body still produces an ApiError from the raw status', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(
      new Response('Internal Server Error', { status: 500, statusText: 'Internal Server Error' }),
    )

    const err = await expectApiError(() => addRate(input), 500)
    expect(err.title).toBe('Internal Server Error')
  })
})
