/**
 * @vitest-environment jsdom
 *
 * ActivityTimeline and Record hours (specs/20261116-record-hours-in-place AC-3.1, AC-3.3, AC-3.4, AC-4.5): the deal's,
 * the company's and the contact's pages all show their activities through this one card, so a task's row in any of
 * them offers hours-ui's Record hours to its assignee and its participants and to nobody else — the rule lives in the
 * row (`ActivityItem`), and this proves every timeline carries it. A task seen on the deal page by someone who is
 * neither owner nor technical contact is still theirs to record on (AC-2.2's other half).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import ActivityTimeline from './ActivityTimeline'
import type { ActivityTarget } from '../lib/activitiesApi'
import type { Activity, PersonRef } from '../lib/types'
import { fakeApi, page } from '../test-support/fakeApi'
import { RouterWrapper } from '../test-support/RouterWrapper'

const { apiFetch, extensionCalls } = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  extensionCalls: [] as { name: string; props: Record<string, string> }[],
}))
vi.mock('shell/session', () => ({
  useSession: () => ({ data: { user: { id: 'u-me' } } }),
  apiFetch,
  getCrmApiBaseUrl: () => 'http://crm-api.test',
  getActivitiesApiBaseUrl: () => 'http://activities-api.test',
  getAuthBaseUrl: () => 'http://auth.test',
}))
vi.mock('shell/extensions', () => ({
  HostExtension: ({ name, props }: { name: string; props: Record<string, string>; fallback: ReactNode }) => {
    extensionCalls.push({ name, props })
    return name === 'hours.recordHours' ? (
      <button type="button" data-testid="hours-widget">
        Record hours
      </button>
    ) : null
  },
}))

const person = (id: string): PersonRef => ({ id, name: `Person ${id}`, status: 'active' })

const activity = (overrides: Partial<Activity>): Activity => ({
  id: 'a',
  type: 'task',
  subject: 'A task',
  body: null,
  occurredAt: '2026-11-03T09:30:00.000Z',
  company: { id: 'c1', name: 'Acme SA' },
  contact: null,
  deal: { id: 'd1', title: 'Platform rebuild' },
  author: person('u-author'),
  participants: [],
  task: { dueDate: null, assignee: person('u-me'), completedAt: null, completedBy: null },
  createdAt: '2026-11-03T08:00:00.000Z',
  updatedAt: '2026-11-03T08:00:00.000Z',
  ...overrides,
})

const ITEMS = [
  activity({ id: 'mine', subject: 'Send the offer' }),
  activity({
    id: 'theirs',
    subject: 'Prepare the demo',
    task: { dueDate: null, assignee: person('u-else'), completedAt: null, completedBy: null },
  }),
  activity({
    id: 'joined',
    subject: 'Review the scope',
    task: { dueDate: null, assignee: person('u-else'), completedAt: null, completedBy: null },
    participants: [person('u-me')],
  }),
  activity({ id: 'call', type: 'call', subject: 'Call the CFO', task: null, participants: [person('u-me')] }),
  activity({
    id: 'done',
    subject: 'Sign off the contract',
    task: {
      dueDate: null,
      assignee: person('u-me'),
      completedAt: '2026-11-10T10:00:00.000Z',
      completedBy: person('u-me'),
    },
  }),
]

beforeEach(() => {
  extensionCalls.length = 0
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('ActivityTimeline — Record hours on its task rows', () => {
  it.each<[string, ActivityTarget]>([
    ['a deal’s page', { dealId: 'd1' }],
    ['a company’s page', { companyId: 'c1' }],
    ['a contact’s page', { contactId: 'k1' }],
  ])('%s: offered on my tasks, the ones I take part in and my done ones, never elsewhere', async (_page, target) => {
    apiFetch.mockImplementation(fakeApi({ 'GET /activities': () => ({ status: 200, body: page(ITEMS) }) }))
    render(<ActivityTimeline target={target} company={{ id: 'c1', name: 'Acme SA' }} />, { wrapper: RouterWrapper })

    await screen.findByText('Send the offer')
    const rowOf = (id: string) => screen.getByTestId(`crm-activity-${id}`)
    for (const id of ['mine', 'joined', 'done']) {
      expect(await within(rowOf(id)).findAllByTestId('hours-widget')).toHaveLength(1)
    }
    for (const id of ['theirs', 'call']) {
      expect(within(rowOf(id)).queryAllByTestId('hours-widget')).toHaveLength(0)
    }
    expect(extensionCalls.map((call) => call.props.activityId).sort()).toEqual(['done', 'joined', 'mine'])
    expect(extensionCalls.every((call) => call.name === 'hours.recordHours' && call.props.placement === 'row')).toBe(
      true,
    )
  })

  it('hands a deal-less task over as other work, the deal’s ones as that deal (AC-3.3, AC-3.4)', async () => {
    apiFetch.mockImplementation(
      fakeApi({
        'GET /activities': () => ({
          status: 200,
          body: page([
            activity({ id: 'on-deal', subject: 'Send the offer' }),
            activity({ id: 'no-deal', subject: 'Call the CFO', deal: null }),
          ]),
        }),
      }),
    )
    render(<ActivityTimeline target={{ companyId: 'c1' }} company={{ id: 'c1', name: 'Acme SA' }} />, {
      wrapper: RouterWrapper,
    })

    await screen.findByText('Send the offer')
    await within(screen.getByTestId('crm-activity-no-deal')).findByTestId('hours-widget')
    const byActivity = (id: string) => extensionCalls.find((call) => call.props.activityName === id)!.props
    expect(byActivity('Send the offer')).toMatchObject({
      on: 'deal',
      targetId: 'd1',
      targetName: 'Platform rebuild',
      activityId: 'on-deal',
    })
    expect(byActivity('Call the CFO')).toMatchObject({ on: 'none', targetId: '', targetName: '', activityId: '' })
  })
})
