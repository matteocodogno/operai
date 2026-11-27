/**
 * @vitest-environment jsdom
 *
 * Component tests for TeamsPage — S1 (specs/20261126-teams T4: AC-1.1, AC-1.2, AC-1.4, AC-1.7, AC-3.3).
 *
 * `../lib/adminApi` is mocked at the module level (as DepartmentsPage.test.tsx does); the page runs inside a real,
 * minimal TanStack Router, because its team names are real links and a created team is navigated to.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router'
import TeamsPage from './TeamsPage'
import type { TeamDetail, TeamSummary } from '../lib/adminApi'
import { clearFlash, peekFlash } from '../lib/flash'

vi.mock('../lib/adminApi', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/adminApi')>()
  return { ...original, listTeams: vi.fn(), createTeam: vi.fn() }
})

import * as adminApi from '../lib/adminApi'
import { ApiError } from '../lib/adminApi'

const team = (over: Partial<TeamSummary> & { id: string; name: string }): TeamSummary => ({
  description: null,
  archived: false,
  activeMemberCount: 0,
  version: 1,
  ...over,
})

const backend = team({ id: 't-backend', name: 'Backend', activeMemberCount: 12 })
const design = team({ id: 't-design', name: 'Design', activeMemberCount: 1 })
const legacy = team({ id: 't-legacy', name: 'Legacy platform', archived: true, activeMemberCount: 3 })

const detailOf = (summary: TeamSummary): TeamDetail => ({
  ...summary,
  createdAt: '2026-11-26T09:00:00.000Z',
  updatedAt: '2026-11-26T09:00:00.000Z',
  members: [],
})

const pending = <T,>(): Promise<T> => new Promise(() => {})

const renderPage = async () => {
  window.history.pushState(null, '', '/teams')
  const rootRoute = createRootRoute({ component: Outlet })
  const list = createRoute({ getParentRoute: () => rootRoute, path: '/teams', component: TeamsPage })
  const detail = createRoute({
    getParentRoute: () => rootRoute,
    path: '/teams/$id',
    component: () => <p data-testid="team-detail-stub">detail</p>,
  })
  const router = createRouter({ routeTree: rootRoute.addChildren([list, detail]) })
  render(<RouterProvider router={router} />)
  await screen.findByTestId('admin-teams-page')
  return router
}

const rowNames = () =>
  within(screen.getByTestId('teams-table'))
    .getAllByRole('rowheader')
    .map((cell) => cell.textContent)

const search = (text: string) => fireEvent.change(screen.getByTestId('teams-search'), { target: { value: text } })
const show = (value: 'active' | 'archived' | 'all') =>
  fireEvent.change(screen.getByTestId('teams-show'), { target: { value } })

beforeEach(() => {
  vi.mocked(adminApi.listTeams).mockResolvedValue([backend, design, legacy])
})

afterEach(() => {
  cleanup()
  clearFlash('team:t-new')
  vi.clearAllMocks()
  window.history.pushState(null, '', '/')
})

describe('TeamsPage states', () => {
  it('shows a skeleton and announces the load while the list is in flight', async () => {
    vi.mocked(adminApi.listTeams).mockReturnValue(pending())
    await renderPage()

    expect(screen.getByTestId('skeleton-list-rows')).not.toBeNull()
    expect(screen.getByText('Loading teams…')).not.toBeNull()
    expect(screen.queryByTestId('teams-table')).toBeNull()
  })

  it('has a heading, the description that says a team is not a role, and the one primary action', async () => {
    await renderPage()

    expect(screen.getByRole('heading', { level: 2, name: 'Teams' })).not.toBeNull()
    expect(
      screen.getByText('Groups of people who work together. A team grants no permissions and is not a role.'),
    ).not.toBeNull()
    expect(screen.getByTestId('new-team-button').textContent).toBe('New team')
  })

  it('an unreadable list is a warning with the problem detail and a Retry that reads again', async () => {
    vi.mocked(adminApi.listTeams).mockRejectedValueOnce(
      new ApiError({ type: 't', title: 'Server error', status: 500, detail: 'Database is down' }),
    )
    await renderPage()

    expect((await screen.findByTestId('error-banner')).textContent).toContain('Database is down')

    fireEvent.click(screen.getByTestId('error-banner-retry'))

    await screen.findByTestId('teams-table')
    expect(adminApi.listTeams).toHaveBeenCalledTimes(2)
  })

  it('a failure with no problem body says "Could not load teams."', async () => {
    vi.mocked(adminApi.listTeams).mockRejectedValueOnce(new TypeError('network'))
    await renderPage()

    expect((await screen.findByTestId('error-banner')).textContent).toContain('Could not load teams.')
  })

  it('a 403 (admin access revoked mid-session) replaces the list with the permission-denied state', async () => {
    vi.mocked(adminApi.listTeams).mockRejectedValueOnce(new ApiError({ type: 't', title: 'Forbidden', status: 403 }))
    await renderPage()

    expect(await screen.findByTestId('permission-denied')).not.toBeNull()
    expect(screen.queryByTestId('teams-table')).toBeNull()
    expect(screen.queryByTestId('error-banner')).toBeNull()
  })

  it('no team at all: the empty panel points at New team', async () => {
    vi.mocked(adminApi.listTeams).mockResolvedValue([])
    await renderPage()

    const panel = await screen.findByTestId('teams-empty-state')
    expect(panel.textContent).toContain('No teams yet')
    expect(panel.textContent).toContain('Create a team with “New team”')
    expect(screen.queryByTestId('teams-table')).toBeNull()
  })

  it('every team archived and nothing typed: "No active teams" says how to see them', async () => {
    vi.mocked(adminApi.listTeams).mockResolvedValue([legacy])
    await renderPage()

    const panel = await screen.findByTestId('teams-no-active')
    expect(panel.textContent).toContain('No active teams')
    expect(panel.textContent).toContain('Show archived or all teams')

    show('all')
    expect(rowNames()).toEqual(['Legacy platform'])
    expect(screen.queryByTestId('teams-no-active')).toBeNull()
  })
})

describe('TeamsPage list (AC-1.4)', () => {
  it('opens on Active teams and shows only the active ones, in the server order', async () => {
    await renderPage()
    await screen.findByTestId('teams-table')

    expect((screen.getByTestId('teams-show') as HTMLSelectElement).value).toBe('active')
    expect(rowNames()).toEqual(['Backend', 'Design'])
  })

  it('offers Active, Archived and All teams, and each shows its own', async () => {
    await renderPage()
    await screen.findByTestId('teams-table')

    expect(
      within(screen.getByTestId('teams-show'))
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Active teams', 'Archived teams', 'All teams'])
    show('archived')
    expect(rowNames()).toEqual(['Legacy platform'])
    show('all')
    expect(rowNames()).toEqual(['Backend', 'Design', 'Legacy platform'])
    show('active')
    expect(rowNames()).toEqual(['Backend', 'Design'])
  })

  it('searches a part of the name, ignoring case, within the chosen state', async () => {
    await renderPage()
    await screen.findByTestId('teams-table')

    search('BACK')
    expect(rowNames()).toEqual(['Backend'])

    search('  dEsI ')
    expect(rowNames()).toEqual(['Design'])

    // Archived teams are found only once the filter lets them in.
    search('platform')
    expect(screen.queryByTestId('teams-table')).toBeNull()
    show('all')
    expect(rowNames()).toEqual(['Legacy platform'])
  })

  it('treats the text literally: regex and wildcard characters match nothing special', async () => {
    await renderPage()
    await screen.findByTestId('teams-table')

    search('.*')
    expect(screen.getByTestId('teams-no-match')).not.toBeNull()
    search('%')
    expect(screen.getByTestId('teams-no-match')).not.toBeNull()
  })

  it('a search that matches nothing says so, and clearing it brings the rows back', async () => {
    await renderPage()
    await screen.findByTestId('teams-table')

    search('zzz')

    const panel = screen.getByTestId('teams-no-match')
    expect(panel.textContent).toContain('No teams match')
    expect(panel.textContent).toContain('Change the search or the filter.')
    expect(screen.queryByTestId('teams-table')).toBeNull()

    search('')
    expect(rowNames()).toEqual(['Backend', 'Design'])
  })

  it('Archived with no archived team is "No teams match", not "No active teams"', async () => {
    vi.mocked(adminApi.listTeams).mockResolvedValue([backend])
    await renderPage()
    await screen.findByTestId('teams-table')

    show('archived')

    expect(screen.getByTestId('teams-no-match')).not.toBeNull()
    expect(screen.queryByTestId('teams-no-active')).toBeNull()
  })

  it('announces the count politely after every filter change, singular included', async () => {
    await renderPage()
    await screen.findByTestId('teams-table')
    const live = screen.getByTestId('teams-count-live')
    expect(live.textContent).toBe('2 teams')
    expect(live.getAttribute('aria-live')).toBe('polite')

    search('design')
    expect(live.textContent).toBe('1 team')
    search('zzz')
    expect(live.textContent).toBe('0 teams')
  })

  it('shows name, active members and state per row, the name opening the team', async () => {
    await renderPage()
    await screen.findByTestId('teams-table')

    const table = screen.getByTestId('teams-table')
    expect(Array.from(table.querySelectorAll('th[scope="col"]')).map((th) => th.textContent)).toEqual(
      expect.arrayContaining(['Name', 'Active members', 'State']),
    )
    const link = screen.getByTestId('team-open-t-backend')
    expect(link.tagName).toBe('A')
    expect(link.getAttribute('href')).toBe('/teams/t-backend')
    expect(link.textContent).toBe('Backend')

    const row = screen.getByText('Backend').closest('tr')!
    expect(within(row).getByText('12')).not.toBeNull()
    expect(screen.getByTestId('team-state-t-backend').textContent).toBe('Active')

    show('archived')
    expect(screen.getByTestId('team-state-t-legacy').textContent).toBe('Archived')
  })

  it('has no delete control anywhere (AC-1.7)', async () => {
    await renderPage()
    await screen.findByTestId('teams-table')
    show('all')

    expect(document.querySelector('[data-testid*="delete"]')).toBeNull()
    expect(screen.queryByRole('button', { name: /delete|elimina/i })).toBeNull()
  })

  it('opening a team goes to its address', async () => {
    const router = await renderPage()
    await screen.findByTestId('teams-table')

    fireEvent.click(screen.getByTestId('team-open-t-design'))

    await screen.findByTestId('team-detail-stub')
    expect(router.state.location.pathname).toBe('/teams/t-design')
  })
})

describe('TeamsPage create (AC-1.1, AC-1.2)', () => {
  const open = async () => {
    const router = await renderPage()
    await screen.findByTestId('teams-table')
    fireEvent.click(screen.getByTestId('new-team-button'))
    await screen.findByTestId('create-team-name-input')
    return router
  }
  const fill = (name: string, description = '') => {
    fireEvent.change(screen.getByTestId('create-team-name-input'), { target: { value: name } })
    fireEvent.change(screen.getByTestId('create-team-description-input'), { target: { value: description } })
  }
  const submit = () => fireEvent.click(screen.getByTestId('create-team-submit'))

  it('creates with the trimmed name, omits a blank description, then opens the new team with a flash', async () => {
    const created = detailOf(team({ id: 't-new', name: 'Platform' }))
    vi.mocked(adminApi.createTeam).mockResolvedValue(created)
    const router = await open()

    fill('Platform')
    submit()

    await screen.findByTestId('team-detail-stub')
    expect(adminApi.createTeam).toHaveBeenCalledTimes(1)
    expect(adminApi.createTeam).toHaveBeenCalledWith({ name: 'Platform' })
    expect(router.state.location.pathname).toBe('/teams/t-new')
    expect(peekFlash('team:t-new')).toBe('Team “Platform” created. Add its members below.')
  })

  it('sends a description when there is one', async () => {
    vi.mocked(adminApi.createTeam).mockResolvedValue(detailOf(team({ id: 't-new', name: 'Platform' })))
    await open()

    fill('Platform', ' Runs the platform ')
    submit()

    await screen.findByTestId('team-detail-stub')
    expect(adminApi.createTeam).toHaveBeenCalledWith({ name: 'Platform', description: 'Runs the platform' })
  })

  it('an invalid form never reaches the network', async () => {
    await open()

    fill('   ')
    submit()

    expect(adminApi.createTeam).not.toHaveBeenCalled()
    expect(screen.getByTestId('create-team-name-error').textContent).toBe('Name is required.')
  })

  it('a name clash names the existing team on the Name field and creates nothing', async () => {
    vi.mocked(adminApi.createTeam).mockRejectedValue(
      new ApiError({
        type: 't',
        title: 'Conflict',
        status: 409,
        code: 'team_name_taken',
        detail: 'A team with this name already exists',
        existingName: 'Backend',
      }),
    )
    const router = await open()

    fill('backend')
    submit()

    const error = await screen.findByTestId('create-team-name-error')
    expect(error.textContent).toBe('A team named “Backend” already exists. Archived teams count too.')
    expect(document.body.textContent).not.toContain('A team with this name already exists')
    expect(screen.queryByTestId('create-team-error')).toBeNull()
    expect(document.activeElement).toBe(screen.getByTestId('create-team-name-input'))
    expect((screen.getByTestId('create-team-name-input') as HTMLInputElement).value).toBe('backend')
    expect(router.state.location.pathname).toBe('/teams')
    expect(peekFlash('team:t-new')).toBeNull()
  })

  it('a second clash for the same name is shown again and takes focus again', async () => {
    vi.mocked(adminApi.createTeam).mockRejectedValue(
      new ApiError({ type: 't', title: 'Conflict', status: 409, code: 'team_name_taken', existingName: 'Backend' }),
    )
    await open()
    fill('backend')
    submit()
    await screen.findByTestId('create-team-name-error')

    screen.getByTestId('create-team-description-input').focus()
    submit()

    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('create-team-name-input')))
    expect(adminApi.createTeam).toHaveBeenCalledTimes(2)
    expect(screen.getByTestId('create-team-name-error').textContent).toContain('“Backend”')
  })

  it('a 409 without existingName is the generic failure: no invented name, no server detail', async () => {
    vi.mocked(adminApi.createTeam).mockRejectedValue(
      new ApiError({
        type: 't',
        title: 'Conflict',
        status: 409,
        code: 'team_name_taken',
        detail: 'English only detail',
      }),
    )
    await open()

    fill('Platform')
    submit()

    const failure = await screen.findByTestId('create-team-error')
    expect(failure.textContent).toContain('Could not create the team.')
    expect(document.body.textContent).not.toContain('English only detail')
    expect(screen.queryByTestId('create-team-name-error')).toBeNull()
    expect((screen.getByTestId('create-team-name-input') as HTMLInputElement).value).toBe('Platform')
  })

  it('any other failure shows the generic message in the dialog and keeps the typed values', async () => {
    vi.mocked(adminApi.createTeam).mockRejectedValue(
      new ApiError({ type: 't', title: 'Server error', status: 500, detail: 'boom' }),
    )
    await open()

    fill('Platform', 'Runs it')
    submit()

    expect((await screen.findByTestId('create-team-error')).textContent).toContain('Could not create the team.')
    expect((screen.getByTestId('create-team-description-input') as HTMLTextAreaElement).value).toBe('Runs it')
    expect(screen.getByTestId('create-team-submit')).not.toBeNull()
  })

  it('a network failure is the same generic message', async () => {
    vi.mocked(adminApi.createTeam).mockRejectedValue(new TypeError('Failed to fetch'))
    await open()

    fill('Platform')
    submit()

    expect((await screen.findByTestId('create-team-error')).textContent).toContain('Could not create the team.')
  })

  it('while the request runs the dialog is busy and a second submit does not send a second request', async () => {
    let settle!: (value: TeamDetail) => void
    vi.mocked(adminApi.createTeam).mockReturnValue(new Promise<TeamDetail>((resolve) => (settle = resolve)))
    await open()
    fill('Platform')

    submit()
    await waitFor(() => expect(screen.getByTestId('create-team-submit').textContent).toBe('Creating…'))
    submit()
    fireEvent.submit(screen.getByTestId('create-team-submit').closest('form')!)

    expect(adminApi.createTeam).toHaveBeenCalledTimes(1)
    settle(detailOf(team({ id: 't-new', name: 'Platform' })))
    await screen.findByTestId('team-detail-stub')
  })

  it('Cancel closes the dialog without creating', async () => {
    await open()

    fireEvent.click(screen.getByTestId('create-team-cancel'))

    expect(screen.queryByTestId('create-team-name-input')).toBeNull()
    expect(adminApi.createTeam).not.toHaveBeenCalled()
  })

  it('the dialog sits beside the page content: no form inside a form in any state', async () => {
    vi.mocked(adminApi.createTeam).mockRejectedValue(
      new ApiError({ type: 't', title: 'Conflict', status: 409, code: 'team_name_taken', existingName: 'Backend' }),
    )
    await open()
    expect(document.querySelectorAll('form form').length).toBe(0)

    fill('backend')
    submit()
    await screen.findByTestId('create-team-name-error')

    expect(document.querySelectorAll('form form').length).toBe(0)
    expect(screen.getByTestId('admin-teams-page').closest('form')).toBeNull()
  })
})
