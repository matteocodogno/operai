import { describe, expect, it, vi } from 'vitest'
import {
  ADA,
  GONE,
  SEED_LISTS,
  activityItem,
  dealItem,
  dealOn,
  deferred,
  entriesPage,
  fakeApi,
  listsHandler,
  meetingOn,
  meetingRow,
  otherWorkOn,
  page,
  problem,
  projectItem,
  projectOn,
  requests,
  sequence,
  timeEntryView,
  totalsAnswer,
} from './fakeApi'
import type { TimeListsView } from '../lib/hoursApi.types'
import { EMPLOYEE, ORIGINS, READ_ALL_HOLDER, shellSessionMock } from './fakeSession'

const hours = (path: string) => `${ORIGINS.hours}${path}`

const call = async <T = Record<string, unknown>>(api: ReturnType<typeof fakeApi>, url: string, init?: RequestInit) => {
  const response = await api(url, init)
  const text = await response.text()
  return { status: response.status, body: text ? (JSON.parse(text) as T) : undefined }
}

const send = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

/**
 * Every route hours-ui's screens (and admin-ui's lists) reach, written out here and not read from the
 * fake: hours-api's ten routes of plan § API contracts and the four owner searches of plan § Components
 * `hours-ui`. A route the plan has and the fake lacks fails here.
 */
describe('fakeApi answers every route of the plan with a valid default', () => {
  const api = fakeApi()

  it('GET /time-entries: an empty page', async () => {
    expect(await call(api, hours('/time-entries?whose=mine&from=2026-11-01&to=2026-11-30'))).toEqual({
      status: 200,
      body: { items: [], nextCursor: null, unavailable: [] },
    })
  })

  it('POST /time-entries: 201 with the view of what was sent', async () => {
    const { status, body } = await call(
      api,
      hours('/time-entries'),
      send('POST', {
        day: '2026-11-12',
        minutes: 150,
        on: { type: 'deal', id: 'd1' },
        note: 'Demo',
        workTypeId: 'wt-deal-demo',
      }),
    )
    expect(status).toBe(201)
    expect(body).toMatchObject({
      day: '2026-11-12',
      minutes: 150,
      note: 'Demo',
      on: { type: 'deal', id: 'd1', visibility: 'visible' },
      workType: { id: 'wt-deal-demo', name: 'Demo', retired: false },
    })
    expect(body!['id']).toEqual(expect.any(String))
  })

  it('PATCH /time-entries/:id: 200 with the entry changed in what was sent only', async () => {
    const { status, body } = await call(api, hours('/time-entries/e9'), send('PATCH', { minutes: 60 }))
    expect(status).toBe(200)
    expect(body).toMatchObject({ id: 'e9', minutes: 60 })
    expect(body!['day']).toBe(timeEntryView().day)
  })

  it('DELETE /time-entries/:id: 204', async () => {
    expect(await call(api, hours('/time-entries/e9'), { method: 'DELETE' })).toEqual({ status: 204, body: undefined })
  })

  it('GET /time-entries/totals: nothing counted', async () => {
    expect(await call(api, hours('/time-entries/totals?groupBy=day&whose=mine&from=2026-11-01&to=2026-11-30'))).toEqual(
      {
        status: 200,
        body: { totalMinutes: 0, groups: [], unavailable: [] },
      },
    )
  })

  it('GET /time-lists: the seeded categories and work types (A15)', async () => {
    const { status, body } = await call<TimeListsView>(api, hours('/time-lists?includeRetired=true'))
    expect(status).toBe(200)
    expect(body).toEqual(SEED_LISTS)
    expect(body!.categories.map((c) => c.id)).toEqual([
      'tc-training',
      'tc-talk-preparation',
      'tc-administration',
      'tc-other',
    ])
    expect(body!.categories.find((c) => c.id === 'tc-other')?.requiresNote).toBe(true)
    expect(body!.workTypes.project).toHaveLength(4)
    expect(body!.workTypes.deal).toHaveLength(4)
  })

  it('POST /time-categories and PATCH /time-categories/:id', async () => {
    const created = await call(api, hours('/time-categories'), send('POST', { name: 'Formazione', requiresNote: true }))
    expect(created.status).toBe(201)
    expect(created.body).toMatchObject({ name: 'Formazione', requiresNote: true, retired: false })
    const retired = await call(api, hours('/time-categories/tc-training'), send('PATCH', { retired: true }))
    expect(retired.status).toBe(200)
    expect(retired.body).toMatchObject({ id: 'tc-training', retired: true })
  })

  it('POST /work-types and PATCH /work-types/:id', async () => {
    const created = await call(api, hours('/work-types'), send('POST', { list: 'deal', name: 'Workshop' }))
    expect(created.status).toBe(201)
    expect(created.body).toMatchObject({ list: 'deal', name: 'Workshop', retired: false })
    const renamed = await call(api, hours('/work-types/wt-deal-demo'), send('PATCH', { name: 'Live demo' }))
    expect(renamed.status).toBe(200)
    expect(renamed.body).toMatchObject({ id: 'wt-deal-demo', name: 'Live demo' })
  })

  it('the four owner searches, each on its own service: projects, deals, meetings, activities', async () => {
    for (const [service, path] of [
      ['projects', '/projects?q=alp'],
      ['crm', '/deals?q=acme'],
      ['meetings', '/meetings?q=kick'],
      ['activities', '/activities?projectId=p1&pageSize=100'],
    ] as const) {
      expect(await call(api, `${ORIGINS[service]}${path}`), `${service} ${path}`).toEqual({
        status: 200,
        body: { items: [], total: 0, page: 1, pageSize: 25 },
      })
    }
  })
})

