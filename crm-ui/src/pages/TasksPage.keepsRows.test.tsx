/**
 * @vitest-environment jsdom
 *
 * TasksPage keeps the rows it still lists (specs/20261116-record-hours-in-place design S3, plan G1, QE D3): the success
 * message of hours-ui's Record hours lives in the task's row and is dismissed by ×, by the next save or by leaving the
 * page — never because ANOTHER task on the page was marked done. Mark done moves a task out of the Open view, so a row
 * above this one disappears and every row below it moves up one place: each row keeps its element (and the message in
 * it) only if the list follows the task, not the slot (`ListRows`, keyed by the row's own key).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { RouterProvider } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { createAppRouter } from '../router'
import type { Activity, PersonRef } from '../lib/types'
import { fakeApi, page } from '../test-support/fakeApi'
import type { FakeAnswer } from '../test-support/fakeApi'

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock('shell/session', () => ({
  apiFetch,
  getCrmApiBaseUrl: () => 'http://crm-api.test',
  getActivitiesApiBaseUrl: () => 'http://activities-api.test',
  getAuthBaseUrl: () => 'http://auth.test',
  useSession: () => ({ data: { user: { id: 'u-me' } } }),
}))
// The real widget keeps its success message in its own state, which is what an unmounted row loses.
vi.mock('shell/extensions', async () => {
  const { useState } = await import('react')
  const Widget = () => {
    const [message, setMessage] = useState<string | null>(null)
    return (
      <>
        <button type="button" data-testid="hours-widget" onClick={() => setMessage('2 h recorded')}>
          Record hours
        </button>
        {message && (
          <p role="status" data-testid="hours-message">
            {message}
          </p>
        )}
      </>
    )
  }
  return {
    HostExtension: ({ name }: { name: string; props: Record<string, string>; fallback: ReactNode }) =>
      name === 'hours.recordHours' ? <Widget /> : null,
  }
})

const person = (id: string): PersonRef => ({ id, name: `Person ${id}`, status: 'active' })

const task = (id: string, subject: string, done = false): Activity => ({
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
    assignee: person('u-me'),
    completedAt: done ? '2026-11-10T10:00:00.000Z' : null,
    completedBy: done ? person('u-me') : null,
  },
  createdAt: '2026-11-03T08:00:00.000Z',
  updatedAt: '2026-11-03T08:00:00.000Z',
})

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => (resolve = done))
  return { promise, resolve }
}

/** Three open tasks of mine; completing one removes it from the Open view. Every read after the first waits on a gate. */
function server() {
  const state = {
    open: [task('a', 'Send the offer'), task('b', 'Prepare the demo'), task('c', 'Book the room')],
    reads: 0,
    gate: deferred(),
  }
  const complete = (id: string) => (): FakeAnswer => {
    const done = task(id, state.open.find((item) => item.id === id)!.subject, true)
    state.open = state.open.filter((item) => item.id !== id)
    return { status: 200, body: done }
  }
  apiFetch.mockImplementation(
    fakeApi({
      'GET /tasks': async (): Promise<FakeAnswer> => {
        state.reads += 1
        if (state.reads > 1) await state.gate.promise
        return { status: 200, body: page(state.open) }
      },
      'GET /tasks/assignees': () => ({ status: 200, body: { items: [] } }),
      'POST /activities/a/complete': complete('a'),
      'POST /activities/b/complete': complete('b'),
      'POST /activities/c/complete': complete('c'),
    }),
  )
  return state
}

const rowOf = (id: string) => screen.getByTestId(`crm-activity-${id}`)

const openTasksPage = async () => {
  window.history.pushState(null, '', '/tasks')
  render(<RouterProvider router={createAppRouter()} />)
  await screen.findByRole('heading', { level: 2, name: 'Tasks' })
  // The widget arrives through a dynamic import: wait until every row of mine offers it.
  await waitFor(() => expect(screen.getAllByTestId('hours-widget')).toHaveLength(3))
}

beforeEach(() => {
  window.scrollTo = () => undefined
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('TasksPage — marking a task done does not unmount the tasks still listed', () => {
  it('Mark done on a row above: the rows below keep their elements and the hours message in them', async () => {
    const api = server()
    await openTasksPage()
    const c = rowOf('c')
    fireEvent.click(within(c).getByTestId('hours-widget'))
    expect(within(c).getByTestId('hours-message').textContent).toBe('2 h recorded')

    fireEvent.click(within(rowOf('b')).getByTestId('crm-activity-b-toggle'))
    expect((await screen.findByTestId('crm-saved')).textContent).toContain('Task marked done.')
    // The re-read is out: no skeleton, the rows on screen stay put.
    expect(screen.queryByTestId('crm-loading')).toBeNull()
    expect(rowOf('c')).toBe(c)

    api.gate.resolve()
    await waitFor(() => expect(screen.queryByTestId('crm-activity-b')).toBeNull())
    expect(api.reads).toBe(2)
    expect(rowOf('c')).toBe(c)
    expect(c.isConnected).toBe(true)
    expect(within(c).getByTestId('hours-message').textContent).toBe('2 h recorded')
    expect(rowOf('a')).not.toBeNull()
  })

  it('Mark done on the first row: every row below it keeps its element and message', async () => {
    const api = server()
    await openTasksPage()
    const b = rowOf('b')
    const c = rowOf('c')
    fireEvent.click(within(b).getByTestId('hours-widget'))
    fireEvent.click(within(c).getByTestId('hours-widget'))

    fireEvent.click(within(rowOf('a')).getByTestId('crm-activity-a-toggle'))
    await screen.findByTestId('crm-saved')
    api.gate.resolve()
    await waitFor(() => expect(screen.queryByTestId('crm-activity-a')).toBeNull())

    expect(rowOf('b')).toBe(b)
    expect(rowOf('c')).toBe(c)
    expect(within(b).getByTestId('hours-message').textContent).toBe('2 h recorded')
    expect(within(c).getByTestId('hours-message').textContent).toBe('2 h recorded')
  })

  it('the row that was marked done goes, with its message', async () => {
    const api = server()
    await openTasksPage()
    fireEvent.click(within(rowOf('b')).getByTestId('hours-widget'))
    expect(within(rowOf('b')).getByTestId('hours-message')).not.toBeNull()

    fireEvent.click(within(rowOf('b')).getByTestId('crm-activity-b-toggle'))
    await screen.findByTestId('crm-saved')
    api.gate.resolve()
    await waitFor(() => expect(screen.queryByTestId('crm-activity-b')).toBeNull())
    expect(screen.queryByTestId('hours-message')).toBeNull()
  })
})
