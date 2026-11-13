/**
 * @vitest-environment jsdom
 *
 * Unit tests for src/lib/timeListsApi.ts — the typed client for hours-api's time lists: the
 * categories and the two work-type lists an admin manages (T31, specs/029-time-tracking/tasks.md,
 * refs AC-3.3, AC-5.5; plan.md § Lists).
 *
 * hours-api's list routes are not built yet (T12), so everything here runs against a faked
 * `apiFetch`, the same technique as ratesApi.test.ts:
 *   • `shell/session`'s `apiFetch` and `getHoursApiBaseUrl` are replaced at the module level, so
 *     the tests control the raw Response and inspect exactly what was sent;
 *   • the base URL must come from the SHELL — a remote ships no `VITE_HOURS_API_URL` of its own
 *     (ADR-0023's call-path, ADR-0090);
 *   • the contract asserted is the one in plan.md § Lists, not the one that is convenient.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('shell/session', () => ({
  apiFetch: vi.fn(),
  getHoursApiBaseUrl: vi.fn(),
}))

import { apiFetch, getHoursApiBaseUrl } from 'shell/session'
import { ApiError, createCategory, createWorkType, listTimeLists, updateCategory, updateWorkType } from './timeListsApi'
import type { TimeCategory, TimeLists, WorkType } from './timeListsApi'

const HOURS_API_URL = 'http://hours-api.test'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const training: TimeCategory = { id: 'tc-training', name: 'Training', requiresNote: false, retired: false }
const other: TimeCategory = { id: 'tc-other', name: 'Other', requiresNote: true, retired: false }
const seminars: TimeCategory = { id: 'tc-seminars', name: 'Seminars', requiresNote: false, retired: true }
const analysis: WorkType = { id: 'wt-project-analysis', list: 'project', name: 'Analysis', retired: false }
const demo: WorkType = { id: 'wt-deal-demo', list: 'deal', name: 'Demo', retired: true }

const lists: TimeLists = {
  categories: [training, other, seminars],
  workTypes: { project: [analysis], deal: [demo] },
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const jsonResponse = (status: number, body: unknown = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const problemResponse = (status: number, code: string | undefined, title: string, detail?: string): Response =>
  jsonResponse(status, {
    type: `https://httpstatuses.com/${status}`,
    title,
    status,
    ...(detail !== undefined ? { detail } : {}),
    ...(code !== undefined ? { code } : {}),
  })

const lastCall = (): { url: string; init: RequestInit | undefined } => {
  const calls = vi.mocked(apiFetch).mock.calls
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
  vi.mocked(getHoursApiBaseUrl).mockReturnValue(HOURS_API_URL)
})

afterEach(() => {
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// Base URL wiring
// ---------------------------------------------------------------------------

describe('base URL wiring', () => {
  it('builds every request URL from getHoursApiBaseUrl(), never from admin-ui’s own env', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonResponse(200, lists))

    await listTimeLists()

    expect(getHoursApiBaseUrl).toHaveBeenCalled()
    expect(lastCall().url.startsWith(`${HOURS_API_URL}/`)).toBe(true)
  })

  it('goes through the shared shell/session apiFetch, one call per operation', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(jsonResponse(200, lists))

    await listTimeLists()

    expect(apiFetch).toHaveBeenCalledOnce()
  })
})

// ---------------------------------------------------------------------------
// GET /time-lists
// ---------------------------------------------------------------------------

describe('listTimeLists()', () => {
  it('issues GET /time-lists?includeRetired=true: the page needs the retired rows to restore them', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(jsonResponse(200, lists))

    const result = await listTimeLists()

    const { url, init } = lastCall()
    expect(url).toBe(`${HOURS_API_URL}/time-lists?includeRetired=true`)
    expect(init?.method).toBeUndefined()
    expect(init?.body).toBeUndefined()
    expect(result).toEqual(lists)
  })

  it('maps a Problem JSON answer to an ApiError carrying status, code and detail', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(
      problemResponse(503, 'authz_unavailable', 'Service Unavailable', 'auth did not answer'),
    )

    const err = await expectApiError(() => listTimeLists(), 503)
    expect(err.code).toBe('authz_unavailable')
    expect(err.title).toBe('Service Unavailable')
    expect(err.detail).toBe('auth did not answer')
  })

  it('an answer that is not Problem JSON still becomes an ApiError from the raw status, with no code', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(
      new Response('<html>Bad gateway</html>', { status: 502, statusText: 'Bad Gateway' }),
    )

    const err = await expectApiError(() => listTimeLists(), 502)
    expect(err.title).toBe('Bad Gateway')
    expect(err.code).toBeUndefined()
  })

  it('a 200 whose body is not the lists shape is an error, not a half-empty page', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(jsonResponse(200, { categories: [] }))

    await expect(listTimeLists()).rejects.toBeInstanceOf(ApiError)
  })

  it('a network failure is not swallowed: apiFetch’s rejection reaches the caller as it is', async () => {
    const failure = new TypeError('Failed to fetch')
    vi.mocked(apiFetch).mockRejectedValueOnce(failure)

    await expect(listTimeLists()).rejects.toBe(failure)
  })
})

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

describe('createCategory()', () => {
  it('issues POST /time-categories with the name and requiresNote and returns the 201 view', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(jsonResponse(201, other))

    const result = await createCategory({ name: 'Other', requiresNote: true })

    const { url, init } = lastCall()
    expect(url).toBe(`${HOURS_API_URL}/time-categories`)
    expect(init?.method).toBe('POST')
    expect(init?.headers).toMatchObject({ 'Content-Type': 'application/json' })
    expect(JSON.parse(init?.body as string)).toEqual({ name: 'Other', requiresNote: true })
    expect(result).toEqual(other)
  })

  it('sends only the members it was given (requiresNote is optional on the wire)', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(jsonResponse(201, training))

    await createCategory({ name: 'Training' })

    expect(JSON.parse(lastCall().init?.body as string)).toEqual({ name: 'Training' })
  })

  it('409 name_taken reaches the caller as an ApiError with its code', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(problemResponse(409, 'name_taken', 'Conflict'))

    const err = await expectApiError(() => createCategory({ name: 'training' }), 409)
    expect(err.code).toBe('name_taken')
  })
})

describe('updateCategory()', () => {
  it('issues PATCH /time-categories/{id} with exactly the changed members', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(jsonResponse(200, { ...training, retired: true }))

    const result = await updateCategory('tc-training', { retired: true })

    const { url, init } = lastCall()
    expect(url).toBe(`${HOURS_API_URL}/time-categories/tc-training`)
    expect(init?.method).toBe('PATCH')
    expect(JSON.parse(init?.body as string)).toEqual({ retired: true })
    expect(result).toEqual({ ...training, retired: true })
  })

  it('a rename carries the name and requiresNote together when both change', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(jsonResponse(200, training))

    await updateCategory('tc-training', { name: 'Courses', requiresNote: true })

    expect(JSON.parse(lastCall().init?.body as string)).toEqual({ name: 'Courses', requiresNote: true })
  })

  it('restoring is the same PATCH with retired: false (AC-3.1 as amended)', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(jsonResponse(200, { ...seminars, retired: false }))

    await updateCategory('tc-seminars', { retired: false })

    expect(JSON.parse(lastCall().init?.body as string)).toEqual({ retired: false })
  })

  it('percent-encodes the id, so an id cannot change the path it is sent to', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(jsonResponse(200, training))

    await updateCategory('a/../b?x=1', { retired: true })

    expect(lastCall().url).toBe(`${HOURS_API_URL}/time-categories/a%2F..%2Fb%3Fx%3D1`)
  })

  it.each([
    [403, 'time_list_manage_required'],
    [503, 'authz_unavailable'],
    [404, 'not_found'],
    [409, 'name_taken'],
  ])('maps %i %s to an ApiError with status and code', async (status, code) => {
    vi.mocked(apiFetch).mockResolvedValueOnce(problemResponse(status, code, 'Problem'))

    const err = await expectApiError(() => updateCategory('tc-training', { retired: true }), status)
    expect(err.code).toBe(code)
  })
})

// ---------------------------------------------------------------------------
// Work types
// ---------------------------------------------------------------------------

describe('createWorkType()', () => {
  it('issues POST /work-types with the list and the name and returns the 201 view', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(jsonResponse(201, demo))

    const result = await createWorkType({ list: 'deal', name: 'Demo' })

    const { url, init } = lastCall()
    expect(url).toBe(`${HOURS_API_URL}/work-types`)
    expect(init?.method).toBe('POST')
    expect(JSON.parse(init?.body as string)).toEqual({ list: 'deal', name: 'Demo' })
    expect(result).toEqual(demo)
  })
})

describe('updateWorkType()', () => {
  it('issues PATCH /work-types/{id} with exactly the changed members', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(jsonResponse(200, { ...analysis, retired: true }))

    const result = await updateWorkType('wt-project-analysis', { retired: true })

    const { url, init } = lastCall()
    expect(url).toBe(`${HOURS_API_URL}/work-types/wt-project-analysis`)
    expect(init?.method).toBe('PATCH')
    expect(JSON.parse(init?.body as string)).toEqual({ retired: true })
    expect(result).toEqual({ ...analysis, retired: true })
  })

  it('a rename sends only the name', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(jsonResponse(200, analysis))

    await updateWorkType('wt-project-analysis', { name: 'Study' })

    expect(JSON.parse(lastCall().init?.body as string)).toEqual({ name: 'Study' })
  })

  it('maps 403 time_list_manage_required to an ApiError with status and code', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(problemResponse(403, 'time_list_manage_required', 'Forbidden'))

    const err = await expectApiError(() => updateWorkType('wt-project-analysis', { retired: true }), 403)
    expect(err.code).toBe('time_list_manage_required')
  })
})

describe('no Delete (AC-3.2)', () => {
  it('the client has no delete operation: no route exists to call', async () => {
    const api = await import('./timeListsApi')

    expect(Object.keys(api).filter((name) => /delete|remove/i.test(name))).toEqual([])
  })
})
