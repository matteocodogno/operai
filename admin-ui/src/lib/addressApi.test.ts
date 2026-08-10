/**
 * Unit tests for src/lib/addressApi.ts — typed API client for `auth`'s
 * employee-address surface (T9, specs/012-employee-address/tasks.md, refs
 * AC-1.1, AC-1.2, AC-1.3, AC-5.3).
 *
 * Strategy mirrors ratesApi.test.ts exactly: `shell/session`'s `apiFetch` is
 * mocked at the module level, `getAuthBaseUrl` proves the base URL comes
 * from the SHELL (never admin-ui's own `import.meta.env`), and every
 * operation is checked for method/URL/body on success and `ApiError`
 * mapping (including the `422 address_incomplete` shape's `missingFields`)
 * on failure.
 *
 * The real `auth` counterpart (T3, T5) is being built in parallel by another
 * agent — every request/response fixture here is taken verbatim from
 * plan.md's documented contract, not from a live implementation.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('shell/session', () => ({
  apiFetch: vi.fn(),
  getAuthBaseUrl: vi.fn(),
}))

import { apiFetch, getAuthBaseUrl } from 'shell/session'
import { ApiError, getAddress, listAddressHistory, putAddress } from './addressApi'
import type { AddressInput, AdminAddressResponse, AddressHistoryEntry, ApiProblem, Paginated } from './addressApi'

const AUTH_URL = 'http://auth.test'
const USER_ID = 'usr_abc123'

const makeResponse = (status: number, body: unknown = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const okResponse = (body: unknown): Response => makeResponse(200, body)

const problemResponse = (status: number, title: string, extra: Partial<ApiProblem> = {}): Response =>
  makeResponse(status, {
    type: `https://httpstatuses.com/${status}`,
    title,
    status,
    ...extra,
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

beforeEach(() => {
  vi.mocked(getAuthBaseUrl).mockReturnValue(AUTH_URL)
})

afterEach(() => {
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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

const validInput: AddressInput = {
  countryCode: 'CH',
  city: 'Zürich',
  street: 'Bahnhofstrasse',
  houseNumber: '12b',
  postalCode: '8001',
  region: 'Zürich',
  latitude: 47.3702,
  longitude: 8.5397,
}

// ---------------------------------------------------------------------------
// Base URL wiring
// ---------------------------------------------------------------------------

describe('base URL wiring', () => {
  it("builds its request URL from getAuthBaseUrl(), never admin-ui's own import.meta.env", async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(okResponse(noAddress))

    await getAddress(USER_ID)

    expect(getAuthBaseUrl).toHaveBeenCalled()
    const { url } = lastCall()
    expect(url).toBe(`${AUTH_URL}/admin/users/${USER_ID}/address`)
  })

  it('every call goes through the shared shell/session apiFetch (Bearer + trusted-origin machinery)', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(okResponse(noAddress))
    await getAddress(USER_ID)
    expect(apiFetch).toHaveBeenCalledOnce()
  })
})

// ---------------------------------------------------------------------------
// getAddress()
// ---------------------------------------------------------------------------

describe('getAddress()', () => {
  it('returns { address: null } for an untouched user (AC-1.1 "no address on file")', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(okResponse(noAddress))

    const result = await getAddress(USER_ID)

    const { url, init } = lastCall()
    expect(url).toBe(`${AUTH_URL}/admin/users/${USER_ID}/address`)
    expect(init?.method).toBeUndefined()
    expect(result).toEqual(noAddress)
  })

  it('returns the populated AdminAddressView, including formatted + updatedByUserId (AC-1.1)', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(okResponse(swissAddress))

    const result = await getAddress(USER_ID)

    expect(result).toEqual(swissAddress)
    expect(result.address?.formatted).toBe('Bahnhofstrasse 12b, 8001 Zürich, Zürich, Switzerland')
  })

  it('throws ApiError on 403 (not an admin — AC-4.1)', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(problemResponse(403, 'Forbidden'))
    await expectApiError(() => getAddress(USER_ID), 403)
  })

  it('throws ApiError on 404 (unknown or soft-deleted user)', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(problemResponse(404, 'Not Found'))
    await expectApiError(() => getAddress(USER_ID), 404)
  })

  it('throws ApiError on 401 (no session)', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(problemResponse(401, 'Unauthorized'))
    await expectApiError(() => getAddress(USER_ID), 401)
  })
})

// ---------------------------------------------------------------------------
// putAddress()
// ---------------------------------------------------------------------------

describe('putAddress()', () => {
  it('issues PUT with { address: <input> } and returns the updated view on 200 (AC-1.2)', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(okResponse(swissAddress))

    const result = await putAddress(USER_ID, validInput)

    const { url, init } = lastCall()
    expect(url).toBe(`${AUTH_URL}/admin/users/${USER_ID}/address`)
    expect(init?.method).toBe('PUT')
    expect(init?.headers).toMatchObject({ 'Content-Type': 'application/json' })
    expect(JSON.parse(init?.body as string)).toEqual({ address: validInput })
    expect(result).toEqual(swissAddress)
  })

  it('an intentional clear sends { address: null }, distinct from omitting the field (AC-1.3)', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(okResponse(noAddress))

    const result = await putAddress(USER_ID, null)

    const { init } = lastCall()
    const body = JSON.parse(init?.body as string) as { address: unknown }
    expect(body).toEqual({ address: null })
    expect('address' in body).toBe(true) // explicit null, never an absent key
    expect(result).toEqual(noAddress)
  })

  it('surfaces the 422 address_incomplete shape with code + missingFields (AC-1.4)', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(
      problemResponse(422, 'Unprocessable Entity', {
        detail: 'Address is incomplete: city, houseNumber are required.',
        code: 'address_incomplete',
        missingFields: ['city', 'houseNumber'],
      }),
    )

    const err = await expectApiError(() => putAddress(USER_ID, { ...validInput, city: '', houseNumber: '' }), 422)
    expect(err.code).toBe('address_incomplete')
    expect(err.missingFields).toEqual(['city', 'houseNumber'])
    expect(err.detail).toBe('Address is incomplete: city, houseNumber are required.')
  })

  it("throws ApiError on 403 (not an admin — including against the caller's own id, AC-4.1)", async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(problemResponse(403, 'Forbidden'))
    await expectApiError(() => putAddress(USER_ID, validInput), 403)
  })

  it('throws ApiError on 404 (unknown or soft-deleted user)', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(problemResponse(404, 'Not Found'))
    await expectApiError(() => putAddress(USER_ID, validInput), 404)
  })

  it('throws ApiError on 401 (no session)', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(problemResponse(401, 'Unauthorized'))
    await expectApiError(() => putAddress(USER_ID, validInput), 401)
  })

  it('a transport failure (network error) propagates rather than being swallowed', async () => {
    vi.mocked(apiFetch).mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await expect(putAddress(USER_ID, validInput)).rejects.toBeInstanceOf(TypeError)
  })

  it('a non-Problem-JSON error body still produces an ApiError from the raw status', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(
      new Response('Internal Server Error', { status: 500, statusText: 'Internal Server Error' }),
    )
    const err = await expectApiError(() => putAddress(USER_ID, validInput), 500)
    expect(err.title).toBe('Internal Server Error')
  })
})

// ---------------------------------------------------------------------------
// listAddressHistory() — AC-5.3
// ---------------------------------------------------------------------------

describe('listAddressHistory()', () => {
  const historyEntry: AddressHistoryEntry = {
    id: 'aud_1',
    actorUserId: 'usr_admin',
    action: 'user.address.set',
    targetType: 'user',
    targetId: USER_ID,
    summary: 'Updated address for jane@welld.ch',
    data: { before: null, after: swissAddress.address },
    createdAt: '2026-08-03T09:12:44.123Z',
  }
  const page: Paginated<AddressHistoryEntry> = { items: [historyEntry], page: 1, pageSize: 20, total: 1 }

  it('filters GET /admin/audit by targetType=user&targetId&action=user.address.set (AC-5.3)', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(okResponse(page))

    const result = await listAddressHistory(USER_ID)

    const { url } = lastCall()
    const parsed = new URL(url)
    expect(parsed.pathname).toBe('/admin/audit')
    expect(parsed.searchParams.get('targetType')).toBe('user')
    expect(parsed.searchParams.get('targetId')).toBe(USER_ID)
    expect(parsed.searchParams.get('action')).toBe('user.address.set')
    expect(result).toEqual(page)
  })

  it('forwards page/pageSize when provided', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(okResponse(page))
    await listAddressHistory(USER_ID, { page: 2, pageSize: 10 })
    const { url } = lastCall()
    const parsed = new URL(url)
    expect(parsed.searchParams.get('page')).toBe('2')
    expect(parsed.searchParams.get('pageSize')).toBe('10')
  })

  it('throws ApiError on 403 (not an admin)', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(problemResponse(403, 'Forbidden'))
    await expectApiError(() => listAddressHistory(USER_ID), 403)
  })

  it('throws ApiError on 401 (no session)', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(problemResponse(401, 'Unauthorized'))
    await expectApiError(() => listAddressHistory(USER_ID), 401)
  })
})
