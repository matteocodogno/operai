/**
 * @vitest-environment jsdom
 *
 * My tasks keeps the rows it still lists (specs/20261116-record-hours-in-place design S3, plan G1, QE D3): the success
 * message of hours-ui's Record hours lives in the task's row and goes by ×, by the next save or by leaving the page —
 * not because ANOTHER task on the page was marked done. Mark done moves a task out of the Open view, so a row above
 * this one leaves and every row below it moves up one place; each keeps its element (and the message in it) only if
 * the list follows the task, not the slot (`ListRows` keyed by the row's own key).
 *
 * `shell/extensions` is mocked with a widget that keeps its own state, as hours-ui's does. Only one row below is one
 * the person may record on, so the harness's same-tick import race (see MyTasksPageRow.recordHours.test.tsx) does not
 * arise.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { RouterProvider } from '@tanstack/react-router'
import ProjectsShell from '../components/ProjectsShell'
import { createAppRouter } from '../router'
import { fakeApi, personRef, projectTask, scope } from '../test-support/fakeApi'
import type { FakeAnswer } from '../test-support/fakeApi'

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock('shell/session', () => ({
  apiFetch,
  getProjectsApiBaseUrl: () => 'http://projects-api.test',
  getAuthBaseUrl: () => 'http://auth.test',
  getActivitiesApiBaseUrl: () => 'http://activities-api.test',
  useSession: () => ({ data: { user: { id: 'u-ada', name: 'Ada Lovelace' } } }),
}))
vi.mock('shell/extensions', async () => {
  const { useState } = await import('react')
  return {
    HostExtension: ({ props }: { props: { activityName: string } }) => {
      const [recorded, setRecorded] = useState(false)
      return (
        <>
          <button type="button" onClick={() => setRecorded(true)}>
            {`Record hours on ${props.activityName}`}
          </button>
          {recorded && <p role="status">{`2 h recorded on ${props.activityName}.`}</p>}
        </>
      )
    },
  }
})

const other = personRef('u-other', 'Olga Other')
/** A task of someone else's: no Record hours for Ada, but Mark done is hers to press (`may.complete`). */
const theirs = (id: string) => projectTask(id, { author: other }, { assignee: other })
const page = (items: unknown[]) => ({ items, total: items.length, page: 1, pageSize: 25 })

const deferred = () => {
  let release: (answer: FakeAnswer) => void = () => undefined
  const answer = new Promise<FakeAnswer>((resolve) => {
    release = resolve
  })
  return { answer, release }
}

const taskReads = () =>
  apiFetch.mock.calls.filter(([input, init]) => {
    const url = new URL(String(input))
    return url.pathname === '/tasks' && ((init as RequestInit | undefined)?.method ?? 'GET') === 'GET'
  }).length

beforeEach(() => {
  window.scrollTo = () => undefined
  window.requestAnimationFrame = (callback: FrameRequestCallback) => {
    callback(0)
    return 0
  }
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('My tasks — marking a task done does not unmount the tasks still listed', () => {
  it('Mark done on a row above: the row below keeps its element and the hours message in it', async () => {
    const reread = deferred()
    let reads = 0
    apiFetch.mockImplementation(
      fakeApi({
        'GET /scope': () => ({ status: 200, body: scope() }),
        'GET /tasks': () => {
          reads += 1
          return reads === 1
            ? { status: 200, body: page([theirs('t1'), theirs('t2'), projectTask('t3')]) }
            : reread.answer.then((answer) => answer)
        },
        'POST /activities/t2/complete': () => ({ status: 200, body: theirs('t2') }),
      }),
    )
    window.history.pushState(null, '', '/tasks')
    render(<RouterProvider router={createAppRouter(undefined, ProjectsShell)} />)

    const mine = await screen.findByTestId('my-task-t3')
    fireEvent.click(await within(mine).findByRole('button', { name: 'Record hours on Task t3' }))
    expect(within(mine).getByRole('status').textContent).toBe('2 h recorded on Task t3.')

    fireEvent.click(screen.getByTestId('my-task-t2-toggle'))
    await waitFor(() => expect(taskReads()).toBe(2))
    // The re-read is out: no skeleton, the same elements.
    expect(screen.queryByTestId('projects-loading')).toBeNull()
    expect(screen.getByTestId('my-task-t3')).toBe(mine)

    reread.release({ status: 200, body: page([theirs('t1'), projectTask('t3')]) })
    await waitFor(() => expect(screen.queryByTestId('my-task-t2')).toBeNull())
    expect(screen.getByTestId('my-task-t3')).toBe(mine)
    expect(mine.isConnected).toBe(true)
    expect(within(mine).getByRole('status').textContent).toBe('2 h recorded on Task t3.')
    expect(screen.getByTestId('my-task-t1')).not.toBeNull()
  })
})
