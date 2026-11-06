/**
 * @vitest-environment jsdom
 *
 * ProjectsPage (AC-1.1, AC-1.4, AC-4.4): the AC-1.4 columns, the filters reaching
 * the query string, pagination, the states, and "New project" only for a holder
 * of manage projects. Rendered through the app's real router against a fake
 * projects-api; the create form itself is covered by ProjectFormDialog.test.tsx.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { RouterProvider } from '@tanstack/react-router'
import { createAppRouter } from '../router'
import { ADA, fakeApi, page, problem, projectDetail, projectSummary, scope } from '../test-support/fakeApi'
import type { FakeHandler } from '../test-support/fakeApi'
import { scopeRoot } from '../test-support/scopeRoot'
import type { Scope } from '../lib/types'

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock('shell/session', () => ({
  apiFetch,
  getProjectsApiBaseUrl: () => 'http://projects-api.test',
  getAuthBaseUrl: () => 'http://auth.test',
  useSession: () => ({ data: { user: { id: 'u-ada', name: 'Ada Lovelace' } } }),
}))

const BOB = { id: 'u-bob', name: 'Bob Builder', email: 'bob@welld.ch', entity: 'welld_ch' }
const BOB_PM = { id: 'u-bob', name: 'Bob Builder', deleted: false }
const directory =
  (users = [BOB]): FakeHandler =>
  () => ({ status: 200, body: { users } })

const renderPage = async (routes: Record<string, FakeHandler>, callerScope: Scope = scope()) => {
  apiFetch.mockImplementation(
    fakeApi({
      'GET /authz/users/directory': directory(),
      'GET /project-managers': () => ({ status: 200, body: { items: [] } }),
      ...routes,
    }),
  )
  window.history.pushState(null, '', '/')
  render(<RouterProvider router={createAppRouter(undefined, scopeRoot(callerScope))} />)
  await screen.findByTestId('projects-page')
}

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

const projectsUrls = () =>
  apiFetch.mock.calls.map(([input]) => new URL(String(input))).filter((url) => url.pathname === '/projects')
const lastQuery = () => Object.fromEntries(projectsUrls().at(-1)!.searchParams)

describe('ProjectsPage list (AC-1.4)', () => {
  it('shows name, type, state, company, project manager and entity of each project', async () => {
    await renderPage({
      'GET /projects': () => ({ status: 200, body: page([projectSummary()]) }),
    })
    const table = await screen.findByTestId('projects-table')
    const row = within(table)
      .getByRole('rowheader', { name: /Intranet/ })
      .closest('tr')!
    expect(within(row).getByRole('link', { name: 'Intranet' }).getAttribute('href')).toBe('/p1')
    expect(row.textContent).toContain('Time & material')
    expect(row.textContent).toContain('Active')
    expect(row.textContent).toContain('Acme SA')
    expect(row.textContent).toContain('Ada Lovelace (You)')
    expect(row.textContent).toContain('wellD CH')
    expect(screen.getByTestId('projects-pagination-status').textContent).toBe('Page 1 of 1 — showing 1–1 of 1')
  })

  it('shows the company of a SaaS project like any client project (D40), and "Internal" for an internal one', async () => {
    await renderPage({
      'GET /projects': () => ({
        status: 200,
        body: page([
          projectSummary({ id: 's1', name: 'Sentinel', type: 'saas', company: { id: 'c9', name: 'Beta AG' } }),
          projectSummary({ id: 's0', name: 'Newcomer', type: 'saas', company: { id: 'c8', name: null } }),
          projectSummary({ id: 'i1', name: 'Ops tooling', type: 'internal', company: null }),
        ]),
      }),
    })
    const table = await screen.findByTestId('projects-table')
    const companyCell = (name: string) =>
      within(within(table).getByRole('rowheader', { name }).closest('tr')!).getByTestId('projects-company')
    expect(companyCell('Sentinel').textContent).toBe('Beta AG')
    expect(companyCell('Newcomer').textContent).toBe('Company unavailable')
    expect(companyCell('Ops tooling').textContent).toBe('Internal')
  })

  it('reads "Awaiting project manager" where a project has none yet, never a blank (AC-4.5)', async () => {
    await renderPage({
      'GET /projects': () => ({
        status: 200,
        body: page([
          projectSummary({ id: 'w1', name: 'Fresh from a deal', projectManager: null, awaitingProjectManager: true }),
          projectSummary({ id: 'p1', name: 'Intranet' }),
        ]),
      }),
    })
    const table = await screen.findByTestId('projects-table')
    expect(
      within(within(table).getByRole('rowheader', { name: 'Fresh from a deal' }).closest('tr')!).getByText(
        'Awaiting project manager',
      ),
    ).not.toBeNull()
    expect(
      within(within(table).getByRole('rowheader', { name: 'Intranet' }).closest('tr')!).queryByText(
        'Awaiting project manager',
      ),
    ).toBeNull()
  })

  it('says so when the CRM could not name a client project’s company', async () => {
    await renderPage({
      'GET /projects': () => ({
        status: 200,
        body: page([projectSummary({ company: { id: 'c1', name: null } })]),
      }),
    })
    const table = await screen.findByTestId('projects-table')
    expect(within(table).getByTestId('projects-company').textContent).toBe('Company unavailable')
  })

  it('asks for the first page and nothing else, the server sorting by name', async () => {
    await renderPage({ 'GET /projects': () => ({ status: 200, body: page([]) }) })
    await screen.findByText('No projects yet')
    expect(lastQuery()).toEqual({ page: '1' })
  })

  it('search, type and state reach the query, and a new filter goes back to page 1', async () => {
    await renderPage({
      'GET /projects': (url) => ({
        status: 200,
        body: page([projectSummary()], 60, Number(url.searchParams.get('page') ?? 1)),
      }),
    })
    await screen.findByTestId('projects-table')
    fireEvent.click(screen.getByTestId('projects-pagination-next'))
    await waitFor(() => expect(lastQuery()).toEqual({ page: '2' }))

    fireEvent.change(screen.getByLabelText(/Search/), { target: { value: 'koo' } })
    await waitFor(() => expect(lastQuery()).toEqual({ page: '1', q: 'koo' }))
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'saas' } })
    await waitFor(() => expect(lastQuery()).toEqual({ page: '1', q: 'koo', type: 'saas' }))
    fireEvent.change(screen.getByLabelText('State'), { target: { value: 'on_hold' } })
    await waitFor(() => expect(lastQuery()).toEqual({ page: '1', q: 'koo', type: 'saas', state: 'on_hold' }))
  })

  it('filters by project manager, picked from GET /project-managers, and never reads the user directory', async () => {
    await renderPage({
      'GET /project-managers': () => ({ status: 200, body: { items: [ADA, BOB_PM] } }),
      'GET /projects': () => ({ status: 200, body: page([projectSummary()]) }),
    })
    await screen.findByTestId('projects-table')
    const select = await screen.findByLabelText('Project manager')
    await waitFor(() => expect(within(select).getAllByRole('option').length).toBe(4))
    expect(
      within(select)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Any', 'None yet', 'Ada Lovelace (You)', 'Bob Builder'])
    fireEvent.change(select, { target: { value: 'u-bob' } })
    await waitFor(() => expect(lastQuery()).toEqual({ page: '1', projectManagerId: 'u-bob' }))
    fireEvent.change(select, { target: { value: '' } })
    await waitFor(() => expect(lastQuery()).toEqual({ page: '1' }))
    // A reader without `project:manage` cannot read the directory; this filter must not need it (AC-1.4).
    expect(apiFetch.mock.calls.some(([input]) => new URL(String(input)).pathname === '/authz/users/directory')).toBe(
      false,
    )
  })

  it('offers "None yet" for the projects awaiting a project manager, asked as projectManagerId=none (AC-4.5)', async () => {
    await renderPage({
      'GET /project-managers': () => ({ status: 200, body: { items: [ADA] } }),
      'GET /projects': () => ({ status: 200, body: page([projectSummary()]) }),
    })
    await screen.findByTestId('projects-table')
    const select = await screen.findByLabelText('Project manager')
    expect(
      within(select)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toContain('None yet')
    fireEvent.change(select, { target: { value: 'none' } })
    await waitFor(() => expect(lastQuery()).toEqual({ page: '1', projectManagerId: 'none' }))
    fireEvent.change(select, { target: { value: '' } })
    await waitFor(() => expect(lastQuery()).toEqual({ page: '1' }))
  })

  it('offers "None yet" even when the project managers cannot be loaded', async () => {
    await renderPage({
      'GET /project-managers': () => problem(500, undefined, {}, 'boom'),
      'GET /projects': () => ({ status: 200, body: page([projectSummary()]) }),
    })
    await screen.findByTestId('projects-table')
    expect(
      within(screen.getByLabelText('Project manager'))
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Any', 'None yet'])
  })

  it('has no "Only my projects" fallback: every reader gets the same project-manager filter', async () => {
    await renderPage({
      'GET /authz/users/directory': () => problem(403, 'forbidden'),
      'GET /project-managers': () => ({ status: 200, body: { items: [ADA] } }),
      'GET /projects': () => ({ status: 200, body: page([projectSummary()]) }),
    })
    const select = await screen.findByLabelText('Project manager')
    await waitFor(() => expect(within(select).getAllByRole('option').length).toBe(3))
    expect(screen.queryByLabelText('Only my projects')).toBeNull()
  })

  it('still lists, and says the filter is empty, when the project managers cannot be loaded', async () => {
    await renderPage({
      'GET /project-managers': () => problem(500, undefined, {}, 'boom'),
      'GET /projects': () => ({ status: 200, body: page([projectSummary()]) }),
    })
    expect(await screen.findByTestId('projects-table')).not.toBeNull()
    expect(await screen.findByText('The project managers could not be loaded.')).not.toBeNull()
    // Only the fixed choices: "Any" and "None yet".
    expect(within(screen.getByLabelText('Project manager')).getAllByRole('option').length).toBe(2)
  })
})

describe('ProjectsPage states', () => {
  it('an empty module invites a manager to create the first project, and a reader to wait', async () => {
    await renderPage({ 'GET /projects': () => ({ status: 200, body: page([]) }) }, scope({ manage: ['welld_ch'] }))
    expect(await screen.findByText('No projects yet')).not.toBeNull()
    expect(screen.getByText(/Create the first project/)).not.toBeNull()
    cleanup()
    await renderPage({ 'GET /projects': () => ({ status: 200, body: page([]) }) })
    expect(await screen.findByText('No projects yet')).not.toBeNull()
    expect(screen.queryByText(/Create the first project/)).toBeNull()
  })

  it('a search with no match shows the filtered empty state', async () => {
    await renderPage({ 'GET /projects': () => ({ status: 200, body: page([]) }) })
    await screen.findByText('No projects yet')
    fireEvent.change(screen.getByLabelText(/Search/), { target: { value: 'zzz' } })
    expect(await screen.findByText('No projects match these filters')).not.toBeNull()
  })

  it('a failed load shows the retry banner, and Retry loads again', async () => {
    let calls = 0
    await renderPage({
      'GET /projects': () => {
        calls += 1
        return calls === 1 ? problem(500, undefined, {}, 'boom') : { status: 200, body: page([projectSummary()]) }
      },
    })
    expect((await screen.findByTestId('projects-load-error')).textContent).toContain('boom')
    fireEvent.click(screen.getByTestId('projects-load-error-retry'))
    expect(await screen.findByTestId('projects-table')).not.toBeNull()
  })

  it('pages through the API, 25 to a page', async () => {
    await renderPage({
      'GET /projects': (url) => ({
        status: 200,
        body: page([projectSummary()], 30, Number(url.searchParams.get('page') ?? 1)),
      }),
    })
    await screen.findByTestId('projects-table')
    expect(screen.getByTestId('projects-pagination-status').textContent).toBe('Page 1 of 2 — showing 1–25 of 30')
  })
})

describe('New project (AC-4.4)', () => {
  it('is hidden from a caller who manages no entity', async () => {
    await renderPage({ 'GET /projects': () => ({ status: 200, body: page([projectSummary()]) }) })
    await screen.findByTestId('projects-table')
    expect(screen.queryByTestId('projects-new')).toBeNull()
  })

  it('opens the create dialog for a manager, and opens the new project once it is created', async () => {
    await renderPage(
      {
        'GET /projects': () => ({ status: 200, body: page([]) }),
        'POST /projects': () => ({
          status: 201,
          body: { ...projectSummary({ id: 'pNew' }), team: [], purchaseOrder: null, terms: null },
        }),
        'GET /projects/pNew': () => ({ status: 200, body: projectDetail({ id: 'pNew', name: 'Ops tooling' }) }),
      },
      scope({ manage: ['welld_ch'] }),
    )
    await screen.findByText('No projects yet')
    fireEvent.click(screen.getByTestId('projects-new'))
    const dialog = await screen.findByRole('dialog', { name: 'New project' })
    fireEvent.change(within(dialog).getByLabelText(/^Name/), { target: { value: 'Ops tooling' } })
    fireEvent.change(within(dialog).getByLabelText(/^Type/), { target: { value: 'internal' } })
    fireEvent.click(within(dialog).getByTestId('projects-form-submit'))
    expect((await screen.findByTestId('project-detail-page')).getAttribute('data-project-id')).toBe('pNew')
  })
})
