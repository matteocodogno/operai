/**
 * @vitest-environment jsdom
 *
 * MyTasksPage (specs/20261110-activities US-7, AC-7.2 – AC-7.5): the caller's project tasks and
 * pre-sales tasks in the one order the server sent, a Pre-sales badge on every
 * CRM task, done / not done only where the row's own `may.complete` says so,
 * "Open in CRM" built from the company id, and the notice when the CRM could not
 * be reached. Rendered through the app's real router and ProjectsShell against a
 * fake activities-api.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { RouterProvider } from '@tanstack/react-router'
import ProjectsShell from '../components/ProjectsShell'
import { createAppRouter } from '../router'
import { fakeApi, personRef, problem, projectTask, scope } from '../test-support/fakeApi'
import type { FakeHandler } from '../test-support/fakeApi'

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock('shell/session', () => ({
  apiFetch,
  getProjectsApiBaseUrl: () => 'http://projects-api.test',
  getAuthBaseUrl: () => 'http://auth.test',
  getActivitiesApiBaseUrl: () => 'http://activities-api.test',
  useSession: () => ({ data: { user: { id: 'u-ada', name: 'Ada Lovelace' } } }),
}))

const page = (items: unknown[], extra: Record<string, unknown> = {}) => ({
  items,
  total: items.length,
  page: 1,
  pageSize: 25,
  ...extra,
})

/** A pre-sales task as `GET /tasks?kind=all` returns it: a CRM company, no project. */
const preSalesTask = (id: string, over: Record<string, unknown> = {}, task: Record<string, unknown> = {}) =>
  projectTask(
    id,
    {
      kind: 'pre_sales',
      subject: `Pre-sales ${id}`,
      project: null,
      company: { id: 'c9', name: 'Globex AG' },
      deal: { id: 'd1', title: 'Website' },
      ...over,
    },
    task,
  )

const renderPage = async (routes: Record<string, FakeHandler>) => {
  apiFetch.mockImplementation(fakeApi({ 'GET /scope': () => ({ status: 200, body: scope() }), ...routes }))
  window.history.pushState(null, '', '/tasks')
  render(<RouterProvider router={createAppRouter(undefined, ProjectsShell)} />)
  await screen.findByRole('heading', { level: 2, name: 'My tasks' })
}

const taskReads = () =>
  apiFetch.mock.calls.map(([input]) => new URL(String(input))).filter((url) => url.pathname === '/tasks')

const posts = () =>
  apiFetch.mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST')
    .map(([input]) => new URL(String(input)))

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

describe('navigation', () => {
  it('adds Projects and My tasks tabs to the tool frame; My tasks is current at /tasks', async () => {
    await renderPage({ 'GET /tasks': () => ({ status: 200, body: page([]) }) })
    const nav = screen.getByRole('navigation', { name: 'Projects sections' })
    expect(within(nav).getByRole('link', { name: 'Projects' }).getAttribute('aria-current')).toBeNull()
    expect(within(nav).getByRole('link', { name: 'My tasks' }).getAttribute('aria-current')).toBe('page')
  })
})

