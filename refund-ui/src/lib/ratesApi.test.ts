/**
 * @vitest-environment jsdom
 *
 * Unit tests for src/lib/ratesApi.ts (T12, specs/009-mileage-rate/tasks.md).
 * Strategy mirrors reviewApi.test.ts/requestsApi.test.ts: `shell/session`'s
 * `apiFetch` is mocked at the module level — refund-api's `rates/` module
 * (T3/T4) doesn't exist yet, so this targets the documented contract
 * (plan.md "## API contracts"), not a running service.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('shell/session', () => ({
  apiFetch: vi.fn(),
}))

import { apiFetch } from 'shell/session'
import { getEffectiveRate } from './ratesApi'

const REFUND_API_URL = 'http://refund-api.test'

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

beforeEach(() => {
  vi.stubEnv('VITE_REFUND_API_URL', REFUND_API_URL)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

describe('getEffectiveRate', () => {
  it('GETs /rates/effective with entity and date query params', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(
      jsonResponse(200, {
        entity: 'welld_ch',
        date: '2026-07-15',
        currency: 'CHF',
        inEffect: true,
        ratePerKmMicros: 700000,
        ratePerKm: '0.70',
        validFrom: '2026-01-01',
      }),
    )

    const result = await getEffectiveRate('welld_ch', '2026-07-15')

    expect(String(vi.mocked(apiFetch).mock.calls[0]?.[0])).toBe(
      `${REFUND_API_URL}/rates/effective?entity=welld_ch&date=2026-07-15`,
    )
    expect(result).toEqual({
      entity: 'welld_ch',
      date: '2026-07-15',
      currency: 'CHF',
      inEffect: true,
      ratePerKmMicros: 700000,
      ratePerKm: '0.70',
      validFrom: '2026-01-01',
    })
  })

  it('resolves inEffect:false when no rate is configured for that (entity, date) — AC-2.2', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(
      jsonResponse(200, { entity: 'welld_it', date: '2026-07-15', currency: 'EUR', inEffect: false }),
    )

    const result = await getEffectiveRate('welld_it', '2026-07-15')

    expect(result).toEqual({ entity: 'welld_it', date: '2026-07-15', currency: 'EUR', inEffect: false })
  })

  it('throws ApiError on a non-2xx response (e.g. 400 on a malformed date)', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(
      jsonResponse(400, { type: 'about:blank', title: 'Bad Request', status: 400, detail: 'Invalid date.' }),
    )

    await expect(getEffectiveRate('welld_ch', 'not-a-date')).rejects.toMatchObject({ status: 400 })
  })
})
