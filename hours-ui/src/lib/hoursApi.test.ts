import { beforeEach, describe, expect, it, vi } from 'vitest'

const { apiFetch, base } = vi.hoisted(() => ({
  apiFetch: vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(),
  base: { url: 'http://hours-api.test' },
}))
vi.mock('shell/session', () => ({ apiFetch, getHoursApiBaseUrl: () => base.url }))

import { HoursApiError, isCode } from './errors'
import {
  createEntry,
  deleteEntry,
  getTimeLists,
  getTotals,
  listEntries,
  updateEntry,
  type EntryFilters,
} from './hoursApi'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

/** The one request the last call made: method, path, query (as a plain object), headers and body. */
const lastRequest = () => {
  const [input, init] = apiFetch.mock.calls.at(-1)!
  const url = new URL(String(input))
  return {
    origin: url.origin,
    method: init?.method ?? 'GET',
    path: url.pathname,
    query: Object.fromEntries(url.searchParams),
    rawQuery: url.search,
    headers: new Headers(init?.headers),
    body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : init?.body,
    signal: init?.signal,
  }
}

const mine: EntryFilters = { whose: 'mine', from: '2026-11-01', to: '2026-11-30' }

beforeEach(() => {
  apiFetch.mockReset()
  base.url = 'http://hours-api.test'
})

describe('listEntries (plan § Entries)', () => {
  it('asks GET /time-entries with whose and the span, and nothing it was not given', async () => {
    apiFetch.mockResolvedValue(json({ items: [], nextCursor: null, unavailable: [] }))
    await listEntries(mine)
    expect(lastRequest()).toMatchObject({
      origin: 'http://hours-api.test',
      method: 'GET',
      path: '/time-entries',
      query: { whose: 'mine', from: '2026-11-01', to: '2026-11-30' },
    })
  })

  it('carries every filter it is given, under the plan’s names', async () => {
    apiFetch.mockResolvedValue(json({ items: [], nextCursor: null, unavailable: [] }))
    await listEntries({
      whose: 'all',
      from: '2026-01-01',
      to: '2026-12-31',
      userId: 'u-ada',
      target: 'meeting',
      projectId: 'p1',
      dealId: 'd1',
      meetingId: 'm1',
      categoryId: 'tc-training',
      workTypeId: 'wt-deal-demo',
    })
    expect(lastRequest().query).toEqual({
      whose: 'all',
      from: '2026-01-01',
      to: '2026-12-31',
      userId: 'u-ada',
      target: 'meeting',
      projectId: 'p1',
      dealId: 'd1',
      meetingId: 'm1',
      categoryId: 'tc-training',
      workTypeId: 'wt-deal-demo',
    })
  })

  it('leaves out a filter that is undefined or empty (an unset picker is not `projectId=`)', async () => {
    apiFetch.mockResolvedValue(json({ items: [], nextCursor: null, unavailable: [] }))
    await listEntries({ ...mine, projectId: undefined, dealId: '', categoryId: undefined })
    expect(Object.keys(lastRequest().query).sort()).toEqual(['from', 'to', 'whose'])
  })

  it('sends only the names of the plan: a stray property of the filters object never reaches the URL', async () => {
    apiFetch.mockResolvedValue(json({ items: [], nextCursor: null, unavailable: [] }))
    await listEntries({ ...mine, cursor: 'stale', limit: 5, evil: '1' } as unknown as EntryFilters)
    expect(Object.keys(lastRequest().query).sort()).toEqual(['from', 'to', 'whose'])
  })

  it('pages with the cursor and the limit', async () => {
    apiFetch.mockResolvedValue(json({ items: [], nextCursor: null, unavailable: [] }))
    await listEntries(mine, { cursor: 'abc==', limit: 500 })
    expect(lastRequest().query).toMatchObject({ cursor: 'abc==', limit: '500' })
  })

  it('encodes what it sends (a cursor is opaque)', async () => {
    apiFetch.mockResolvedValue(json({ items: [], nextCursor: null, unavailable: [] }))
    await listEntries(mine, { cursor: 'a b&c=d' })
    expect(lastRequest().rawQuery).toContain('cursor=a+b%26c%3Dd')
  })

  it('hands the abort signal to the request, so a stale answer can be dropped', async () => {
    apiFetch.mockResolvedValue(json({ items: [], nextCursor: null, unavailable: [] }))
    const controller = new AbortController()
    await listEntries(mine, { signal: controller.signal })
    expect(lastRequest().signal).toBe(controller.signal)
  })

  it('answers the page as the server sent it', async () => {
    const page = { items: [], nextCursor: 'next', unavailable: ['projects'] }
    apiFetch.mockResolvedValue(json(page))
    await expect(listEntries(mine)).resolves.toEqual(page)
  })
})

