import { describe, expect, it } from 'vitest'
import {
  CAN_CREATOR_DRAFT,
  CAN_NONE,
  fakeApi,
  meeting,
  page,
  participantMeeting,
  problem,
  readyMeeting,
} from './fakeApi'

const call = async (api: ReturnType<typeof fakeApi>, url: string, init?: RequestInit) => {
  const response = await api(url, init)
  return { status: response.status, body: response.status === 204 ? undefined : await response.json() }
}

describe('fakeApi', () => {
  it('dispatches on method and path', async () => {
    const api = fakeApi({
      'GET /meetings': () => ({ status: 200, body: { list: true } }),
      'POST /meetings': () => ({ status: 201, body: { created: true } }),
    })
    expect(await call(api, 'http://x.test/meetings')).toEqual({ status: 200, body: { list: true } })
    expect(await call(api, 'http://x.test/meetings', { method: 'POST' })).toEqual({
      status: 201,
      body: { created: true },
    })
  })

  it('passes :name segments as decoded params and the URL with its query', async () => {
    const api = fakeApi({
      'GET /meetings/:id/summaries/:sid': (url, _init, params) => ({ status: 200, body: { params, q: url.search } }),
    })
    const { body } = await call(api, 'http://x.test/meetings/a%2Fb/summaries/s1?x=1')
    expect(body).toEqual({ params: { id: 'a/b', sid: 's1' }, q: '?x=1' })
  })

  it('an exact route beats a parameterised one, whatever the declaration order', async () => {
    const api = fakeApi({
      'GET /meetings/:id': () => ({ status: 200, body: { which: 'param' } }),
      'GET /meetings/new': () => ({ status: 200, body: { which: 'exact' } }),
    })
    expect((await call(api, 'http://x.test/meetings/new')).body).toEqual({ which: 'exact' })
    expect((await call(api, 'http://x.test/meetings/m1')).body).toEqual({ which: 'param' })
  })

  it('a param matches ONE segment: it does not swallow a longer path', async () => {
    const api = fakeApi({ 'GET /meetings/:id': () => ({ status: 200, body: {} }) })
    expect((await call(api, 'http://x.test/meetings/m1/transcript')).status).toBe(404)
  })

  it('an unrouted request is the same 404 Problem the server gives for "not visible" (AC-5.3)', async () => {
    const api = fakeApi({})
    expect(await call(api, 'http://x.test/meetings/nope')).toEqual({
      status: 404,
      body: { type: 'about:blank', title: 'Problem 404', status: 404, code: 'not_found' },
    })
  })

  it('a handler without a body answers a bodyless response (204)', async () => {
    const api = fakeApi({ 'DELETE /meetings/:id': () => ({ status: 204 }) })
    expect((await api('http://x.test/meetings/m1', { method: 'DELETE' })).status).toBe(204)
  })

  it('records its calls so a test can assert what was sent', async () => {
    const api = fakeApi({ 'PUT /meetings/:id/text': () => ({ status: 200, body: {} }) })
    await api('http://x.test/meetings/m1/text', { method: 'PUT', body: JSON.stringify({ text: 'hi' }) })
    expect(api).toHaveBeenCalledTimes(1)
    expect(JSON.parse((api.mock.calls[0]![1] as RequestInit).body as string)).toEqual({ text: 'hi' })
  })
})

describe('fixtures', () => {
  it('problem builds an RFC 7807 body with the code and extension members', () => {
    expect(problem(409, 'chunks_missing', { missing: [3] })).toMatchObject({
      status: 409,
      code: 'chunks_missing',
      missing: [3],
    })
    expect(problem(503)).not.toHaveProperty('code')
  })

  it('page defaults the total to the item count', () => {
    expect(page([1, 2, 3])).toEqual({ items: [1, 2, 3], total: 3, page: 1, pageSize: 25 })
  })

  it('a participant meeting can do nothing, and the default draft can capture', () => {
    expect(participantMeeting().can).toEqual(CAN_NONE)
    expect(participantMeeting().role).toBe('participant')
    expect(meeting().can).toEqual(CAN_CREATOR_DRAFT)
    expect(meeting().can.capture).toBe(true)
  })

  it('a ready meeting keeps its audio and its consent facts, and cannot capture any more', () => {
    const ready = readyMeeting()
    expect(ready.audio.state).toBe('kept')
    expect(ready.consent?.noticeVersion).toBe('2026-11-01')
    expect(ready.can.capture).toBe(false)
  })
})
