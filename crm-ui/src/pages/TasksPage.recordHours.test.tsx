/**
 * @vitest-environment jsdom
 *
 * TasksPage and Record hours (specs/20261116-record-hours-in-place AC-3.1, AC-3.6, AC-4.5): the CRM's Tasks page
 * offers hours-ui's Record hours on a task's row to the task's assignee and its participants — in the Open view and in
 * the Done view alike — and not on the rows of colleagues' tasks that the "Assigned to" filter can also list. When
 * hours-ui cannot be loaded each of those rows shows a link to My hours in its place, and the page works as before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { RouterProvider } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { createAppRouter } from '../router'
import type { Activity, PersonRef } from '../lib/types'
import { fakeApi, page } from '../test-support/fakeApi'

const { apiFetch, extension } = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  extension: { mode: 'widget' as 'widget' | 'fallback', calls: [] as Record<string, string>[] },
}))
vi.mock('shell/session', () => ({
  apiFetch,
  getCrmApiBaseUrl: () => 'http://crm-api.test',
  getActivitiesApiBaseUrl: () => 'http://activities-api.test',
  getAuthBaseUrl: () => 'http://auth.test',
  useSession: () => ({ data: { user: { id: 'u-me' } } }),
}))
vi.mock('shell/extensions', () => ({
  HostExtension: ({ props, fallback }: { name: string; props: Record<string, string>; fallback: ReactNode }) => {
    extension.calls.push(props)
    return extension.mode === 'fallback' ? (
      <>{fallback}</>
    ) : (
      <button type="button" data-testid="hours-widget">
        Record hours
      </button>
    )
  },
}))

const person = (id: string): PersonRef => ({ id, name: `Person ${id}`, status: 'active' })

const task = (
  id: string,
  subject: string,
  overrides: Partial<Activity> & { done?: boolean; assignee?: string } = {},
): Activity => {
  const { done = false, assignee = 'u-me', ...rest } = overrides
  return {
    id,
    type: 'task',
    subject,
    body: null,
    occurredAt: '2026-11-03T09:30:00.000Z',
    company: { id: 'c1', name: 'Acme SA' },
    contact: null,
    deal: { id: 'd1', title: 'Platform rebuild' },
    author: person('u-author'),
    participants: [],
    task: {
      dueDate: '2026-11-20',
      assignee: person(assignee),
      completedAt: done ? '2026-11-10T10:00:00.000Z' : null,
      completedBy: done ? person(assignee) : null,
    },
    createdAt: '2026-11-03T08:00:00.000Z',
    updatedAt: '2026-11-03T08:00:00.000Z',
    ...rest,
  }
}

const OPEN_MINE = task('t-mine', 'Send the offer')
const OPEN_OTHER = task('t-other', 'Prepare the demo', { assignee: 'u-else' })
const DONE_MINE = task('t-done', 'Sign off the contract', { done: true })

beforeEach(() => {
  window.scrollTo = () => undefined
  extension.mode = 'widget'
  extension.calls.length = 0
  apiFetch.mockImplementation(
    fakeApi({
      'GET /tasks': (url) => {
        const view = url.searchParams.get('status')
        const everyone = url.searchParams.get('assignee') === 'any'
        if (view === 'done') return { status: 200, body: page([DONE_MINE]) }
        return { status: 200, body: page(everyone ? [OPEN_MINE, OPEN_OTHER] : [OPEN_MINE]) }
      },
      'GET /tasks/assignees': () => ({ status: 200, body: { items: [] } }),
    }),
  )
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const openTasksPage = async () => {
  window.history.pushState(null, '', '/tasks')
  render(<RouterProvider router={createAppRouter()} />)
  await screen.findByRole('heading', { level: 2, name: 'Tasks' })
}
const rowOf = (id: string) => screen.getByTestId(`crm-activity-${id}`)

describe('TasksPage — Record hours', () => {
  it('offers it on my open task, with the task’s deal and the task', async () => {
    await openTasksPage()
    await screen.findByText('Send the offer')
    expect(await within(rowOf('t-mine')).findAllByTestId('hours-widget')).toHaveLength(1)
    expect(extension.calls).toEqual([
      {
        on: 'deal',
        targetId: 'd1',
        targetName: 'Platform rebuild',
        activityId: 't-mine',
        activityName: 'Send the offer',
        placement: 'row',
      },
    ])
  })

  it('does not offer it on a colleague’s task that the "Assigned to" filter lists (design S2)', async () => {
    await openTasksPage()
    await screen.findByText('Send the offer')
    fireEvent.change(screen.getByLabelText('Assigned to'), { target: { value: 'any' } })
    await screen.findByText('Prepare the demo')

    expect(await within(rowOf('t-mine')).findAllByTestId('hours-widget')).toHaveLength(1)
    expect(within(rowOf('t-other')).queryAllByTestId('hours-widget')).toHaveLength(0)
    // the colleague's row keeps what it had: Mark done
    expect(within(rowOf('t-other')).getByRole('button', { name: 'Mark done' })).not.toBeNull()
  })

  it('offers it on my done task in the Done view, as on an open one (AC-3.6)', async () => {
    await openTasksPage()
    await screen.findByText('Send the offer')
    fireEvent.click(screen.getByRole('tab', { name: 'Done' }))
    await screen.findByText('Sign off the contract')

    expect(await within(rowOf('t-done')).findAllByTestId('hours-widget')).toHaveLength(1)
    const group = within(rowOf('t-done')).getByRole('group', { name: 'Actions for Sign off the contract' })
    expect(
      within(group)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['Reopen', 'Record hours'])
  })

  it('shows a link to My hours on each of those rows when the widget cannot be loaded, and the page still works (AC-4.5)', async () => {
    extension.mode = 'fallback'
    await openTasksPage()
    await screen.findByText('Send the offer')

    const link = await within(rowOf('t-mine')).findByRole('link', { name: 'Record hours in My hours' })
    expect(link.getAttribute('href')).toBe('/hours')
    // the page around it is untouched: the row's own action works and the tabs switch
    await waitFor(() => expect(within(rowOf('t-mine')).getByRole('button', { name: 'Mark done' })).not.toBeNull())
    fireEvent.click(screen.getByRole('tab', { name: 'Done' }))
    expect(await screen.findByText('Sign off the contract')).not.toBeNull()
  })
})