describe('getTotals (plan § Totals)', () => {
  it('asks GET /time-entries/totals with groupBy and the list’s filters, and no paging', async () => {
    apiFetch.mockResolvedValue(json({ totalMinutes: 0, groups: [], unavailable: [] }))
    await getTotals('deal', { ...mine, projectId: 'p1' })
    expect(lastRequest()).toMatchObject({
      method: 'GET',
      path: '/time-entries/totals',
      query: { groupBy: 'deal', whose: 'mine', from: '2026-11-01', to: '2026-11-30', projectId: 'p1' },
    })
    expect(lastRequest().query).not.toHaveProperty('cursor')
    expect(lastRequest().query).not.toHaveProperty('limit')
  })

  it.each(['person', 'project', 'deal', 'category', 'month', 'day'] as const)('groups by %s', async (groupBy) => {
    apiFetch.mockResolvedValue(json({ totalMinutes: 0, groups: [], unavailable: [] }))
    await getTotals(groupBy, mine)
    expect(lastRequest().query['groupBy']).toBe(groupBy)
  })

  it('the Person options ask without userId, whatever the view holds (design gap 2)', async () => {
    apiFetch.mockResolvedValue(json({ totalMinutes: 0, groups: [], unavailable: [] }))
    await getTotals('person', { ...mine, whose: 'all', userId: 'u-ada' }, { withoutUser: true })
    expect(lastRequest().query).not.toHaveProperty('userId')
    expect(lastRequest().query['whose']).toBe('all')
  })

  it('hands the abort signal to the request', async () => {
    apiFetch.mockResolvedValue(json({ totalMinutes: 0, groups: [], unavailable: [] }))
    const controller = new AbortController()
    await getTotals('day', mine, { signal: controller.signal })
    expect(lastRequest().signal).toBe(controller.signal)
  })
})

describe('getTimeLists (plan § Lists)', () => {
  it.each([true, false])('asks GET /time-lists with includeRetired=%s', async (includeRetired) => {
    apiFetch.mockResolvedValue(json({ categories: [], workTypes: { project: [], deal: [] } }))
    await getTimeLists({ includeRetired })
    expect(lastRequest()).toMatchObject({
      method: 'GET',
      path: '/time-lists',
      query: { includeRetired: String(includeRetired) },
    })
  })
})

describe('writes (plan § Entries)', () => {
  it('createEntry POSTs the entry as JSON and answers the view', async () => {
    const view = { id: 'e1' }
    apiFetch.mockResolvedValue(json(view, 201))
    const input = { day: '2026-11-12', minutes: 150, on: { type: 'project' as const, id: 'p1' }, note: 'Kick-off' }
    await expect(createEntry(input)).resolves.toEqual(view)
    expect(lastRequest()).toMatchObject({ method: 'POST', path: '/time-entries', body: input })
    expect(lastRequest().headers.get('Content-Type')).toBe('application/json')
  })

  it('updateEntry PATCHes only what it is given, to the entry’s own path', async () => {
    apiFetch.mockResolvedValue(json({ id: 'e/1' }))
    await updateEntry('e/1', { note: 'Changed' })
    expect(lastRequest()).toMatchObject({ method: 'PATCH', path: '/time-entries/e%2F1', body: { note: 'Changed' } })
  })

  it('deleteEntry DELETEs and resolves with nothing (204)', async () => {
    apiFetch.mockResolvedValue(new Response(null, { status: 204 }))
    await expect(deleteEntry('e1')).resolves.toBeUndefined()
    expect(lastRequest()).toMatchObject({ method: 'DELETE', path: '/time-entries/e1' })
  })

  it('sends no If-Match: an entry has one writer, so last write wins (plan, ADR-0088)', async () => {
    apiFetch.mockResolvedValue(json({ id: 'e1' }))
    await updateEntry('e1', { minutes: 60 })
    expect(lastRequest().headers.has('If-Match')).toBe(false)
    apiFetch.mockResolvedValue(new Response(null, { status: 204 }))
    await deleteEntry('e1')
    expect(lastRequest().headers.has('If-Match')).toBe(false)
  })
})

describe('transport', () => {
  it('reads the hours-api origin at call time, from the shell', async () => {
    apiFetch.mockResolvedValue(json({ items: [], nextCursor: null, unavailable: [] }))
    base.url = 'https://hours-api.operai.test'
    await listEntries(mine)
    expect(lastRequest().origin).toBe('https://hours-api.operai.test')
  })

  it('a refusal becomes an HoursApiError carrying the typed code', async () => {
    apiFetch.mockResolvedValue(json({ status: 503, title: 'Unavailable', code: 'host_unavailable', detail: 'x' }, 503))
    const error = await listEntries({ ...mine, dealId: 'd1' }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(HoursApiError)
    expect(isCode(error, 'host_unavailable')).toBe(true)
  })

  it.each([
    ['create', () => createEntry({ day: '2026-11-12', minutes: 30, on: { type: 'none', categoryId: 'tc-other' } })],
    ['update', () => updateEntry('e1', { minutes: 60 })],
    ['delete', () => deleteEntry('e1')],
    ['totals', () => getTotals('day', mine)],
    ['lists', () => getTimeLists({ includeRetired: true })],
  ])('a refusal on %s throws too', async (_name, call) => {
    apiFetch.mockResolvedValue(json({ status: 404, title: 'Not found', code: 'not_found' }, 404))
    await expect(call()).rejects.toMatchObject({ status: 404, code: 'not_found' })
  })

  it('a network failure propagates as it is: not an answer, so not an HoursApiError', async () => {
    const failure = new TypeError('Failed to fetch')
    apiFetch.mockRejectedValue(failure)
    await expect(listEntries(mine)).rejects.toBe(failure)
  })
})
