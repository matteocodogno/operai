import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('shell/session', () => ({
  apiFetch: vi.fn(),
  getProjectsApiBaseUrl: vi.fn(() => 'http://projects-api.test'),
  getAuthBaseUrl: vi.fn(() => 'http://auth.test'),
}))

import { apiFetch } from 'shell/session'
import { ApiError, getJson, ifMatch, isStaleWrite, query, sendJson } from './api'
import * as projectsApi from './projectsApi'
import {
  createProject,
  createTerms,
  deleteTerms,
  getScope,
  listCompanies,
  listDirectory,
  listOpsManagers,
  listProjects,
  listPurchaseOrderContacts,
  listQueue,
  listQueueContacts,
  replaceTeam,
  setBexioOrderId,
  takeDealAsProject,
  transitionProject,
  updateProject,
  updatePurchaseOrder,
  updateTerms,
} from './projectsApi'

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/problem+json', ...headers } })

beforeEach(() => {
  vi.mocked(apiFetch).mockReset()
})

const catchError = async (promise: Promise<unknown>): Promise<ApiError> => {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError)
    return error as ApiError
  }
  throw new Error('expected the call to reject')
}

const lastCall = () => vi.mocked(apiFetch).mock.calls.at(-1)!
const lastUrl = () => new URL(String(lastCall()[0]))
const lastInit = (): RequestInit => lastCall()[1] as RequestInit
const headersOf = (init: RequestInit) => init.headers as Record<string, string>