describe('the mixed list', () => {
  it('asks for the caller’s open tasks of both kinds and renders them in the server order, pre-sales badged', async () => {
    await renderPage({
      'GET /tasks': () => ({
        status: 200,
        body: page([projectTask('p1'), preSalesTask('s1'), projectTask('p2')]),
      }),
    })

    const rows = await screen.findAllByTestId(/^my-task-[ps]\d$/)
    expect(rows.map((row) => row.getAttribute('data-testid'))).toEqual(['my-task-p1', 'my-task-s1', 'my-task-p2'])
    expect(Object.fromEntries(taskReads()[0]!.searchParams)).toEqual({
      kind: 'all',
      assignee: 'me',
      status: 'open',
      page: '1',
      pageSize: '25',
    })
    expect(within(rows[1]!).getByText('Pre-sales')).toBeTruthy()
    expect(within(rows[0]!).queryByText('Pre-sales')).toBeNull()
    expect(within(rows[2]!).queryByText('Pre-sales')).toBeNull()
  })

  it('a project row links to its project, built from the id', async () => {
    await renderPage({ 'GET /tasks': () => ({ status: 200, body: page([projectTask('p1')]) }) })
    const row = await screen.findByTestId('my-task-p1')
    const link = within(row).getByRole('link', { name: 'Intranet' })
    expect(link.getAttribute('href')).toBe('/p1')
    expect(row.textContent).toContain('Project: Intranet')
  })

  it('a pre-sales row names its company and opens it in the CRM through a link named for the task (AC-7.3)', async () => {
    await renderPage({ 'GET /tasks': () => ({ status: 200, body: page([preSalesTask('s1')]) }) })
    const row = await screen.findByTestId('my-task-s1')
    expect(row.textContent).toContain('Company: Globex AG')
    const link = within(row).getByRole('link', { name: 'Open in CRM: Pre-sales s1' })
    expect(link.getAttribute('href')).toBe('/crm/companies/c9')
  })

  it('a pre-sales task about a deal links straight to the deal in the CRM, built from the id', async () => {
    await renderPage({
      'GET /tasks': () => ({
        status: 200,
        body: page([preSalesTask('t1'), preSalesTask('t2', { deal: { id: 'd/2', title: null } }), preSalesTask('t3', { deal: null })]),
      }),
    })
    const link = await screen.findByTestId('my-task-t1-deal')
    expect(link.textContent).toBe('Website')
    expect(link.getAttribute('href')).toBe('/crm/deals/d1')
    expect(screen.getByTestId('my-task-t2-deal').getAttribute('href')).toBe('/crm/deals/d%2F2')
    expect(screen.getByTestId('my-task-t2-deal').textContent).toBe('Unknown deal')
    expect(screen.queryByTestId('my-task-t3-deal')).toBeNull()
  })

  it('a pre-sales row has no Edit or Delete, whatever its may flags (AC-7.3)', async () => {
    await renderPage({ 'GET /tasks': () => ({ status: 200, body: page([preSalesTask('s1')]) }) })
    const row = await screen.findByTestId('my-task-s1')
    expect(within(row).queryByRole('button', { name: /edit|delete/i })).toBeNull()
    expect(within(row).getByRole('button', { name: 'Mark done' })).toBeTruthy()
  })

  it('a pre-sales row whose company name is gone still opens it by id and says the name is unknown', async () => {
    await renderPage({
      'GET /tasks': () => ({ status: 200, body: page([preSalesTask('s1', { company: { id: 'c9', name: null } })]) }),
    })
    const row = await screen.findByTestId('my-task-s1')
    expect(row.textContent).toContain('Company: Unknown company')
    expect(
      within(row)
        .getByRole('link', { name: /Open in CRM/ })
        .getAttribute('href'),
    ).toBe('/crm/companies/c9')
  })

  it('encodes the company id in the CRM link', async () => {
    await renderPage({
      'GET /tasks': () => ({
        status: 200,
        body: page([preSalesTask('s1', { company: { id: 'a/b c', name: 'X' } })]),
      }),
    })
    const row = await screen.findByTestId('my-task-s1')
    expect(
      within(row)
        .getByRole('link', { name: /Open in CRM/ })
        .getAttribute('href'),
    ).toBe('/crm/companies/a%2Fb%20c')
  })

  it('a pre-sales row with no company at all has no CRM link rather than a broken one', async () => {
    await renderPage({ 'GET /tasks': () => ({ status: 200, body: page([preSalesTask('s1', { company: null, deal: null })]) }) })
    const row = await screen.findByTestId('my-task-s1')
    // Ada is the assignee, so the row also carries Record hours' fallback link to My hours (specs/20261116-record-hours-in-place):
    // it is the CRM link that must not exist.
    expect(within(row).queryByTestId('my-task-s1-crm')).toBeNull()
    expect(
      within(row)
        .queryAllByRole('link')
        .filter((link) => link.getAttribute('href')?.startsWith('/crm')),
    ).toEqual([])
  })
})

describe('done and not done', () => {
  it('offers the toggle only where the row’s own may.complete says so (participant-only rows are read-only)', async () => {
    await renderPage({
      'GET /tasks': () => ({
        status: 200,
        body: page([
          projectTask('p1'),
          projectTask('p2', { may: { edit: false, delete: false, complete: false } }),
          preSalesTask('s1', { may: { edit: true, delete: true, complete: false } }),
        ]),
      }),
    })
    await screen.findByTestId('my-task-p1')
    expect(within(screen.getByTestId('my-task-p1')).getByRole('button', { name: 'Mark done' })).toBeTruthy()
    expect(within(screen.getByTestId('my-task-p2')).queryByRole('button', { name: /Mark/ })).toBeNull()
    expect(within(screen.getByTestId('my-task-s1')).queryByRole('button', { name: /Mark/ })).toBeNull()
  })

  it('marks a pre-sales task done, confirms, and reads the list again', async () => {
    let done = false
    await renderPage({
      'GET /tasks': () => ({ status: 200, body: page(done ? [] : [preSalesTask('s1')]) }),
      'POST /activities/s1/complete': () => {
        done = true
        return { status: 200, body: preSalesTask('s1', {}, { completedAt: '2026-11-11T09:00:00.000Z' }) }
      },
    })
    const row = await screen.findByTestId('my-task-s1')
    fireEvent.click(within(row).getByRole('button', { name: 'Mark done' }))

    expect(await screen.findByText('Task marked done.')).toBeTruthy()
    await waitFor(() => expect(screen.queryByTestId('my-task-s1')).toBeNull())
    expect(screen.getByText('Nothing on your list')).toBeTruthy()
    expect(posts()[0]?.pathname).toBe('/activities/s1/complete')
  })

  it('reopens a done task from the Done tab', async () => {
    await renderPage({
      'GET /tasks': (url) =>
        url.searchParams.get('status') === 'done'
          ? {
              status: 200,
              body: page([
                preSalesTask(
                  's2',
                  {},
                  { completedAt: '2026-11-05T10:00:00.000Z', completedBy: personRef('u-ada', 'Ada Lovelace') },
                ),
              ]),
            }
          : { status: 200, body: page([]) },
      'POST /activities/s2/reopen': () => ({ status: 200, body: preSalesTask('s2') }),
    })
    fireEvent.click(await screen.findByRole('tab', { name: 'Done' }))
    const row = await screen.findByTestId('my-task-s2')
    fireEvent.click(within(row).getByRole('button', { name: 'Mark not done' }))
    expect(await screen.findByText('Task marked not done.')).toBeTruthy()
    expect(posts()[0]?.pathname).toBe('/activities/s2/reopen')
  })

  it('a refused toggle shows its reason on that row and reads the list again for fresh flags', async () => {
    await renderPage({
      'GET /tasks': () => ({ status: 200, body: page([preSalesTask('s1')]) }),
      'POST /activities/s1/complete': () => problem(403, 'forbidden'),
    })
    const row = await screen.findByTestId('my-task-s1')
    fireEvent.click(within(row).getByRole('button', { name: 'Mark done' }))
    await waitFor(() => expect(taskReads().length).toBe(2))
    // The reload replaces the row; the reason belongs to the task, so it is on the new row.
    await waitFor(() =>
      expect(within(screen.getByTestId('my-task-s1')).getByRole('alert').textContent).toBe(
        'You can no longer change this task.',
      ),
    )
  })
})

