/**
 * @vitest-environment jsdom
 *
 * TasksCard — what a re-read of the list keeps (specs/20261116-record-hours-in-place, QE D3; design S3 "The message
 * goes by ×, by the next save, or by leaving the page", plan G1: no timer). An unrelated write in the card (Mark done
 * on ANOTHER task) reads the list again, and that read used to go through `loading`, which unmounted every row and the
 * Record hours widget's success message with it. A re-read now keeps the rows it still holds (React keeps a row mounted
 * under its task id); a row the re-read removes goes; and what the list depends on (project, Open / Done, page) is in
 * the key it is remembered under, so one list is never shown for another. The first read, a failed read and the empty
 * list are unchanged.
 *
 * `shell/extensions` is mocked with a widget that keeps its own state, as hours-ui's does: its message is the thing a
 * row unmount would drop.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { fakeApi, personRef, problem, projectDetail, projectTask } from '../test-support/fakeApi'
import type { FakeAnswer } from '../test-support/fakeApi'
import TasksCard from './TasksCard'

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }))

vi.mock('shell/session', () => ({
  apiFetch,
  getProjectsApiBaseUrl: () => 'http://projects-api.test',
  getAuthBaseUrl: () => 'http://auth.test',
  getActivitiesApiBaseUrl: () => 'http://activities-api.test',
  useSession: () => ({ data: { user: { id: 'u-ada', name: 'Ada Lovelace' } } }),
}))

// Only one row below is one the person may record on, so the harness's same-tick import race (see
// ProjectTaskItem.recordHours.list.test.tsx) does not arise.
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
/** A task of someone else's: no Record hours for Ada, but Mark done is hers to press. */
const theirs = (id: string) => projectTask(id, { author: other }, { assignee: other })
const page = (items: unknown[], total = items.length, pageNumber = 1) => ({
  items,
  total,
  page: pageNumber,
  pageSize: 25,
})

/** A request that answers only when the test says so: the re-read "in flight". */
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

describe('a re-read after an unrelated write (QE D3, design S3)', () => {
  it('keeps the rows it still holds, and so the widget’s message, while the list is read again and after it, and lets the row that left go', async () => {
    const reread = deferred()
    let reads = 0
    apiFetch.mockImplementation(
      fakeApi({
        'GET /tasks': () => {
          reads += 1
          return reads === 1
            ? { status: 200, body: page([projectTask('t1'), theirs('t2')]) }
            : reread.answer.then((answer) => answer)
        },
        'POST /activities/t2/complete': () => ({
          status: 200,
          body: theirs('t2'),
        }),
      }),
    )
    render(<TasksCard project={projectDetail()} canManage currentUserId="u-ada" />)

    // The person records hours on their own task: the widget's message shows on that row.
    const mine = await screen.findByTestId('project-task-t1')
    fireEvent.click(await within(mine).findByRole('button', { name: 'Record hours on Task t1' }))
    expect(within(mine).getByRole('status').textContent).toBe('2 h recorded on Task t1.')

    // Then Mark done on ANOTHER task of the same list: the card reads the list again.
    fireEvent.click(screen.getByTestId('project-task-t2-toggle'))
    await waitFor(() => expect(taskReads()).toBe(2))

    // While the re-read is in flight the rows are still there, the same elements, the message on the first of them.
    expect(screen.queryByTestId('projects-loading')).toBeNull()
    expect(screen.getByTestId('project-task-t1')).toBe(mine)
    expect(within(mine).getByRole('status').textContent).toBe('2 h recorded on Task t1.')

    // The answer lands: t2 is done and leaves the Open list; t1 was never unmounted.
    reread.release({ status: 200, body: page([projectTask('t1')]) })
    await waitFor(() => expect(screen.queryByTestId('project-task-t2')).toBeNull())
    expect(screen.getByTestId('project-task-t1')).toBe(mine)
    expect(within(mine).getByRole('status').textContent).toBe('2 h recorded on Task t1.')
  })

  it('keeps a row BELOW the one that left, with its message: the rows below it move up one place, the list follows the task and not the slot', async () => {
    const reread = deferred()
    let reads = 0
    apiFetch.mockImplementation(
      fakeApi({
        'GET /tasks': () => {
          reads += 1
          return reads === 1
            ? { status: 200, body: page([theirs('t1'), theirs('t2'), projectTask('t3')]) }
            : reread.answer.then((answer) => answer)
        },
        'POST /activities/t2/complete': () => ({ status: 200, body: theirs('t2') }),
      }),
    )
    render(<TasksCard project={projectDetail()} canManage currentUserId="u-ada" />)

    // The message sits on the last row, mine.
    const mine = await screen.findByTestId('project-task-t3')
    fireEvent.click(await within(mine).findByRole('button', { name: 'Record hours on Task t3' }))
    expect(within(mine).getByRole('status').textContent).toBe('2 h recorded on Task t3.')

    // Mark done on the row above it, which then leaves the Open list.
    fireEvent.click(screen.getByTestId('project-task-t2-toggle'))
    await waitFor(() => expect(taskReads()).toBe(2))
    expect(screen.getByTestId('project-task-t3')).toBe(mine)

    reread.release({ status: 200, body: page([theirs('t1'), projectTask('t3')]) })
    await waitFor(() => expect(screen.queryByTestId('project-task-t2')).toBeNull())
    expect(screen.getByTestId('project-task-t3')).toBe(mine)
    expect(mine.isConnected).toBe(true)
    expect(within(mine).getByRole('status').textContent).toBe('2 h recorded on Task t3.')
  })

  it('still ends in the card’s own error when the re-read fails, instead of showing rows as if they were current', async () => {
    let reads = 0
    apiFetch.mockImplementation(
      fakeApi({
        'GET /tasks': () => {
          reads += 1
          return reads === 1
            ? { status: 200, body: page([projectTask('t1'), theirs('t2')]) }
            : problem(500, undefined, {}, 'Database is down')
        },
        'POST /activities/t2/complete': () => ({ status: 200, body: theirs('t2') }),
      }),
    )
    render(<TasksCard project={projectDetail()} canManage currentUserId="u-ada" />)

    fireEvent.click(await screen.findByTestId('project-task-t2-toggle'))

    expect((await screen.findByTestId('project-tasks-error')).textContent).toContain('Database is down')
    expect(screen.queryByTestId('project-task-t1')).toBeNull()
  })
})

