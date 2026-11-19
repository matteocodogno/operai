import { beforeEach, describe, expect, it, vi } from 'vitest'

const { apiFetch } = vi.hoisted(() => ({
  apiFetch: vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(),
}))
vi.mock('shell/session', async () => (await import('../test-support/fakeSession')).shellSessionMock(apiFetch))

import { ORIGINS } from '../test-support/fakeSession'
import { activityItem } from '../test-support/fakeApi'
import { activitiesAnswer, dealActivities, projectTasks } from '../test-support/fixtures/activity'
import { fakeApi, problem, requests } from '../test-support/fakeApi'
import { ACTIVITIES_PAGE_SIZE, readActivities } from './activitiesRead'
import { HoursApiError } from './errors'

beforeEach(() => {
  apiFetch.mockReset()
  apiFetch.mockImplementation(fakeApi({ 'GET /activities': () => activitiesAnswer(projectTasks) }))
})

describe('readActivities (plan § Components `hours-ui`: the activity picker reads activities-api as the person)', () => {
  it('asks activities-api for one page of the project, as the person, and nothing else', async () => {
    await readActivities({ type: 'project', id: 'p1' })

    expect(requests(apiFetch)).toEqual([
      {
        method: 'GET',
        origin: ORIGINS.activities,
        path: '/activities',
        query: { projectId: 'p1', pageSize: String(ACTIVITIES_PAGE_SIZE) },
        body: undefined,
      },
    ])
    expect(ACTIVITIES_PAGE_SIZE).toBe(100)
  })

  it('asks by dealId for a deal', async () => {
    await readActivities({ type: 'deal', id: 'd1' })

    expect(requests(apiFetch)[0]).toMatchObject({
      origin: ORIGINS.activities,
      query: { dealId: 'd1', pageSize: '100' },
    })
    expect(requests(apiFetch)[0]!.query).not.toHaveProperty('projectId')
  })

  it('percent-encodes an id, so it cannot add a filter of its own', async () => {
    await readActivities({ type: 'project', id: 'p1&companyId=c9' })

    expect(requests(apiFetch)[0]!.query).toEqual({ projectId: 'p1&companyId=c9', pageSize: '100' })
  })

  it('answers the items in activities-api’s order, each with its type and subject, and the whole count', async () => {
    const read = await readActivities({ type: 'project', id: 'p1' })

    expect(read).toEqual({
      items: [
        { id: 'a-offer', type: 'task', subject: 'Write the offer' },
        { id: 'a-review', type: 'task', subject: 'Review the design' },
      ],
      total: 2,
    })
  })

  it('keeps a deal’s activity types', async () => {
    apiFetch.mockImplementation(fakeApi({ 'GET /activities': () => activitiesAnswer(dealActivities, 40) }))

    const read = await readActivities({ type: 'deal', id: 'd1' })

    expect(read.items.map((item) => item.type)).toEqual(['call', 'note', 'task'])
    expect(read.total).toBe(40)
  })

  it('keeps an activity whose type this build does not know, without a type', async () => {
    apiFetch.mockImplementation(
      fakeApi({
        'GET /activities': () => activitiesAnswer([activityItem({ id: 'a9', type: 'visit', subject: 'On site' })]),
      }),
    )

    expect((await readActivities({ type: 'project', id: 'p1' })).items).toEqual([
      { id: 'a9', type: null, subject: 'On site' },
    ])
  })

  it('forwards the abort signal', async () => {
    const controller = new AbortController()
    await readActivities({ type: 'project', id: 'p1' }, { signal: controller.signal })

    expect(apiFetch.mock.calls[0]![1]!.signal).toBe(controller.signal)
  })

  it.each([
    [404, 'not_found'],
    [503, 'host_unavailable'],
    [500, undefined],
  ])('refuses on a %i answer', async (status, code) => {
    apiFetch.mockImplementation(fakeApi({ 'GET /activities': () => ({ status, body: problem(status, code) }) }))

    await expect(readActivities({ type: 'project', id: 'p1' })).rejects.toMatchObject({
      constructor: HoursApiError,
      status,
    })
  })

  it('refuses a network failure as it came', async () => {
    apiFetch.mockRejectedValue(new TypeError('Failed to fetch'))

    await expect(readActivities({ type: 'project', id: 'p1' })).rejects.toThrow('Failed to fetch')
  })

  it.each([
    ['an answer that is not JSON', () => new Response('<html>', { status: 200 })],
    ['a body with no items', () => new Response(JSON.stringify({ total: 3 }), { status: 200 })],
    ['a body whose items are not a list', () => new Response(JSON.stringify({ items: {}, total: 0 }), { status: 200 })],
  ])('refuses %s: a page that cannot be read is a failed read, never an empty one', async (_name, answer) => {
    apiFetch.mockImplementation(async () => answer())

    await expect(readActivities({ type: 'project', id: 'p1' })).rejects.toBeInstanceOf(Error)
  })

  it('leaves out an item with no id or no subject, and counts the whole total', async () => {
    apiFetch.mockImplementation(
      fakeApi({
        'GET /activities': () => ({
          status: 200,
          body: {
            items: [
              { id: 'a1', type: 'task', subject: 'Kept' },
              { id: 'a2', type: 'task' },
              { type: 'task', subject: 'No id' },
              null,
            ],
            total: 4,
            page: 1,
            pageSize: 100,
          },
        }),
      }),
    )

    expect(await readActivities({ type: 'project', id: 'p1' })).toEqual({
      items: [{ id: 'a1', type: 'task', subject: 'Kept' }],
      total: 4,
    })
  })

  it('takes the number of items as the total when the answer carries none', async () => {
    apiFetch.mockImplementation(
      fakeApi({
        'GET /activities': () => ({ status: 200, body: { items: [{ id: 'a1', type: 'task', subject: 'One' }] } }),
      }),
    )

    expect((await readActivities({ type: 'project', id: 'p1' })).total).toBe(1)
  })
})
