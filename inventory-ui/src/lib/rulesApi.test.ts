import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('shell/session', () => ({
  apiFetch: vi.fn(),
  getInventoryApiBaseUrl: vi.fn(() => 'http://inventory-api.test'),
  getAuthBaseUrl: vi.fn(() => 'http://auth.test'),
}))

import { apiFetch } from 'shell/session'
import { ApiError } from './api'
import { toInventoryError } from './types'

const BASE = 'http://inventory-api.test'

const ok = (status: number, body?: unknown): Response =>
  body === undefined
    ? new Response(null, { status })
    : new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const problem = (status: number, body: Record<string, unknown> = {}): Response =>
  new Response(JSON.stringify({ title: 'Problem', status, ...body }), {
    status,
    headers: { 'Content-Type': 'application/problem+json' },
  })

/** The method, URL and parsed JSON body of the single request a call made. */
const lastRequest = () => {
  const [url, init] = vi.mocked(apiFetch).mock.calls.at(-1) as [string, RequestInit | undefined]
  return {
    url,
    method: init?.method ?? 'GET',
    body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    rawBody: init?.body,
  }
}

const rejection = async (promise: Promise<unknown>): Promise<ApiError> => {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError)
    return error as ApiError
  }
  throw new Error('expected the call to reject')
}

beforeEach(() => {
  vi.mocked(apiFetch).mockReset()
})
import { createRule, listRules } from './rulesApi'

const rule = {
  entity: 'welld_ch' as const,
  effectiveFrom: '2026-01-01',
  usefulLifeYears: 4,
  firstYearShare: 'half' as const,
  lowValueThresholdCents: null,
  residualCents: 0,
}

describe('rulesApi', () => {
  it('GET /rules?entity returns the rules and the one in force', async () => {
    vi.mocked(apiFetch).mockResolvedValue(ok(200, { rules: [], inForceId: 'r-1' }))

    await expect(listRules('welld_it')).resolves.toEqual({ rules: [], inForceId: 'r-1' })

    expect(lastRequest()).toMatchObject({ url: `${BASE}/rules?entity=welld_it`, method: 'GET' })
  })

  it('GET /rules: 404 (entity out of scope) and 403 are plain ApiErrors', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(problem(404))
    vi.mocked(apiFetch).mockResolvedValueOnce(problem(403))

    expect((await rejection(listRules('welld_it'))).status).toBe(404)
    expect((await rejection(listRules('welld_it'))).status).toBe(403)
  })

  it('POST /rules sends the body, keeping a null low-value threshold null', async () => {
    vi.mocked(apiFetch).mockResolvedValue(ok(201, { id: 'r-2', ...rule }))

    await createRule(rule)

    expect(lastRequest()).toMatchObject({ url: `${BASE}/rules`, method: 'POST', body: rule })
    expect(lastRequest().body.lowValueThresholdCents).toBeNull()
  })

  it('POST /rules: 422 exposes the offending field; 409 fiscal_year_closed carries the year', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(problem(422, { field: 'usefulLifeYears' }))
    vi.mocked(apiFetch).mockResolvedValueOnce(problem(409, { code: 'fiscal_year_closed', year: 2025 }))

    const invalid = await rejection(createRule(rule))
    expect(invalid.status).toBe(422)
    expect(invalid.extras).toEqual({ field: 'usefulLifeYears' })
    expect(toInventoryError(await rejection(createRule(rule)))).toMatchObject({
      code: 'fiscal_year_closed',
      extras: { year: 2025 },
    })
  })
})