describe('requests', () => {
  it('GET goes through shell/session apiFetch against projects-api', async () => {
    const body = { manage: [], managesAll: false, bexio: false, take: ['welld_ch'], oversees: false }
    vi.mocked(apiFetch).mockResolvedValue(json(200, body))
    await expect(getScope()).resolves.toEqual(body)
    expect(apiFetch).toHaveBeenCalledWith('http://projects-api.test/scope', undefined)
  })

  it('a mutation of an existing project sends If-Match with the quoted version (AC-1.7, ADR-0038)', async () => {
    vi.mocked(apiFetch).mockResolvedValue(json(200, { id: 'p1' }))
    await updateProject('p1', 7, { name: 'New' })
    expect(lastUrl().pathname).toBe('/projects/p1')
    const init = lastInit()
    expect(init.method).toBe('PATCH')
    expect(headersOf(init)['If-Match']).toBe('"7"')
    expect(headersOf(init)['Content-Type']).toBe('application/json')
    expect(JSON.parse(init.body as string)).toEqual({ name: 'New' })
  })

  it('creating a project sends no If-Match', async () => {
    vi.mocked(apiFetch).mockResolvedValue(json(201, { id: 'p1' }))
    await createProject({ name: 'Koordy', type: 'saas', entity: 'welld_ch' })
    expect(lastInit().method).toBe('POST')
    expect(lastUrl().pathname).toBe('/projects')
    expect(headersOf(lastInit())['If-Match']).toBeUndefined()
  })

  it('a state transition carries If-Match', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => json(200, { id: 'p1' }))
    await transitionProject('p1', 3, 'on_hold')
    expect(lastUrl().pathname).toBe('/projects/p1/transitions')
    expect(lastInit().method).toBe('POST')
    expect(headersOf(lastInit())['If-Match']).toBe('"3"')
    expect(JSON.parse(lastInit().body as string)).toEqual({ to: 'on_hold' })
  })

  it('the project manager is picked with the same PATCH as any edit, with If-Match (T27)', async () => {
    vi.mocked(apiFetch).mockResolvedValue(json(200, { id: 'p1' }))
    await updateProject('p1', 3, { projectManagerId: 'u9' })
    expect(lastUrl().pathname).toBe('/projects/p1')
    expect(lastInit().method).toBe('PATCH')
    expect(headersOf(lastInit())['If-Match']).toBe('"3"')
    expect(JSON.parse(lastInit().body as string)).toEqual({ projectManagerId: 'u9' })
  })

  it('the team is replaced as a whole, with If-Match', async () => {
    vi.mocked(apiFetch).mockResolvedValue(json(200, { id: 'p1' }))
    await replaceTeam('p1', 5, ['u1', 'u2'])
    expect(lastUrl().pathname).toBe('/projects/p1/team')
    expect(lastInit().method).toBe('PUT')
    expect(headersOf(lastInit())['If-Match']).toBe('"5"')
    expect(JSON.parse(lastInit().body as string)).toEqual({ memberIds: ['u1', 'u2'] })
  })

  it('terms are created without If-Match, edited and removed with it (T23)', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => json(200, { id: 't1' }))
    await createTerms('p1', { startDate: '2026-01-01', terms: { positions: [{ profile: 'Dev', plannedManDays: 5 }] } })
    expect(lastUrl().pathname).toBe('/projects/p1/terms')
    expect(lastInit().method).toBe('POST')
    expect(headersOf(lastInit())['If-Match']).toBeUndefined()
    expect(JSON.parse(lastInit().body as string)).toEqual({
      startDate: '2026-01-01',
      terms: { positions: [{ profile: 'Dev', plannedManDays: 5 }] },
    })

    await updateTerms('p1', 2, { endDate: '2026-12-31' })
    expect(lastUrl().pathname).toBe('/projects/p1/terms')
    expect(lastInit().method).toBe('PATCH')
    expect(headersOf(lastInit())['If-Match']).toBe('"2"')
    expect(JSON.parse(lastInit().body as string)).toEqual({ endDate: '2026-12-31' })

    vi.mocked(apiFetch).mockResolvedValue(new Response(null, { status: 204 }))
    await expect(deleteTerms('p1', 4)).resolves.toBeUndefined()
    expect(lastUrl().pathname).toBe('/projects/p1/terms')
    expect(lastInit().method).toBe('DELETE')
    expect(headersOf(lastInit())['If-Match']).toBe('"4"')
  })

  it('the Bexio order id and the referent are written on the purchase order, with If-Match', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => json(200, { id: 'po1' }))
    await setBexioOrderId('p1', 3, 'SO-1')
    expect(lastUrl().pathname).toBe('/projects/p1/purchase-order/bexio-order')
    expect(lastInit().method).toBe('PUT')
    expect(headersOf(lastInit())['If-Match']).toBe('"3"')
    expect(JSON.parse(lastInit().body as string)).toEqual({ bexioOrderId: 'SO-1' })

    await updatePurchaseOrder('p1', 5, { referentContactId: null })
    expect(lastUrl().pathname).toBe('/projects/p1/purchase-order')
    expect(lastInit().method).toBe('PATCH')
    expect(headersOf(lastInit())['If-Match']).toBe('"5"')
    expect(JSON.parse(lastInit().body as string)).toEqual({ referentContactId: null })
  })

  it('the referent candidates are asked of the server by project or by deal — the client never sends a company id (T18)', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => json(200, { items: [] }))
    await listPurchaseOrderContacts('p1')
    expect(lastUrl().pathname).toBe('/projects/p1/purchase-order/contacts')
    expect(lastUrl().search).toBe('')
    await listQueueContacts('d1')
    expect(lastUrl().pathname).toBe('/queue/d1/contacts')
    expect(lastUrl().search).toBe('')
    expect(Object.keys(projectsApi)).not.toContain('listCompanyContacts')
  })

  it('the queue, its ops-manager candidates and the take are projects-api calls; the take carries no If-Match', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => json(200, { items: [], truncated: false }))
    await listQueue({ q: 'web', entity: 'welld_it' })
    expect(lastUrl().pathname).toBe('/queue')
    expect(Object.fromEntries(lastUrl().searchParams)).toEqual({ q: 'web', entity: 'welld_it' })

    await listOpsManagers('d1')
    expect(lastUrl().pathname).toBe('/queue/d1/ops-managers')

    await takeDealAsProject('d1', {
      name: 'Relaunch',
      type: 'saas',
      terms: { startDate: '2026-11-01' },
      opsManagerId: 'u-ops',
      referentContactId: null,
    })
    expect(lastUrl().pathname).toBe('/queue/d1/project')
    expect(lastInit().method).toBe('POST')
    expect(headersOf(lastInit())['If-Match']).toBeUndefined()
    expect(JSON.parse(lastInit().body as string)).toEqual({
      name: 'Relaunch',
      type: 'saas',
      terms: { startDate: '2026-11-01' },
      opsManagerId: 'u-ops',
      referentContactId: null,
    })
  })

  it('there is no attach, no type change, no purchase-order create or delete: the client has no such call (D38, D39)', () => {
    const names = Object.keys(projectsApi).join(' ')
    expect(names).not.toMatch(/attach|changeType|Saas|createPurchaseOrder|deletePurchaseOrder|contract/i)
  })

  it('the project list sends only the filters that are set, 25 per page being the server default (AC-1.4)', async () => {
    vi.mocked(apiFetch).mockResolvedValue(json(200, { items: [], total: 0, page: 1, pageSize: 25 }))
    await listProjects({ page: 2, q: 'koo', type: 'saas', state: '', projectManagerId: 'u9' })
    const url = lastUrl()
    expect(url.pathname).toBe('/projects')
    expect(Object.fromEntries(url.searchParams)).toEqual({ page: '2', q: 'koo', type: 'saas', projectManagerId: 'u9' })
  })

  it('the company lookup is a projects-api call with the typed text', async () => {
    vi.mocked(apiFetch).mockResolvedValue(json(200, { items: [] }))
    await listCompanies('acm')
    expect(lastUrl().origin).toBe('http://projects-api.test')
    expect(lastUrl().pathname).toBe('/companies')
    expect(lastUrl().searchParams.get('q')).toBe('acm')
  })

  it('an id is encoded into the path', async () => {
    vi.mocked(apiFetch).mockResolvedValue(json(200, { id: 'x' }))
    await updateProject('a/b', 1, { name: 'x' })
    expect(lastUrl().pathname).toBe('/projects/a%2Fb')
  })

  it('a 204 resolves undefined', async () => {
    vi.mocked(apiFetch).mockResolvedValue(new Response(null, { status: 204 }))
    await expect(sendJson('/projects/x', 'POST')).resolves.toBeUndefined()
  })

  it('the directory read targets auth, filtered to the projects module (ADR-0055)', async () => {
    vi.mocked(apiFetch).mockResolvedValue(json(200, { users: [] }))
    await listDirectory()
    const url = lastUrl()
    expect(url.origin).toBe('http://auth.test')
    expect(url.pathname).toBe('/authz/users/directory')
    expect(url.searchParams.get('appId')).toBe('projects')
  })
})

