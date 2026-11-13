/**
 * `readAllEntries` — the walk the export makes (specs/029-time-tracking T30; plan § Export file: "from every
 * page of `GET /time-entries` with the active filters, `limit=500` until `nextCursor` is `null`"; AC-4.6, A11,
 * AC-4.11). The request reaches the real `hoursApi` through the fake `apiFetch`, so an assertion about a query
 * is about what the contract fixes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock('shell/session', async () => (await import('../test-support/fakeSession')).shellSessionMock(apiFetch))

import { fakeApi, problem, requests } from '../test-support/fakeApi'
import type { FakeHandler } from '../test-support/fakeApi'
import { ALPHA_DEV, exportPage } from '../test-support/fixtures/export'
import { HoursApiError } from './errors'
import { EXPORT_PAGE_SIZE, readAllEntries } from './exportPages'
import type { EntryFilters } from './hoursApi'
import type { EntriesPage, TimeEntryView } from './hoursApi.types'

const FILTERS: EntryFilters = {
  whose: 'all',
  from: '2026-11-01',
  to: '2026-11-30',
  userId: 'u-ada',
  dealId: 'd1',
  categoryId: 'tc-training',
}

const entry = (id: string): TimeEntryView => ({ ...ALPHA_DEV, id })

/** `GET /time-entries` over a chain of pages: the first without a cursor, each next one by the cursor before it. */
const pages =
  (...chain: EntriesPage[]): FakeHandler =>
  (url) => {
    const cursor = url.searchParams.get('cursor')
    const index = cursor === null ? 0 : Number(cursor.replace('c', ''))
    return { status: 200, body: chain[index] }
  }

let api: ReturnType<typeof fakeApi>
const useApi = (handler: FakeHandler) => {
  api = fakeApi({ 'GET /time-entries': handler })
  apiFetch.mockImplementation(api)
}

// A block body: a `beforeEach` that returns a function has it run as a cleanup after the test, and `mockReset()`
// returns the mock itself, so an arrow body would call `apiFetch()` with no arguments after every test.
beforeEach(() => {
  apiFetch.mockReset()
})

describe('readAllEntries', () => {
  it('asks for pages of 500, the biggest hours-api takes', () => {
    expect(EXPORT_PAGE_SIZE).toBe(500)
  })

  it('reads one page when there is no cursor, with the filters and limit=500 and nothing else', async () => {
    useApi(pages(exportPage([entry('e1'), entry('e2')])))
    const read = await readAllEntries(FILTERS)
    expect(read.items.map((item) => item.id)).toEqual(['e1', 'e2'])
    expect(read.unavailable).toEqual([])
    expect(requests(api, 'GET /time-entries')).toHaveLength(1)
    expect(requests(api, 'GET /time-entries')[0]!.query).toEqual({
      whose: 'all',
      from: '2026-11-01',
      to: '2026-11-30',
      userId: 'u-ada',
      dealId: 'd1',
      categoryId: 'tc-training',
      limit: '500',
    })
  })

  it('walks every page, each by the cursor of the one before, with the same filters, and keeps the order', async () => {
    useApi(
      pages(
        exportPage([entry('e1'), entry('e2')], 'c1'),
        exportPage([entry('e3')], 'c2'),
        exportPage([entry('e4'), entry('e5')]),
      ),
    )
    const read = await readAllEntries(FILTERS)
    expect(read.items.map((item) => item.id)).toEqual(['e1', 'e2', 'e3', 'e4', 'e5'])
    const asked = requests(api, 'GET /time-entries')
    expect(asked.map((request) => request.query['cursor'])).toEqual([undefined, 'c1', 'c2'])
    for (const request of asked) {
      expect(request.query['limit']).toBe('500')
      expect(request.query['dealId']).toBe('d1')
      expect(request.query['userId']).toBe('u-ada')
      expect(request.query['from']).toBe('2026-11-01')
    }
  })

  it('names the sources any page could not ask, once each, in the catalog order', async () => {
    useApi(
      pages(
        exportPage([entry('e1')], 'c1', ['crm', 'identities']),
        exportPage([entry('e2')], 'c2', []),
        exportPage([entry('e3')], null, ['crm', 'meeting-deals']),
      ),
    )
    expect((await readAllEntries(FILTERS)).unavailable).toEqual(['identities', 'crm', 'meeting-deals'])
  })

  it('rejects with the refusal of a page, and returns nothing partial, when a later page fails (AC-4.11)', async () => {
    useApi((url) =>
      url.searchParams.get('cursor') === null
        ? { status: 200, body: exportPage([entry('e1')], 'c1') }
        : { status: 503, body: problem(503, 'host_unavailable') },
    )
    const failure = await readAllEntries(FILTERS).then(
      () => null,
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(HoursApiError)
    expect((failure as HoursApiError).code).toBe('host_unavailable')
    expect((failure as HoursApiError).status).toBe(503)
  })

  it('rejects with the network failure when a page never arrives', async () => {
    apiFetch.mockRejectedValue(new TypeError('Failed to fetch'))
    await expect(readAllEntries(FILTERS)).rejects.toThrow('Failed to fetch')
  })

  it('stops with an error, instead of asking for ever, when the server hands back a cursor it already gave', async () => {
    useApi(() => ({ status: 200, body: exportPage([entry('e1')], 'c0') }))
    await expect(readAllEntries(FILTERS)).rejects.toThrow(/cursor/i)
    // First page, then c0 once; the second answer repeats c0 and the walk stops there.
    expect(requests(api, 'GET /time-entries')).toHaveLength(2)
  })

  it('hands its abort signal to every request, so the caller can stop the walk', async () => {
    useApi(pages(exportPage([entry('e1')], 'c1'), exportPage([entry('e2')])))
    const controller = new AbortController()
    await readAllEntries(FILTERS, { signal: controller.signal })
    for (const [, init] of api.mock.calls) expect(init?.signal).toBe(controller.signal)
    controller.abort()
    await expect(readAllEntries(FILTERS, { signal: controller.signal })).rejects.toThrow()
  })
})