describe('what the list is remembered under', () => {
  it('shows the loading state, not the Open rows, while the Done tab is read for the first time', async () => {
    const done = deferred()
    apiFetch.mockImplementation(
      fakeApi({
        'GET /tasks': (url) =>
          url.searchParams.get('status') === 'done'
            ? done.answer.then((answer) => answer)
            : { status: 200, body: page([projectTask('t1')]) },
      }),
    )
    render(<TasksCard project={projectDetail()} canManage currentUserId="u-ada" />)
    await screen.findByTestId('project-task-t1')

    fireEvent.click(screen.getByRole('tab', { name: 'Done' }))

    expect(await screen.findByTestId('projects-loading')).toBeTruthy()
    expect(screen.queryByTestId('project-task-t1')).toBeNull()
    done.release({ status: 200, body: page([]) })
    await screen.findByText('No tasks done yet')
  })

  it('shows the loading state, not the first page’s rows, while the second page is read for the first time', async () => {
    const second = deferred()
    apiFetch.mockImplementation(
      fakeApi({
        'GET /tasks': (url) =>
          url.searchParams.get('page') === '2'
            ? second.answer.then((answer) => answer)
            : { status: 200, body: page([projectTask('t1')], 30) },
      }),
    )
    render(<TasksCard project={projectDetail()} canManage currentUserId="u-ada" />)
    await screen.findByTestId('project-task-t1')

    fireEvent.click(screen.getByRole('button', { name: 'Next' }))

    expect(await screen.findByTestId('projects-loading')).toBeTruthy()
    expect(screen.queryByTestId('project-task-t1')).toBeNull()
    second.release({ status: 200, body: page([projectTask('t26')], 30, 2) })
    await screen.findByTestId('project-task-t26')
  })

  it('shows the loading state, not another project’s rows, when the card is given another project', async () => {
    const other = deferred()
    apiFetch.mockImplementation(
      fakeApi({
        'GET /tasks': (url) =>
          url.searchParams.get('projectId') === 'p2'
            ? other.answer.then((answer) => answer)
            : { status: 200, body: page([projectTask('t1')]) },
      }),
    )
    const { rerender } = render(<TasksCard project={projectDetail()} canManage currentUserId="u-ada" />)
    await screen.findByTestId('project-task-t1')

    rerender(<TasksCard project={projectDetail({ id: 'p2' })} canManage currentUserId="u-ada" />)

    expect(await screen.findByTestId('projects-loading')).toBeTruthy()
    expect(screen.queryByTestId('project-task-t1')).toBeNull()
    other.release({ status: 200, body: page([projectTask('x1')]) })
    await screen.findByTestId('project-task-x1')
  })
})