describe('errors', () => {
  it('maps a Problem body to ApiError with code and top-level extras', async () => {
    vi.mocked(apiFetch).mockResolvedValue(
      json(409, {
        type: 't',
        title: 'Conflict',
        status: 409,
        detail: 'Changed',
        code: 'version_conflict',
        currentVersion: 8,
      }),
    )
    const error = await catchError(getJson('/projects/p1'))
    expect(error.status).toBe(409)
    expect(error.code).toBe('version_conflict')
    expect(error.detail).toBe('Changed')
    expect(error.extras).toEqual({ currentVersion: 8 })
  })

  it('reads Retry-After on a 429', async () => {
    vi.mocked(apiFetch).mockResolvedValue(
      json(429, { title: 'Too Many Requests', status: 429 }, { 'Retry-After': '12' }),
    )
    expect((await catchError(getJson('/x'))).retryAfterSeconds).toBe(12)
  })

  it('falls back to the HTTP status when the body is not JSON', async () => {
    vi.mocked(apiFetch).mockResolvedValue(new Response('oops', { status: 502, statusText: 'Bad Gateway' }))
    const error = await catchError(getJson('/x'))
    expect(error.status).toBe(502)
    expect(error.title).toBe('Bad Gateway')
  })

  it('isStaleWrite is true for 409 version_conflict and for 428, and nothing else', () => {
    expect(isStaleWrite(new ApiError({ status: 409, title: 'c', code: 'version_conflict' }))).toBe(true)
    expect(isStaleWrite(new ApiError({ status: 428, title: 'p' }))).toBe(true)
    expect(isStaleWrite(new ApiError({ status: 409, title: 'c', code: 'invalid_transition' }))).toBe(false)
    expect(isStaleWrite(new TypeError('network'))).toBe(false)
  })
})

describe('helpers', () => {
  it('ifMatch quotes the version as a strong ETag', () => {
    expect(ifMatch(12)).toBe('"12"')
  })

  it('query keeps only defined, non-empty values', () => {
    expect(query({ q: '', status: undefined, page: 2, open: true, ownerId: null })).toBe('?page=2&open=true')
    expect(query({})).toBe('')
  })
})