describe('Done tab', () => {
  it('asks for status=done and says so when there is nothing', async () => {
    await renderPage({
      'GET /tasks': (url) => ({
        status: 200,
        body: page(url.searchParams.get('status') === 'done' ? [] : [projectTask('p1')]),
      }),
    })
    await screen.findByTestId('my-task-p1')
    fireEvent.click(screen.getByRole('tab', { name: 'Done' }))
    expect(await screen.findByText('No finished tasks yet')).toBeTruthy()
    expect(taskReads().at(-1)?.searchParams.get('status')).toBe('done')
  })
})

describe('when the CRM cannot be reached (AC-7.5)', () => {
  it('still shows the project tasks and announces that pre-sales tasks could not be loaded, with Retry', async () => {
    await renderPage({
      'GET /tasks': () => ({ status: 200, body: page([projectTask('p1')], { unavailable: ['crm'] }) }),
    })
    expect(await screen.findByTestId('my-task-p1')).toBeTruthy()
    const banner = screen.getByTestId('my-tasks-unavailable')
    expect(banner.getAttribute('role')).toBe('status')
    expect(banner.textContent).toContain('Pre-sales tasks could not be loaded')
    fireEvent.click(within(banner).getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(taskReads().length).toBe(2))
  })

  it('says nothing when the list simply holds no pre-sales tasks (AC-7.4: a caller who cannot read the CRM)', async () => {
    await renderPage({ 'GET /tasks': () => ({ status: 200, body: page([projectTask('p1')]) }) })
    await screen.findByTestId('my-task-p1')
    expect(screen.queryByTestId('my-tasks-unavailable')).toBeNull()
  })

  it('shows the notice above the empty state when nothing else is left', async () => {
    await renderPage({ 'GET /tasks': () => ({ status: 200, body: page([], { unavailable: ['crm'] }) }) })
    expect(await screen.findByTestId('my-tasks-unavailable')).toBeTruthy()
    expect(screen.getByText('Nothing on your list')).toBeTruthy()
  })
})

describe('states', () => {
  it('a failed load is a warning banner with Retry', async () => {
    let reads = 0
    await renderPage({
      'GET /tasks': () => {
        reads += 1
        return reads === 1 ? problem(500, undefined, {}, 'Boom') : { status: 200, body: page([projectTask('p1')]) }
      },
    })
    const banner = await screen.findByTestId('my-tasks-error')
    expect(banner.textContent).toContain('Boom')
    fireEvent.click(within(banner).getByRole('button', { name: 'Retry' }))
    expect(await screen.findByTestId('my-task-p1')).toBeTruthy()
  })

  it('a 403 is the permission-denied panel', async () => {
    await renderPage({ 'GET /tasks': () => problem(403, 'forbidden') })
    expect(await screen.findByText('You do not have access to this')).toBeTruthy()
  })

  it('a 503 maintenance says tasks are paused', async () => {
    await renderPage({ 'GET /tasks': () => problem(503, 'maintenance') })
    expect(await screen.findByText('Tasks are paused')).toBeTruthy()
  })

  it('pages with Pagination past 25 rows', async () => {
    await renderPage({
      'GET /tasks': () => ({ status: 200, body: { items: [projectTask('p1')], total: 40, page: 1, pageSize: 25 } }),
    })
    await screen.findByTestId('my-task-p1')
    expect(screen.getByTestId('my-tasks-pagination')).toBeTruthy()
  })
})