describe('fakeApi dispatch', () => {
  it('an override replaces the default for its route and for no other', async () => {
    const api = fakeApi({ 'GET /time-lists': () => ({ status: 503, body: problem(503, 'host_unavailable') }) })
    expect((await call(api, hours('/time-lists?includeRetired=true'))).status).toBe(503)
    expect((await call(api, hours('/time-entries?whose=mine&from=2026-11-01&to=2026-11-30'))).status).toBe(200)
  })

  it('hands the handler the URL (with its query), the init and the decoded :params', async () => {
    const handler = vi.fn(() => ({ status: 200, body: {} }))
    const api = fakeApi({ 'PATCH /time-entries/:id': handler })
    await call(api, hours('/time-entries/a%2Fb?x=1'), send('PATCH', { note: 'n' }))
    const [url, init, params] = handler.mock.calls[0] as unknown as [URL, RequestInit, Record<string, string>]
    expect(url.search).toBe('?x=1')
    expect(init.method).toBe('PATCH')
    expect(params).toEqual({ id: 'a/b' })
  })

  it('a route answers only on its own service’s origin: the deal picker asking hours-api gets nothing', async () => {
    const api = fakeApi()
    expect((await call(api, `${ORIGINS.hours}/deals?q=acme`)).status).toBe(404)
    expect((await call(api, `${ORIGINS.crm}/time-entries?whose=mine&from=2026-11-01&to=2026-11-30`)).status).toBe(404)
  })

  it('a :param matches one segment: it does not swallow a longer path', async () => {
    const api = fakeApi()
    expect((await call(api, hours('/time-entries/e1/extra'), { method: 'DELETE' })).status).toBe(404)
  })

  it('the exact /time-entries/totals is not read as an entry id', async () => {
    const handler = vi.fn(() => ({ status: 200, body: { which: 'patch' } }))
    const api = fakeApi({ 'PATCH /time-entries/:id': handler })
    expect((await call(api, hours('/time-entries/totals?groupBy=day&whose=mine&from=a&to=b'))).body).toMatchObject({
      totalMinutes: 0,
    })
    expect(handler).not.toHaveBeenCalled()
  })

  it('an unrouted request is a 404 Problem naming what was asked, so a missing route is easy to see', async () => {
    const api = fakeApi()
    const { status, body } = await call(api, hours('/nowhere'), { method: 'POST' })
    expect(status).toBe(404)
    expect(body).toMatchObject({ status: 404, code: 'not_found' })
    expect(body!['detail']).toContain('POST')
    expect(body!['detail']).toContain('/nowhere')
  })

  it('rejects like a real fetch when the request is aborted before the answer', async () => {
    const api = fakeApi()
    const controller = new AbortController()
    controller.abort()
    await expect(
      api(hours('/time-entries?whose=mine&from=a&to=b'), { signal: controller.signal }),
    ).rejects.toMatchObject({
      name: 'AbortError',
    })
  })

  it('rejects like a real fetch when it is aborted while the handler is still working', async () => {
    const gate = deferred<void>()
    const api = fakeApi({
      'GET /time-entries': async () => {
        await gate.promise
        return { status: 200, body: entriesPage([]) }
      },
    })
    const controller = new AbortController()
    const pending = api(hours('/time-entries?whose=mine&from=a&to=b'), { signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    gate.resolve()
  })
})

describe('requests', () => {
  it('lists what the fake received, parsed, optionally for one route', async () => {
    const api = fakeApi()
    await call(api, hours('/time-entries?whose=all&from=2026-11-01&to=2026-11-30&dealId=d1'))
    await call(
      api,
      hours('/time-entries'),
      send('POST', { day: '2026-11-12', minutes: 30, on: { type: 'none', categoryId: 'tc-other' } }),
    )
    await call(api, `${ORIGINS.crm}/deals?q=ac`)

    expect(requests(api)).toHaveLength(3)
    const [list] = requests(api, 'GET /time-entries')
    expect(list).toMatchObject({
      method: 'GET',
      origin: ORIGINS.hours,
      path: '/time-entries',
      query: { whose: 'all', from: '2026-11-01', to: '2026-11-30', dealId: 'd1' },
    })
    expect(requests(api, 'POST /time-entries')[0]!.body).toMatchObject({ minutes: 30 })
    expect(requests(api, 'GET /deals')[0]!.query).toEqual({ q: 'ac' })
    expect(requests(api, 'DELETE /time-entries/:id')).toEqual([])
  })

  it('matches a parameterised route, and keeps the order of the calls', async () => {
    const api = fakeApi()
    await call(api, hours('/time-entries/e1'), send('PATCH', { minutes: 60 }))
    await call(api, hours('/time-entries/e2'), send('PATCH', { minutes: 90 }))
    expect(requests(api, 'PATCH /time-entries/:id').map((r) => r.path)).toEqual([
      '/time-entries/e1',
      '/time-entries/e2',
    ])
  })
})

describe('fixtures', () => {
  it('timeEntryView is a project entry that a test overrides member by member', () => {
    const entry = timeEntryView({ minutes: 30, note: 'x' })
    expect(entry).toMatchObject({ minutes: 30, note: 'x', person: ADA, on: { type: 'project', visibility: 'visible' } })
    expect(timeEntryView().id).not.toBe(timeEntryView({ id: 'e2' }).id)
  })

  it('on-builders give the four targets of plan § Views, with the hidden and unavailable forms', () => {
    expect(projectOn('p1', 'Project Alpha')).toMatchObject({
      type: 'project',
      id: 'p1',
      label: 'Project Alpha',
      href: '/projects/p1',
    })
    expect(dealOn('d1', 'Acme renewal')).toMatchObject({ type: 'deal', href: '/crm/deals/d1' })
    expect(meetingOn('m1', 'Kick-off').deal).toEqual({ state: 'none' })
    expect(meetingOn('m1', 'Kick-off', { state: 'unknown' }).deal).toEqual({ state: 'unknown' })
    expect(otherWorkOn('Training')).toMatchObject({ type: 'none', category: { name: 'Training', retired: false } })
    expect(projectOn('p1', null, 'hidden')).toMatchObject({ label: null, href: null, visibility: 'hidden' })
  })

  it('totalsAnswer counts every group once: the sum is the total (plan § Totals)', () => {
    const answer = totalsAnswer([
      { kind: 'keyed', key: 'p1', label: 'Alpha', minutes: 120 },
      { kind: 'hidden', minutes: 30 },
      { kind: 'none', minutes: 60 },
    ])
    expect(answer).toEqual({ totalMinutes: 210, groups: expect.any(Array), unavailable: [] })
  })

  it('entriesPage carries the cursor and the unavailable sources', () => {
    expect(entriesPage([timeEntryView()], { nextCursor: 'c1', unavailable: ['projects'] })).toMatchObject({
      nextCursor: 'c1',
      unavailable: ['projects'],
    })
  })

  it('page is the owners’ envelope', () => {
    expect(page([1, 2], 40)).toEqual({ items: [1, 2], total: 40, page: 1, pageSize: 25 })
    expect(page([])).toEqual({ items: [], total: 0, page: 1, pageSize: 25 })
  })

  it('the owners’ rows carry the members the pickers read', () => {
    expect(projectItem({ name: 'Project Alpha' })).toMatchObject({
      id: expect.any(String),
      name: 'Project Alpha',
      type: 'internal',
    })
    expect(dealItem({ title: 'Acme renewal' })).toMatchObject({
      id: expect.any(String),
      title: 'Acme renewal',
      company: { name: expect.any(String) },
    })
    expect(meetingRow({ title: 'Kick-off' })).toMatchObject({
      id: expect.any(String),
      title: 'Kick-off',
      role: 'creator',
    })
    expect(activityItem({ subject: 'Write the offer', type: 'task' })).toMatchObject({
      id: expect.any(String),
      subject: 'Write the offer',
      type: 'task',
    })
  })

  it('GONE is a deactivated person with no name', () => {
    expect(GONE).toEqual({ id: 'u-gone', name: null, status: 'deleted' })
  })
})

describe('listsHandler', () => {
  const lists = {
    categories: [
      { id: 'c1', name: 'Training', requiresNote: false, retired: false },
      { id: 'c2', name: 'Seminars', requiresNote: false, retired: true },
    ],
    workTypes: {
      project: [{ id: 'w1', list: 'project' as const, name: 'Analysis', retired: true }],
      deal: [{ id: 'w2', list: 'deal' as const, name: 'Analysis', retired: false }],
    },
  }

  it('leaves retired items out unless includeRetired=true, like the server (plan § Lists)', async () => {
    const api = fakeApi({ 'GET /time-lists': listsHandler(lists) })
    const without = await call<TimeListsView>(api, hours('/time-lists?includeRetired=false'))
    expect(without.body!.categories.map((c) => c.id)).toEqual(['c1'])
    expect(without.body!.workTypes.project).toEqual([])
    const withRetired = await call<TimeListsView>(api, hours('/time-lists?includeRetired=true'))
    expect(withRetired.body!.categories.map((c) => c.id)).toEqual(['c1', 'c2'])
    expect(withRetired.body!.workTypes.project).toHaveLength(1)
  })
})

describe('sequence and deferred', () => {
  it('sequence answers with each handler in turn and repeats the last', async () => {
    const api = fakeApi({
      'GET /time-lists': sequence(
        () => ({ status: 503, body: problem(503, 'host_unavailable') }),
        () => ({ status: 200, body: SEED_LISTS }),
      ),
    })
    expect((await call(api, hours('/time-lists?includeRetired=true'))).status).toBe(503)
    expect((await call(api, hours('/time-lists?includeRetired=true'))).status).toBe(200)
    expect((await call(api, hours('/time-lists?includeRetired=true'))).status).toBe(200)
  })

  it('deferred is settled from outside, once', async () => {
    const gate = deferred<number>()
    gate.resolve(7)
    gate.resolve(8)
    await expect(gate.promise).resolves.toBe(7)
  })
})

describe('problem', () => {
  it('is a Problem JSON body with the code and any extension members', () => {
    expect(problem(422, 'invalid_minutes', { field: 'minutes' })).toEqual({
      type: 'about:blank',
      title: 'Problem 422',
      status: 422,
      code: 'invalid_minutes',
      field: 'minutes',
    })
    expect(problem(500)).not.toHaveProperty('code')
  })
})

describe('shellSessionMock', () => {
  const apiFetch = vi.fn()

  it('exposes the five origins hours-ui reads from the shell, all different', () => {
    const session = shellSessionMock(apiFetch)
    const origins = [
      session.getHoursApiBaseUrl(),
      session.getProjectsApiBaseUrl(),
      session.getCrmApiBaseUrl(),
      session.getMeetingsApiBaseUrl(),
      session.getActivitiesApiBaseUrl(),
    ]
    expect(new Set(origins).size).toBe(5)
    expect(origins).toEqual(Object.values(ORIGINS))
    expect(session.apiFetch).toBe(apiFetch)
  })

  it('an employee by default, a holder on request', () => {
    expect(shellSessionMock(apiFetch).usePermissions()).toBe(EMPLOYEE)
    expect(shellSessionMock(apiFetch, { permissions: READ_ALL_HOLDER }).usePermissions().permissions).toContainEqual({
      resource: 'time-entry',
      action: 'read-all',
    })
    expect(EMPLOYEE.permissions.some((p) => p.resource === 'time-entry')).toBe(false)
  })
})
