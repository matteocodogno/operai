/**
 * hoursApi — the one read projects-ui makes of hours-api (specs/20261112-project-hours T16; plan § API contracts
 * `GET /time-entries/summary`; AC-1.1, AC-1.8, AC-4.9). The seam is the request it sends (the origin is `getHoursApiBaseUrl()`, read
 * at call time, through `apiFetch`) and the figures it hands back: nothing but the two a comparison reads, and a
 * refusal or an answer it cannot trust is a rejection, never a number.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('shell/session', () => ({
  usePermissions: () => ({ epoch: 0, apps: [], roles: [], departments: [], permissions: [] }),
  apiFetch: vi.fn(),
  getProjectsApiBaseUrl: vi.fn(() => 'http://projects-api.test'),
  getAuthBaseUrl: vi.fn(() => 'http://auth.test'),
  getHoursApiBaseUrl: vi.fn(() => 'http://hours-api.test'),
}))

import { apiFetch, getHoursApiBaseUrl } from 'shell/session'
import { ApiError } from './api'
import { getHoursSummary } from './hoursApi'

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

/** The full answer of plan § API contracts, as hours-api sends it. */
const answer = (over: Record<string, unknown> = {}) => ({
  on: { type: 'project', id: 'p1' },
  totalMinutes: 5070,
  windowMinutes: 4500,
  byWorkType: [],
  byPerson: null,
  unavailable: [],
  ...over,
})

const requested = () => {
  const [input, init] = vi.mocked(apiFetch).mock.calls[0]!
  const url = new URL(String(input))
  return { url, init: init as RequestInit | undefined }
}

beforeEach(() => {
  vi.mocked(apiFetch).mockReset()
  vi.mocked(getHoursApiBaseUrl).mockReturnValue('http://hours-api.test')
})

describe('getHoursSummary', () => {
  it('asks hours-api for the project, with the package window when there is one', async () => {
    vi.mocked(apiFetch).mockResolvedValue(json(200, answer()))

    await getHoursSummary('p1', { from: '2026-03-01', to: '2027-02-28' })

    const { url, init } = requested()
    expect(url.origin + url.pathname).toBe('http://hours-api.test/time-entries/summary')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      projectId: 'p1',
      windowFrom: '2026-03-01',
      windowTo: '2027-02-28',
    })
    // A read: no method, no body, and nothing else on it.
    expect(init?.method).toBeUndefined()
    expect(init?.body).toBeUndefined()
  })

  it('leaves the window out entirely for a comparison over all time', async () => {
    vi.mocked(apiFetch).mockResolvedValue(json(200, answer({ windowMinutes: null })))

    await getHoursSummary('p1', null)

    expect(Object.fromEntries(requested().url.searchParams)).toEqual({ projectId: 'p1' })
  })

  it('encodes the project id as a value and forwards the abort signal', async () => {
    vi.mocked(apiFetch).mockResolvedValue(json(200, answer({ windowMinutes: null })))
    const controller = new AbortController()

    await getHoursSummary('a&windowTo=1', null, { signal: controller.signal })

    const { url, init } = requested()
    expect([...url.searchParams.keys()]).toEqual(['projectId'])
    expect(url.searchParams.get('projectId')).toBe('a&windowTo=1')
    expect(init?.signal).toBe(controller.signal)
  })

  it('reads the origin when it is called, not when the module is loaded', async () => {
    vi.mocked(apiFetch).mockResolvedValue(json(200, answer()))
    vi.mocked(getHoursApiBaseUrl).mockReturnValue('http://elsewhere.test')

    await getHoursSummary('p1', null)

    expect(requested().url.origin).toBe('http://elsewhere.test')
  })

  it('hands back the two figures a comparison reads and nothing else', async () => {
    vi.mocked(apiFetch).mockResolvedValue(json(200, answer()))

    const figures = await getHoursSummary('p1', { from: '2026-03-01', to: '2027-02-28' })

    // Exactly these two keys: no breakdown, no person, no name ever reaches the block (AC-1.8, AC-2.5).
    expect(figures).toEqual({ totalMinutes: 5070, windowMinutes: 4500 })
  })

  it('keeps a null window total as null (the answer carries none without a window)', async () => {
    vi.mocked(apiFetch).mockResolvedValue(json(200, answer({ windowMinutes: null })))

    expect(await getHoursSummary('p1', null)).toEqual({ totalMinutes: 5070, windowMinutes: null })
  })

  it.each([
    [404, 'not_found'],
    [503, 'host_unavailable'],
  ])('rejects with the Problem on a %i, never with a figure', async (status, code) => {
    vi.mocked(apiFetch).mockResolvedValue(json(status, { status, title: 'Problem', code }))

    const error = await getHoursSummary('p1', null).catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).status).toBe(status)
    expect((error as ApiError).code).toBe(code)
  })

  it('lets a network failure propagate', async () => {
    vi.mocked(apiFetch).mockRejectedValue(new TypeError('Failed to fetch'))

    await expect(getHoursSummary('p1', null)).rejects.toThrow('Failed to fetch')
  })

  it.each([
    ['a missing total', { totalMinutes: undefined }],
    ['a total that is not a number', { totalMinutes: '5070' }],
    ['a negative total', { totalMinutes: -30 }],
    ['a fractional total', { totalMinutes: 30.5 }],
    ['an unsafe total', { totalMinutes: Number.MAX_SAFE_INTEGER + 2 }],
    ['a window total that is not a number', { windowMinutes: '4500' }],
    ['a negative window total', { windowMinutes: -1 }],
    ['a window total the answer leaves out', { windowMinutes: undefined }],
  ])('rejects %s instead of drawing a figure from it', async (_name, over) => {
    vi.mocked(apiFetch).mockResolvedValue(json(200, answer(over)))

    await expect(getHoursSummary('p1', { from: '2026-03-01', to: '2027-02-28' })).rejects.toThrow()
  })

  it.each([
    ['null', null],
    ['a list', []],
    ['a string', 'ok'],
  ])('rejects an answer that is %s', async (_name, body) => {
    vi.mocked(apiFetch).mockResolvedValue(json(200, body))

    await expect(getHoursSummary('p1', null)).rejects.toThrow()
  })
})
