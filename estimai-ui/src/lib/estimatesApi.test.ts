/**
 * @vitest-environment jsdom
 *
 * Unit tests for src/lib/estimatesApi.ts — typed API client for /estimates.
 *
 * Strategy:
 *   • `apiFetch` is mocked at the module level so tests control the raw
 *     Response objects. This lets each test verify the exact method, URL, and
 *     body that estimatesApi sends — a wrong method or path will cause the
 *     mock to return an unexpected response and the assertion will fail.
 *   • Every operation is tested for:
 *       (a) correct HTTP method + URL (non-vacuous: changing them breaks tests)
 *       (b) correct JSON request body (where applicable)
 *       (c) successful response parsed to the typed shape
 *       (d) non-2xx response thrown as ApiError with the correct status/title
 *   • The 413 / Problem-error path is tested explicitly (AC-1.4 caller side).
 *   • No hardcoded API URL: the base URL comes from VITE_API_URL via vi.stubEnv.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ApiError,
  create,
  get,
  importEstimates,
  list,
  remove,
  update,
} from './estimatesApi'
import type {
  EstimateContent,
  EstimateFull,
  EstimateImportItem,
  EstimateListItem,
  EstimateUpsert,
} from './estimatesApi'

// ---------------------------------------------------------------------------
// Module mock — apiFetch is replaced with a vi.fn() for all tests.
// vi.mock is hoisted by the vitest transformer so it runs before imports.
// ---------------------------------------------------------------------------

vi.mock('./api', () => ({
  apiFetch: vi.fn(),
}))

import { apiFetch } from './api'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const API_URL = 'http://api.test'
const ESTIMATES_URL = `${API_URL}/estimates`

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const fixedContent: EstimateContent = {
  params: {
    parallelism: 0.7,
    sprintDays: 10,
    workingDaysMonth: 20,
    qaDeployDays: 0,
    qaTestDays: 0,
    pmDays: 0,
    aiCostCoef: 10,
    aiGain: 0.3,
  },
  releases: [{ id: 'r1', name: 'v1.0', fte: 2 }],
  acts: [
    {
      id: 'a1',
      num: '1',
      epic: 'Auth',
      act: 'Login page',
      prof: 'Frontend Dev',
      o: 1,
      ml: 2,
      p: 4,
      risk: 0.1,
      notes: '',
      release: 'r1',
    },
  ],
}

const fixedUpsert: EstimateUpsert = {
  name: 'My Estimate',
  author: 'Consultant',
  content: fixedContent,
}

const fixedFull: EstimateFull = {
  id: 'est-001',
  name: 'My Estimate',
  author: 'Consultant',
  content: fixedContent,
  createdAt: '2026-07-03T10:00:00.000Z',
  updatedAt: '2026-07-03T10:00:00.000Z',
}

const fixedListItem: EstimateListItem = {
  id: 'est-001',
  name: 'My Estimate',
  author: 'Consultant',
  updatedAt: '2026-07-03T10:00:00.000Z',
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

const problemResponse = (status: number, title: string, detail?: string): Response =>
  makeResponse(status, {
    type: `https://httpstatuses.com/${status}`,
    title,
    status,
    detail,
    instance: '/estimates',
  })

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.stubEnv('VITE_API_URL', API_URL)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// Helper: capture the most recent apiFetch call
// ---------------------------------------------------------------------------

const lastCall = (): { url: string; init: RequestInit | undefined } => {
  const mockFn = vi.mocked(apiFetch)
  const calls = mockFn.mock.calls
  expect(calls.length).toBeGreaterThan(0)
  const [input, init] = calls[calls.length - 1]
  return { url: String(input), init }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('create(body)', () => {
  it('issues POST to /estimates with JSON body and returns EstimateFull on 201', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(makeResponse(201, fixedFull))

    const result = await create(fixedUpsert)

    const { url, init } = lastCall()
    expect(url).toBe(ESTIMATES_URL)
    expect(init?.method).toBe('POST')
    expect(JSON.parse(init?.body as string)).toEqual(fixedUpsert)
    expect(result).toEqual(fixedFull)
  })

  it('throws ApiError with status 413 when content is too large', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(
      problemResponse(413, 'Payload Too Large', 'Estimate content is 2.3 MB; the maximum is 1.0 MB. Nothing was saved.'),
    )

    await expect(create(fixedUpsert)).rejects.toThrow(ApiError)

    try {
      await create(fixedUpsert)
    } catch (err) {
      if (err instanceof ApiError) {
        expect(err.status).toBe(413)
        expect(err.title).toBe('Payload Too Large')
        expect(err.detail).toContain('Nothing was saved')
      }
    }
  })

  it('throws ApiError with status 400 for a validation Problem response', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(
      problemResponse(400, 'Bad Request', 'name is required'),
    )

    let thrown: unknown
    try {
      await create(fixedUpsert)
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(ApiError)
    expect((thrown as ApiError).status).toBe(400)
  })

  it('sends POST — a GET to /estimates would not match this assertion', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(makeResponse(201, fixedFull))
    await create(fixedUpsert)
    // Non-vacuous: this assertion fails if method is changed to GET.
    expect(lastCall().init?.method).toBe('POST')
    expect(lastCall().url).toBe(ESTIMATES_URL)
  })
})

describe('list()', () => {
  it('issues GET to /estimates (no body) and returns EstimateListItem[]', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(okResponse([fixedListItem]))

    const result = await list()

    const { url, init } = lastCall()
    expect(url).toBe(ESTIMATES_URL)
    // list() must NOT send a body or override the method to POST.
    expect(init?.method).toBeUndefined()
    expect(init?.body).toBeUndefined()
    expect(result).toEqual([fixedListItem])
  })

  it('returns an empty array when the API returns [] (AC-2.3)', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(okResponse([]))

    const result = await list()

    expect(result).toEqual([])
  })

  it('throws ApiError on 401', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(
      problemResponse(401, 'Unauthorized'),
    )

    let thrown: unknown
    try {
      await list()
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(ApiError)
    expect((thrown as ApiError).status).toBe(401)
  })
})

describe('get(id)', () => {
  it('issues GET to /estimates/:id and returns EstimateFull', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(okResponse(fixedFull))

    const result = await get('est-001')

    const { url, init } = lastCall()
    expect(url).toBe(`${ESTIMATES_URL}/est-001`)
    expect(init?.method).toBeUndefined()
    expect(result).toEqual(fixedFull)
  })

  it('throws ApiError with status 404 when the estimate is not found or not owned', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(
      problemResponse(404, 'Not Found', 'Estimate not found'),
    )

    let thrown: unknown
    try {
      await get('nonexistent-id')
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(ApiError)
    expect((thrown as ApiError).status).toBe(404)
  })

  it('appends the id to the URL — a wrong path would fail the URL assertion', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(okResponse(fixedFull))
    await get('abc-123')
    // Non-vacuous: removing /abc-123 from the URL breaks this test.
    expect(lastCall().url).toBe(`${ESTIMATES_URL}/abc-123`)
  })
})

describe('update(id, body)', () => {
  it('issues PUT to /estimates/:id with JSON body and returns updated EstimateFull', async () => {
    const updatedFull: EstimateFull = { ...fixedFull, name: 'Updated Estimate', updatedAt: '2026-07-03T11:00:00.000Z' }
    const upsertBody: EstimateUpsert = { ...fixedUpsert, name: 'Updated Estimate' }
    vi.mocked(apiFetch).mockResolvedValueOnce(okResponse(updatedFull))

    const result = await update('est-001', upsertBody)

    const { url, init } = lastCall()
    expect(url).toBe(`${ESTIMATES_URL}/est-001`)
    expect(init?.method).toBe('PUT')
    expect(JSON.parse(init?.body as string)).toEqual(upsertBody)
    expect(result).toEqual(updatedFull)
  })

  it('throws ApiError with status 413 when the updated content is too large (AC-1.4)', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(
      problemResponse(413, 'Payload Too Large', 'Estimate content is 2.3 MB; the maximum is 1.0 MB. Nothing was saved.'),
    )

    let thrown: unknown
    try {
      await update('est-001', fixedUpsert)
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(ApiError)
    expect((thrown as ApiError).status).toBe(413)
    expect((thrown as ApiError).detail).toContain('Nothing was saved')
  })

  it('sends PUT — a POST would not match this assertion', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(okResponse(fixedFull))
    await update('est-001', fixedUpsert)
    // Non-vacuous: changing method to POST breaks this test.
    expect(lastCall().init?.method).toBe('PUT')
  })
})

describe('remove(id)', () => {
  it('issues DELETE to /estimates/:id and resolves void on 204', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(new Response(null, { status: 204 }))

    const result = await remove('est-001')

    const { url, init } = lastCall()
    expect(url).toBe(`${ESTIMATES_URL}/est-001`)
    expect(init?.method).toBe('DELETE')
    expect(result).toBeUndefined()
  })

  it('throws ApiError with status 404 when estimate is not found or not owned', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(
      problemResponse(404, 'Not Found'),
    )

    let thrown: unknown
    try {
      await remove('nonexistent-id')
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(ApiError)
    expect((thrown as ApiError).status).toBe(404)
  })

  it('sends DELETE — a GET would not match this assertion', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(new Response(null, { status: 204 }))
    await remove('est-001')
    // Non-vacuous: changing method to GET breaks this test.
    expect(lastCall().init?.method).toBe('DELETE')
  })
})

describe('importEstimates(estimates)', () => {
  const importItems: EstimateImportItem[] = [
    { localId: 'local-1', ...fixedUpsert },
    { localId: 'local-2', name: 'Another', author: 'Dev', content: fixedContent },
  ]

  const importResponse = {
    results: [
      { localId: 'local-1', status: 'imported' as const, id: 'est-001' },
      { localId: 'local-2', status: 'imported' as const, id: 'est-002' },
    ],
  }

  it('issues POST to /estimates/import with { estimates: [...] } body', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(okResponse(importResponse))

    const result = await importEstimates(importItems)

    const { url, init } = lastCall()
    expect(url).toBe(`${ESTIMATES_URL}/import`)
    expect(init?.method).toBe('POST')
    expect(JSON.parse(init?.body as string)).toEqual({ estimates: importItems })
    expect(result).toEqual(importResponse)
  })

  it('returns partial-failure results when some elements fail (AC-5.4)', async () => {
    const partialResponse = {
      results: [
        { localId: 'local-1', status: 'imported' as const, id: 'est-001' },
        { localId: 'local-2', status: 'failed' as const, error: 'Payload Too Large' },
      ],
    }
    vi.mocked(apiFetch).mockResolvedValueOnce(okResponse(partialResponse))

    const result = await importEstimates(importItems)

    expect(result.results).toHaveLength(2)
    expect(result.results[0].status).toBe('imported')
    expect(result.results[1].status).toBe('failed')
    expect(result.results[1].error).toBe('Payload Too Large')
    // No ApiError is thrown — partial failure is surfaced in results, not as an exception.
  })

  it('wraps estimates in { estimates: [...] } — a bare array body would break this', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(okResponse(importResponse))
    await importEstimates(importItems)
    // Non-vacuous: sending a bare array instead of { estimates: [...] } breaks this.
    const body = JSON.parse(lastCall().init?.body as string) as unknown
    expect(body).toHaveProperty('estimates')
    expect((body as { estimates: unknown }).estimates).toEqual(importItems)
  })

  it('posts to /estimates/import — a different path would fail the URL assertion', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(okResponse(importResponse))
    await importEstimates(importItems)
    // Non-vacuous: posting to /estimates or /import would break this.
    expect(lastCall().url).toBe(`${ESTIMATES_URL}/import`)
  })

  it('throws ApiError on a well-formed 401 Problem response', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(
      problemResponse(401, 'Unauthorized'),
    )

    let thrown: unknown
    try {
      await importEstimates(importItems)
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(ApiError)
    expect((thrown as ApiError).status).toBe(401)
  })
})

describe('ApiError shape', () => {
  it('carries status, title, detail, and instance from the Problem response', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(
      makeResponse(413, {
        type: 'https://httpstatuses.com/413',
        title: 'Payload Too Large',
        status: 413,
        detail: 'Estimate content is 2.3 MB; the maximum is 1.0 MB. Nothing was saved.',
        instance: '/estimates/est-001',
      }),
    )

    let thrown: unknown
    try {
      await create(fixedUpsert)
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(ApiError)
    const err = thrown as ApiError
    expect(err.status).toBe(413)
    expect(err.title).toBe('Payload Too Large')
    expect(err.detail).toBe('Estimate content is 2.3 MB; the maximum is 1.0 MB. Nothing was saved.')
    expect(err.instance).toBe('/estimates/est-001')
    expect(err.name).toBe('ApiError')
  })

  it('constructs a synthetic ApiError when the body is not valid JSON', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(
      new Response('Internal Server Error', { status: 500, headers: { 'Content-Type': 'text/plain' } }),
    )

    let thrown: unknown
    try {
      await get('est-001')
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(ApiError)
    expect((thrown as ApiError).status).toBe(500)
  })
})
