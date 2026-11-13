/**
 * The pickers' searches (specs/029-time-tracking T24, T27; plan § Components `hours-ui` "Target pickers"):
 * projects-api `GET /projects?q=` and crm-api `GET /deals?q=` (the filters and the entry dialog) and
 * meetings-api `GET /meetings?q=` (the entry dialog), read as the person through `apiFetch`, with the answer
 * mapped to what `SearchPicker` takes — a 403 is `forbidden` (the person may not search that kind of
 * record), a 503, any other refusal or a network failure is `unavailable` (an unreachable service is never
 * "no match").
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock('shell/session', async () => (await import('../test-support/fakeSession')).shellSessionMock(apiFetch))

import { dealItem, fakeApi, meetingRow, page, problem, projectItem, requests } from '../test-support/fakeApi'
import { ORIGINS } from '../test-support/fakeSession'
import { searchDeals, searchMeetings, searchProjects } from './searchers'

const signal = () => new AbortController().signal

const useApi = (overrides: Parameters<typeof fakeApi>[0] = {}) => {
  const api = fakeApi(overrides)
  apiFetch.mockImplementation(api)
  return api
}

beforeEach(() => {
  apiFetch.mockReset()
})

describe('searchProjects (projects-api GET /projects?q=)', () => {
  it('asks projects-api, as the person, for the typed text, and offers each project by id and name', async () => {
    const api = useApi({
      'GET /projects': () => ({
        status: 200,
        body: page([
          projectItem({ id: 'p1', name: 'Project Alpha', company: { id: 'c1', name: 'Acme' } }),
          projectItem({ id: 'p2', name: 'Project Beta', company: null }),
          projectItem({ id: 'p3', name: 'Project Gamma', company: { id: 'c9', name: null } }),
        ]),
      }),
    })

    const result = await searchProjects('alp', signal())

    expect(requests(api)).toHaveLength(1)
    expect(requests(api, 'GET /projects')[0]).toMatchObject({ origin: ORIGINS.projects, query: { q: 'alp' } })
    expect(result).toEqual({
      ok: true,
      items: [
        { id: 'p1', name: 'Project Alpha', companyName: 'Acme' },
        { id: 'p2', name: 'Project Beta', companyName: null },
        { id: 'p3', name: 'Project Gamma', companyName: null },
      ],
    })
  })

  it('leaves q out when the field is empty (the list opened), and sends the text as typed, encoded', async () => {
    const api = useApi()
    await searchProjects('', signal())
    await searchProjects('a&b=c d', signal())
    const [empty, typed] = requests(api, 'GET /projects')
    expect(empty!.query).toEqual({})
    expect(typed!.query).toEqual({ q: 'a&b=c d' })
  })

  it('hands the picker its abort signal, so a request the text has outrun is cancelled', async () => {
    useApi()
    const controller = new AbortController()
    await searchProjects('a', controller.signal)
    expect(apiFetch.mock.calls[0]![1]!.signal).toBe(controller.signal)
  })

  it('no match is an empty list, not an error', async () => {
    useApi()
    expect(await searchProjects('zzz', signal())).toEqual({ ok: true, items: [] })
  })

  it('403 is forbidden: the person may not search projects', async () => {
    useApi({ 'GET /projects': () => ({ status: 403, body: problem(403, 'forbidden') }) })
    expect(await searchProjects('a', signal())).toEqual({ ok: false, reason: 'forbidden' })
  })

  it.each([503, 500, 404, 422])('%i is unavailable, never "no match"', async (status) => {
    useApi({ 'GET /projects': () => ({ status, body: problem(status) }) })
    expect(await searchProjects('a', signal())).toEqual({ ok: false, reason: 'unavailable' })
  })

  it('a network failure is unavailable', async () => {
    apiFetch.mockRejectedValue(new TypeError('Failed to fetch'))
    expect(await searchProjects('a', signal())).toEqual({ ok: false, reason: 'unavailable' })
  })

  it('an answer that is not a page of projects is unavailable, and a row without an id or a name is left out', async () => {
    useApi({ 'GET /projects': () => ({ status: 200, body: { nope: true } }) })
    expect(await searchProjects('a', signal())).toEqual({ ok: false, reason: 'unavailable' })

    useApi({
      'GET /projects': () => ({
        status: 200,
        body: { items: [{ id: 'p1' }, { name: 'No id' }, projectItem({ id: 'p2', name: 'Fine' }), null] },
      }),
    })
    expect(await searchProjects('a', signal())).toEqual({
      ok: true,
      items: [{ id: 'p2', name: 'Fine', companyName: null }],
    })
  })

  it('a request the picker aborted rejects, so the picker can drop it (an abort is not "unavailable")', async () => {
    useApi()
    const controller = new AbortController()
    const pending = searchProjects('a', controller.signal)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('searchDeals (crm-api GET /deals?q=)', () => {
  it('asks crm-api, as the person, and offers each deal by id, title and company', async () => {
    const api = useApi({
      'GET /deals': () => ({
        status: 200,
        body: page([
          dealItem({ id: 'd1', title: 'Acme renewal', company: { id: 'c1', name: 'Acme' } }),
          dealItem({ id: 'd2', title: 'Globex pilot', company: { id: 'c2', name: 'Globex' } }),
        ]),
      }),
    })

    const result = await searchDeals('re', signal())

    expect(requests(api, 'GET /deals')[0]).toMatchObject({ origin: ORIGINS.crm, query: { q: 're' } })
    expect(result).toEqual({
      ok: true,
      items: [
        { id: 'd1', title: 'Acme renewal', companyName: 'Acme' },
        { id: 'd2', title: 'Globex pilot', companyName: 'Globex' },
      ],
    })
  })

  it('403 is forbidden (no CRM access); 503, other refusals and a network failure are unavailable', async () => {
    useApi({ 'GET /deals': () => ({ status: 403, body: problem(403) }) })
    expect(await searchDeals('a', signal())).toEqual({ ok: false, reason: 'forbidden' })

    useApi({ 'GET /deals': () => ({ status: 503, body: problem(503, 'host_unavailable') }) })
    expect(await searchDeals('a', signal())).toEqual({ ok: false, reason: 'unavailable' })

    apiFetch.mockRejectedValue(new TypeError('Failed to fetch'))
    expect(await searchDeals('a', signal())).toEqual({ ok: false, reason: 'unavailable' })
  })

  it('leaves q out when the field is empty', async () => {
    const api = useApi()
    await searchDeals('', signal())
    expect(requests(api, 'GET /deals')[0]!.query).toEqual({})
  })
})

describe("searchMeetings (meetings-api GET /meetings?q=: the caller's own meetings)", () => {
  it('asks meetings-api, as the person, and offers each meeting by id, title and start', async () => {
    const api = useApi({
      'GET /meetings': () => ({
        status: 200,
        body: page([
          meetingRow({ id: 'm1', title: 'Kick-off with Acme', startsAt: '2026-11-03T09:30:00.000Z' }),
          meetingRow({ id: 'm2', title: 'Retro', startsAt: null }),
        ]),
      }),
    })

    const result = await searchMeetings('kick', signal())

    expect(requests(api)).toHaveLength(1)
    expect(requests(api, 'GET /meetings')[0]).toMatchObject({ origin: ORIGINS.meetings, query: { q: 'kick' } })
    expect(result).toEqual({
      ok: true,
      items: [
        { id: 'm1', title: 'Kick-off with Acme', startsAt: '2026-11-03T09:30:00.000Z' },
        { id: 'm2', title: 'Retro', startsAt: null },
      ],
    })
  })

  it('leaves q out when the field is empty (the list opened), and hands over the abort signal', async () => {
    const api = useApi()
    const controller = new AbortController()
    await searchMeetings('', controller.signal)
    expect(requests(api, 'GET /meetings')[0]!.query).toEqual({})
    expect(apiFetch.mock.calls[0]![1]!.signal).toBe(controller.signal)
  })

  it('403 is forbidden; 503, other refusals and a network failure are unavailable, never "no match"', async () => {
    useApi({ 'GET /meetings': () => ({ status: 403, body: problem(403) }) })
    expect(await searchMeetings('a', signal())).toEqual({ ok: false, reason: 'forbidden' })

    useApi({ 'GET /meetings': () => ({ status: 503, body: problem(503) }) })
    expect(await searchMeetings('a', signal())).toEqual({ ok: false, reason: 'unavailable' })

    apiFetch.mockRejectedValue(new TypeError('Failed to fetch'))
    expect(await searchMeetings('a', signal())).toEqual({ ok: false, reason: 'unavailable' })
  })

  it('an answer that is not a page is unavailable, and a row without an id or a title is left out', async () => {
    useApi({ 'GET /meetings': () => ({ status: 200, body: { nope: true } }) })
    expect(await searchMeetings('a', signal())).toEqual({ ok: false, reason: 'unavailable' })

    useApi({
      'GET /meetings': () => ({
        status: 200,
        body: { items: [{ id: 'm1' }, { title: 'No id' }, meetingRow({ id: 'm2', title: 'Fine' }), null] },
      }),
    })
    expect(await searchMeetings('a', signal())).toEqual({
      ok: true,
      items: [{ id: 'm2', title: 'Fine', startsAt: '2026-11-03T09:30:00.000Z' }],
    })
  })

  it('a request the picker aborted rejects, so the picker can drop it', async () => {
    useApi()
    const controller = new AbortController()
    const pending = searchMeetings('a', controller.signal)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })
})
