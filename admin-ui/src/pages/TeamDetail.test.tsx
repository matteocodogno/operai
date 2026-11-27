/**
 * @vitest-environment jsdom
 *
 * Component tests for TeamDetail — S3..S5 (specs/20261126-teams T5: AC-1.5, AC-1.6, AC-1.7, AC-1.8, AC-2.1,
 * AC-2.2, AC-2.3, AC-2.4, AC-3.3).
 *
 * `../lib/adminApi` is mocked at the module level (the real `ApiError`, `isVersionConflict` and `teamNameClash`
 * stay); the page runs inside a real, minimal TanStack Router because it reads its id from the route and links back
 * to the list. The Italian run (dates and copy) is `TeamDetail.it.test.tsx`: the language is read at module load.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router'
import TeamDetailPage from './TeamDetail'
import type { TeamDetail, TeamMemberAdmin, UserSummary } from '../lib/adminApi'
import { clearFlash, setFlash } from '../lib/flash'

vi.mock('../lib/adminApi', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/adminApi')>()
  return {
    ...original,
    getTeam: vi.fn(),
    patchTeam: vi.fn(),
    archiveTeam: vi.fn(),
    restoreTeam: vi.fn(),
    addTeamMember: vi.fn(),
    removeTeamMember: vi.fn(),
    listUsers: vi.fn(),
  }
})

import * as adminApi from '../lib/adminApi'
import { ApiError } from '../lib/adminApi'

const member = (over: Partial<TeamMemberAdmin> & { id: string; name: string }): TeamMemberAdmin => ({
  email: `${over.id}@example.com`,
  deactivated: false,
  addedAt: '2026-11-03T10:30:00.000Z',
  ...over,
})

const ada = member({ id: 'u-ada', name: 'Ada Rossi', email: 'ada@example.com' })
const bruno = member({ id: 'u-bruno', name: 'Bruno Bianchi', email: 'bruno@example.com' })
const gone = member({ id: 'u-gone', name: 'Gina Gone', email: 'gina@example.com', deactivated: true })

const teamOf = (over: Partial<TeamDetail> = {}): TeamDetail => {
  const members = over.members ?? [ada, bruno, gone]
  return {
    id: 't-backend',
    name: 'Backend',
    description: 'Builds the services',
    archived: false,
    activeMemberCount: members.filter((m) => !m.deactivated).length,
    version: 3,
    createdAt: '2026-11-01T12:00:00.000Z',
    updatedAt: '2026-11-02T14:05:00.000Z',
    ...over,
    members,
  }
}

const userRow = (id: string, name: string | null, email: string): UserSummary => ({
  id,
  name,
  email,
  entity: null,
  jobTitle: null,
  roles: [],
  departments: [],
})

const problem = (status: number, code: string, extra: Record<string, unknown> = {}) =>
  new ApiError({ type: 'x', title: 'Problem', status, code, detail: 'English detail only', ...extra })

const pending = <T,>(): Promise<T> => new Promise(() => {})

const renderPage = async (id = 't-backend') => {
  window.history.pushState(null, '', `/teams/${id}`)
  const rootRoute = createRootRoute({ component: Outlet })
  const list = createRoute({
    getParentRoute: () => rootRoute,
    path: '/teams',
    component: () => <p data-testid="teams-list-stub">list</p>,
  })
  const detail = createRoute({ getParentRoute: () => rootRoute, path: '/teams/$id', component: TeamDetailPage })
  const router = createRouter({ routeTree: rootRoute.addChildren([list, detail]) })
  render(<RouterProvider router={router} />)
  return router
}

const renderLoaded = async () => {
  await renderPage()
  await screen.findByTestId('team-members-section')
}

const click = (testId: string) => fireEvent.click(screen.getByTestId(testId))
const noNestedForms = () => expect(document.querySelectorAll('form form')).toHaveLength(0)

/** Types into the member picker and picks the option for `userId`. */
const pickUser = async (text: string, userId: string) => {
  fireEvent.change(screen.getByTestId('team-member-picker-input'), { target: { value: text } })
  fireEvent.click(await screen.findByTestId(`team-member-picker-input-option-${userId}`))
}

beforeEach(() => {
  vi.mocked(adminApi.getTeam).mockResolvedValue(teamOf())
  vi.mocked(adminApi.listUsers).mockResolvedValue({
    items: [userRow('u-carla', 'Carla Verdi', 'carla@example.com'), userRow('u-ada', 'Ada Rossi', 'ada@example.com')],
    page: 1,
    pageSize: 10,
    total: 2,
  })
})

afterEach(() => {
  cleanup()
  clearFlash('team:t-backend')
  vi.resetAllMocks()
  window.history.pushState(null, '', '/')
})

describe('TeamDetail states', () => {
  it('shows a skeleton and announces the load while the team is in flight, with the fallback heading', async () => {
    vi.mocked(adminApi.getTeam).mockReturnValue(pending())
    await renderPage()
    await screen.findByTestId('team-detail-page')
    expect(screen.getByTestId('skeleton-list-rows')).toBeTruthy()
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Team')
    expect(screen.getByText('Loading the team…')).toBeTruthy()
    expect(screen.getByTestId('team-detail-back-link').textContent).toContain('Back to teams')
  })

  it('shows the team: name, state, details and the members card', async () => {
    await renderLoaded()
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Backend')
    expect(screen.getByTestId('team-status').textContent).toContain('Active')
    const details = screen.getByTestId('team-details-section')
    expect(within(details).getByText('Builds the services')).toBeTruthy()
    expect(within(details).getByText(/^01\.11\.2026 \d\d:\d\d$/)).toBeTruthy()
    expect(screen.getByTestId('team-members-count').textContent).toBe('3 of 100 members · 1 deactivated')
  })

  it('says "No description" when there is none', async () => {
    vi.mocked(adminApi.getTeam).mockResolvedValue(teamOf({ description: null }))
    await renderLoaded()
    expect(within(screen.getByTestId('team-details-section')).getByText('No description')).toBeTruthy()
  })

  it('a 404 is the Team not found panel with the back link still in the header', async () => {
    vi.mocked(adminApi.getTeam).mockRejectedValue(problem(404, 'team_not_found'))
    await renderPage()
    const panel = await screen.findByRole('alert')
    expect(within(panel).getByText('Team not found')).toBeTruthy()
    expect(screen.getByTestId('team-detail-back-link')).toBeTruthy()
    expect(screen.queryByTestId('team-members-section')).toBeNull()
  })

  it('a 403 renders the in-place permission-denied panel', async () => {
    vi.mocked(adminApi.getTeam).mockRejectedValue(problem(403, 'forbidden'))
    await renderPage()
    expect(await screen.findByText('You no longer have admin access.')).toBeTruthy()
    expect(screen.queryByTestId('team-edit-details')).toBeNull()
  })

  it('another failure is an error banner, and Retry loads the team again', async () => {
    vi.mocked(adminApi.getTeam).mockRejectedValueOnce(new TypeError('network')).mockResolvedValue(teamOf())
    await renderPage()
    expect((await screen.findByTestId('error-banner')).textContent).toContain('Could not load this team.')
    click('error-banner-retry')
    await screen.findByTestId('team-members-section')
    expect(adminApi.getTeam).toHaveBeenCalledTimes(2)
  })

  it('shows the confirmation a create left for this team, and has no delete control anywhere (AC-1.7)', async () => {
    setFlash('team:t-backend', 'Team “Backend” created. Add its members below.')
    await renderLoaded()
    expect(screen.getByTestId('team-created').textContent).toBe('Team “Backend” created. Add its members below.')
    expect(document.querySelector('[data-testid*="delete"]')).toBeNull()
    expect(screen.queryByRole('button', { name: /delete/i })).toBeNull()
  })
})

describe('TeamDetail members table', () => {
  it('lists name, email and the added date as dd.mm.yyyy, with a Deactivated badge on the deactivated one', async () => {
    await renderLoaded()
    const table = screen.getByTestId('team-members-table')
    expect(
      within(table)
        .getAllByRole('rowheader')
        .map((cell) => cell.textContent),
    ).toEqual(['Ada Rossi', 'Bruno Bianchi', 'Gina GoneDeactivated'])
    const adaRow = screen.getByTestId('team-member-u-ada')
    expect(within(adaRow).getByText('ada@example.com')).toBeTruthy()
    expect(within(adaRow).getByText('03.11.2026')).toBeTruthy()
    expect(screen.getByTestId('team-member-deactivated-u-gone').textContent).toContain('Deactivated')
    expect(screen.queryByTestId('team-member-deactivated-u-ada')).toBeNull()
    expect(screen.getByText(/Deactivated people stay listed/)).toBeTruthy()
  })

  it('says so when nobody is a member, and the picker stays', async () => {
    vi.mocked(adminApi.getTeam).mockResolvedValue(teamOf({ members: [] }))
    await renderLoaded()
    expect(screen.getByTestId('team-members-empty').textContent).toContain('No members yet')
    expect(screen.queryByTestId('team-members-table')).toBeNull()
    expect(screen.getByTestId('team-member-picker-input')).toBeTruthy()
    expect(screen.queryByText(/Deactivated people stay listed/)).toBeNull()
  })
})

describe('TeamDetail edit (F3, AC-1.2, AC-1.8)', () => {
  it('opens prefilled, sends only the changed field and baseVersion, and shows the saved team', async () => {
    vi.mocked(adminApi.patchTeam).mockResolvedValue(teamOf({ name: 'Core', version: 4 }))
    await renderLoaded()
    click('team-edit-details')
    expect((screen.getByTestId('edit-team-name-input') as HTMLInputElement).value).toBe('Backend')
    expect((screen.getByTestId('edit-team-description-input') as HTMLTextAreaElement).value).toBe('Builds the services')

    fireEvent.change(screen.getByTestId('edit-team-name-input'), { target: { value: ' Core ' } })
    click('edit-team-submit')

    await waitFor(() => expect(adminApi.patchTeam).toHaveBeenCalledWith('t-backend', { baseVersion: 3, name: 'Core' }))
    await waitFor(() => expect(screen.queryByTestId('edit-team-submit')).toBeNull())
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Core')
    expect(screen.getByTestId('team-success').textContent).toBe('Team saved')
  })

  it('clearing the description sends null, and the next save uses the new version', async () => {
    vi.mocked(adminApi.patchTeam)
      .mockResolvedValueOnce(teamOf({ description: null, version: 4 }))
      .mockResolvedValueOnce(teamOf({ description: 'Again', version: 5 }))
    await renderLoaded()
    click('team-edit-details')
    fireEvent.change(screen.getByTestId('edit-team-description-input'), { target: { value: '   ' } })
    click('edit-team-submit')
    await waitFor(() =>
      expect(adminApi.patchTeam).toHaveBeenCalledWith('t-backend', { baseVersion: 3, description: null }),
    )
    await waitFor(() => expect(screen.queryByTestId('edit-team-submit')).toBeNull())

    click('team-edit-details')
    fireEvent.change(screen.getByTestId('edit-team-description-input'), { target: { value: 'Again' } })
    click('edit-team-submit')
    await waitFor(() =>
      expect(adminApi.patchTeam).toHaveBeenLastCalledWith('t-backend', { baseVersion: 4, description: 'Again' }),
    )
  })

  it('saving nothing changed closes the dialog without a request', async () => {
    await renderLoaded()
    click('team-edit-details')
    click('edit-team-submit')
    await waitFor(() => expect(screen.queryByTestId('edit-team-submit')).toBeNull())
    expect(adminApi.patchTeam).not.toHaveBeenCalled()
  })

  it('a name clash goes on the Name field in the reader’s words and keeps the dialog open', async () => {
    vi.mocked(adminApi.patchTeam).mockRejectedValue(problem(409, 'team_name_taken', { existingName: 'Design' }))
    await renderLoaded()
    click('team-edit-details')
    fireEvent.change(screen.getByTestId('edit-team-name-input'), { target: { value: 'design' } })
    click('edit-team-submit')
    expect((await screen.findByTestId('edit-team-name-error')).textContent).toBe(
      'A team named “Design” already exists. Archived teams count too.',
    )
    expect((screen.getByTestId('edit-team-name-input') as HTMLInputElement).value).toBe('design')
    expect(screen.queryByText('English detail only')).toBeNull()
    expect(screen.queryByTestId('team-stale-banner')).toBeNull()
  })

  it('a stale save (409 version_conflict) keeps the typed values, blocks submit, and shows the banner once closed', async () => {
    vi.mocked(adminApi.patchTeam).mockRejectedValue(problem(409, 'version_conflict', { currentVersion: 5 }))
    await renderLoaded()
    click('team-edit-details')
    fireEvent.change(screen.getByTestId('edit-team-name-input'), { target: { value: 'My typed name' } })
    fireEvent.change(screen.getByTestId('edit-team-description-input'), { target: { value: 'My typed text' } })
    click('edit-team-submit')

    const error = await screen.findByTestId('edit-team-error')
    expect(error.textContent).toContain('Someone else changed this team while you were editing.')
    expect((screen.getByTestId('edit-team-name-input') as HTMLInputElement).value).toBe('My typed name')
    expect((screen.getByTestId('edit-team-description-input') as HTMLTextAreaElement).value).toBe('My typed text')
    expect((screen.getByTestId('edit-team-submit') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByTestId('team-stale-banner')).toBeNull()

    click('edit-team-cancel')
    await waitFor(() => expect(screen.queryByTestId('edit-team-submit')).toBeNull())
    expect(screen.getByTestId('team-stale-banner').textContent).toContain('Someone else changed this team.')
    // The page keeps what it had: nothing was refetched behind the dialog.
    expect(adminApi.getTeam).toHaveBeenCalledTimes(1)

    // Reload refetches and clears the banner.
    vi.mocked(adminApi.getTeam).mockResolvedValue(teamOf({ name: 'Backend v2', version: 5 }))
    click('team-stale-reload')
    await waitFor(() => expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Backend v2'))
    expect(screen.queryByTestId('team-stale-banner')).toBeNull()
    expect(adminApi.getTeam).toHaveBeenCalledTimes(2)
  })

  it('any other failure (including a clash without its name) is the generic message in the dialog, values kept', async () => {
    vi.mocked(adminApi.patchTeam).mockRejectedValue(problem(409, 'team_name_taken'))
    await renderLoaded()
    click('team-edit-details')
    fireEvent.change(screen.getByTestId('edit-team-name-input'), { target: { value: 'Zed' } })
    click('edit-team-submit')
    expect((await screen.findByTestId('edit-team-error')).textContent).toBe('Could not save the team.')
    expect((screen.getByTestId('edit-team-name-input') as HTMLInputElement).value).toBe('Zed')
    expect((screen.getByTestId('edit-team-submit') as HTMLButtonElement).disabled).toBe(false)
  })

  it('works on an archived team (AC-2.4 posture) and mounts no form inside a form', async () => {
    vi.mocked(adminApi.getTeam).mockResolvedValue(teamOf({ archived: true }))
    await renderLoaded()
    click('team-edit-details')
    expect(screen.getByTestId('edit-team-name-input')).toBeTruthy()
    noNestedForms()
  })
})

describe('TeamDetail archive and restore (F4, F5, AC-1.5, AC-1.6, AC-1.8)', () => {
  it('Archive asks first, then archives at the loaded version and swaps to Restore with the archived note', async () => {
    vi.mocked(adminApi.archiveTeam).mockResolvedValue(teamOf({ archived: true, version: 4 }))
    await renderLoaded()
    expect(screen.queryByTestId('team-restore')).toBeNull()
    expect(screen.queryByTestId('team-archived-note')).toBeNull()

    click('team-archive')
    expect(screen.getByRole('alertdialog').textContent).toContain('Archive “Backend”?')
    expect(adminApi.archiveTeam).not.toHaveBeenCalled()
    noNestedForms()

    click('archive-team-confirm')
    await waitFor(() => expect(adminApi.archiveTeam).toHaveBeenCalledWith('t-backend', 3))
    await waitFor(() => expect(screen.queryByTestId('archive-team-confirm')).toBeNull())
    expect(screen.getByTestId('team-status').textContent).toContain('Archived')
    expect(screen.getByTestId('team-archived-note')).toBeTruthy()
    expect(screen.queryByTestId('team-archive')).toBeNull()
    expect(screen.getByTestId('team-restore')).toBeTruthy()
    expect(screen.getByTestId('team-success').textContent).toBe('Team “Backend” archived')
    // The new version is the one the next write carries; focus is on the page heading.
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 2 }))
  })

  it('Restore asks first and restores, then offers Archive again', async () => {
    vi.mocked(adminApi.getTeam).mockResolvedValue(teamOf({ archived: true, version: 7 }))
    vi.mocked(adminApi.restoreTeam).mockResolvedValue(teamOf({ archived: false, version: 8 }))
    await renderLoaded()

    click('team-restore')
    expect(screen.getByRole('alertdialog').textContent).toContain('Restore “Backend”?')
    expect(adminApi.restoreTeam).not.toHaveBeenCalled()
    click('restore-team-confirm')

    await waitFor(() => expect(adminApi.restoreTeam).toHaveBeenCalledWith('t-backend', 7))
    await waitFor(() => expect(screen.getByTestId('team-archive')).toBeTruthy())
    expect(screen.queryByTestId('team-archived-note')).toBeNull()
    expect(screen.getByTestId('team-success').textContent).toBe('Team “Backend” restored')
  })

  it('Cancel changes nothing', async () => {
    await renderLoaded()
    click('team-archive')
    click('archive-team-cancel')
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(adminApi.archiveTeam).not.toHaveBeenCalled()
  })

  it('a stale archive keeps the dialog open with the reason, Confirm unavailable, and the banner after Cancel', async () => {
    vi.mocked(adminApi.archiveTeam).mockRejectedValue(problem(409, 'version_conflict', { currentVersion: 9 }))
    await renderLoaded()
    click('team-archive')
    click('archive-team-confirm')
    expect((await screen.findByTestId('archive-team-error')).textContent).toContain('Someone else changed this team.')
    const confirm = screen.getByTestId('archive-team-confirm')
    expect(confirm.getAttribute('aria-disabled')).toBe('true')
    const reason = document.getElementById(confirm.getAttribute('aria-describedby') ?? '')
    expect(reason?.textContent).toContain('Reload to see the latest version first.')
    fireEvent.click(confirm)
    expect(adminApi.archiveTeam).toHaveBeenCalledTimes(1)

    click('archive-team-cancel')
    expect(screen.getByTestId('team-stale-banner')).toBeTruthy()
  })

  it('another archive failure is shown in the dialog and the dialog stays open', async () => {
    vi.mocked(adminApi.archiveTeam).mockRejectedValue(new TypeError('network'))
    await renderLoaded()
    click('team-archive')
    click('archive-team-confirm')
    expect((await screen.findByTestId('archive-team-error')).textContent).toBe('Could not archive the team.')
    expect(screen.getByTestId('archive-team-confirm').getAttribute('aria-disabled')).not.toBe('true')
  })
})

describe('TeamDetail add a member (F6, AC-2.1, AC-2.3, AC-2.4)', () => {
  it('a pick alone never writes; Add commits, the row appears, the picker clears and keeps focus', async () => {
    vi.mocked(adminApi.addTeamMember).mockResolvedValue(
      teamOf({
        members: [ada, bruno, member({ id: 'u-carla', name: 'Carla Verdi', email: 'carla@example.com' }), gone],
      }),
    )
    await renderLoaded()
    expect(screen.getByTestId('team-member-add').hasAttribute('disabled')).toBe(true)

    await pickUser('car', 'u-carla')
    expect(adminApi.addTeamMember).not.toHaveBeenCalled()
    expect(adminApi.listUsers).toHaveBeenCalledWith({ q: 'car', pageSize: 10 })
    expect(screen.getByTestId('team-member-add').hasAttribute('disabled')).toBe(false)

    click('team-member-add')
    await waitFor(() => expect(adminApi.addTeamMember).toHaveBeenCalledWith('t-backend', 'u-carla'))
    await screen.findByTestId('team-member-u-carla')
    expect(screen.getByTestId('team-members-success').textContent).toBe('Carla Verdi added to this team')
    expect((screen.getByTestId('team-member-picker-input') as HTMLInputElement).value).toBe('')
    expect(screen.getByTestId('team-member-add').hasAttribute('disabled')).toBe(true)
    expect(document.activeElement).toBe(screen.getByTestId('team-member-picker-input'))
    expect(screen.getByTestId('team-members-count').textContent).toBe('4 of 100 members · 1 deactivated')
  })

  it('never offers a person who is already a member, the deactivated included', async () => {
    vi.mocked(adminApi.listUsers).mockResolvedValue({
      items: [
        userRow('u-ada', 'Ada Rossi', 'ada@example.com'),
        userRow('u-gone', 'Gina Gone', 'gina@example.com'),
        userRow('u-carla', 'Carla Verdi', 'carla@example.com'),
      ],
      page: 1,
      pageSize: 10,
      total: 3,
    })
    await renderLoaded()
    fireEvent.change(screen.getByTestId('team-member-picker-input'), { target: { value: 'a' } })
    await screen.findByTestId('team-member-picker-input-option-u-carla')
    expect(screen.queryByTestId('team-member-picker-input-option-u-ada')).toBeNull()
    expect(screen.queryByTestId('team-member-picker-input-option-u-gone')).toBeNull()
  })

  it('a user with no name is offered by email', async () => {
    vi.mocked(adminApi.listUsers).mockResolvedValue({
      items: [userRow('u-anon', null, 'anon@example.com')],
      page: 1,
      pageSize: 10,
      total: 1,
    })
    await renderLoaded()
    fireEvent.change(screen.getByTestId('team-member-picker-input'), { target: { value: 'anon' } })
    expect((await screen.findByTestId('team-member-picker-input-option-u-anon')).textContent).toContain(
      'anon@example.com',
    )
  })

  it('a search the caller may not make says so, never "no match"', async () => {
    vi.mocked(adminApi.listUsers).mockRejectedValue(problem(403, 'forbidden'))
    await renderLoaded()
    fireEvent.change(screen.getByTestId('team-member-picker-input'), { target: { value: 'x' } })
    expect((await screen.findAllByText('You may not search users.')).length).toBeGreaterThan(0)
    expect(screen.queryByText(/No active user matches/)).toBeNull()
  })

  it('a search that fails is unavailable, never "no match"', async () => {
    vi.mocked(adminApi.listUsers).mockRejectedValue(new TypeError('network'))
    await renderLoaded()
    fireEvent.change(screen.getByTestId('team-member-picker-input'), { target: { value: 'x' } })
    expect((await screen.findAllByText('Users could not be searched. Try again.')).length).toBeGreaterThan(0)
  })

  it('422 user_not_active is its own message under the picker, and nothing is added', async () => {
    vi.mocked(adminApi.addTeamMember).mockRejectedValue(problem(422, 'user_not_active'))
    await renderLoaded()
    await pickUser('car', 'u-carla')
    click('team-member-add')
    expect((await screen.findByTestId('team-members-error')).textContent).toBe(
      'This person is not an active user and cannot be added.',
    )
    expect(screen.queryByTestId('team-member-u-carla')).toBeNull()
  })

  it('422 team_full names the limit', async () => {
    vi.mocked(adminApi.addTeamMember).mockRejectedValue(problem(422, 'team_full', { limit: 100 }))
    await renderLoaded()
    await pickUser('car', 'u-carla')
    click('team-member-add')
    expect((await screen.findByTestId('team-members-error')).textContent).toBe(
      'A team has at most 100 members, deactivated people included.',
    )
  })

  it('any other add failure is the generic message and the pick is kept', async () => {
    vi.mocked(adminApi.addTeamMember).mockRejectedValue(new TypeError('network'))
    await renderLoaded()
    await pickUser('car', 'u-carla')
    click('team-member-add')
    expect((await screen.findByTestId('team-members-error')).textContent).toBe('Could not add this member.')
    expect((screen.getByTestId('team-member-picker-input') as HTMLInputElement).value).toBe('Carla Verdi')
  })

  it('at 100 members the picker is closed, Add is aria-disabled with the reason, and Add does nothing', async () => {
    const hundred = Array.from({ length: 100 }, (_, i) =>
      member({ id: `u-${i}`, name: `Person ${String(i).padStart(3, '0')}` }),
    )
    vi.mocked(adminApi.getTeam).mockResolvedValue(teamOf({ members: hundred }))
    await renderLoaded()

    const input = screen.getByTestId('team-member-picker-input') as HTMLInputElement
    expect(input.getAttribute('aria-disabled')).toBe('true')
    expect(input.readOnly).toBe(true)
    const add = screen.getByTestId('team-member-add')
    expect(add.getAttribute('aria-disabled')).toBe('true')
    expect(add.hasAttribute('disabled')).toBe(false)
    const full = screen.getByTestId('team-members-full')
    expect(full.textContent).toBe(
      'This team has 100 members, deactivated people included. Remove someone to add another.',
    )
    expect(add.getAttribute('aria-describedby')).toBe(full.id)
    fireEvent.click(add)
    expect(adminApi.addTeamMember).not.toHaveBeenCalled()
  })

  it('works on an archived team', async () => {
    vi.mocked(adminApi.getTeam).mockResolvedValue(teamOf({ archived: true }))
    vi.mocked(adminApi.addTeamMember).mockResolvedValue(teamOf({ archived: true }))
    await renderLoaded()
    await pickUser('car', 'u-carla')
    click('team-member-add')
    await waitFor(() => expect(adminApi.addTeamMember).toHaveBeenCalledWith('t-backend', 'u-carla'))
  })

  it('the members response does not move the team version, so a stale banner stays honest', async () => {
    vi.mocked(adminApi.addTeamMember).mockResolvedValue(teamOf({ name: 'Renamed elsewhere', version: 9 }))
    vi.mocked(adminApi.patchTeam).mockResolvedValue(teamOf({ version: 4 }))
    await renderLoaded()
    await pickUser('car', 'u-carla')
    click('team-member-add')
    await waitFor(() => expect(adminApi.addTeamMember).toHaveBeenCalled())
    await waitFor(() => expect(screen.getByTestId('team-members-success')).toBeTruthy())
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Backend')
    click('team-edit-details')
    fireEvent.change(screen.getByTestId('edit-team-name-input'), { target: { value: 'New' } })
    click('edit-team-submit')
    await waitFor(() => expect(adminApi.patchTeam).toHaveBeenCalledWith('t-backend', { baseVersion: 3, name: 'New' }))
  })
})

describe('TeamDetail remove a member (F7, AC-2.2)', () => {
  it('asks first (naming the person), then removes and drops the row', async () => {
    vi.mocked(adminApi.removeTeamMember).mockResolvedValue(teamOf({ members: [bruno, gone] }))
    await renderLoaded()

    const remove = screen.getByTestId('team-member-remove-u-ada')
    expect(remove.getAttribute('aria-label')).toBe('Remove Ada Rossi from this team')
    fireEvent.click(remove)
    const dialog = screen.getByRole('alertdialog')
    expect(dialog.textContent).toContain('Remove Ada Rossi?')
    expect(adminApi.removeTeamMember).not.toHaveBeenCalled()
    noNestedForms()

    click('remove-team-member-confirm')
    await waitFor(() => expect(adminApi.removeTeamMember).toHaveBeenCalledWith('t-backend', 'u-ada'))
    await waitFor(() => expect(screen.queryByTestId('team-member-u-ada')).toBeNull())
    expect(screen.getByTestId('team-members-success').textContent).toBe('Ada Rossi removed from this team')
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(document.activeElement).toBe(screen.getByTestId('team-member-picker-input'))
  })

  it('Cancel removes nothing', async () => {
    await renderLoaded()
    click('team-member-remove-u-bruno')
    click('remove-team-member-cancel')
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(adminApi.removeTeamMember).not.toHaveBeenCalled()
    expect(screen.getByTestId('team-member-u-bruno')).toBeTruthy()
  })

  it('a deactivated member is removable the same way', async () => {
    vi.mocked(adminApi.removeTeamMember).mockResolvedValue(teamOf({ members: [ada, bruno] }))
    await renderLoaded()
    click('team-member-remove-u-gone')
    click('remove-team-member-confirm')
    await waitFor(() => expect(adminApi.removeTeamMember).toHaveBeenCalledWith('t-backend', 'u-gone'))
    await waitFor(() => expect(screen.queryByTestId('team-member-u-gone')).toBeNull())
  })

  it('a failed removal keeps the row and says so in the dialog, which stays open', async () => {
    vi.mocked(adminApi.removeTeamMember).mockRejectedValue(new TypeError('network'))
    await renderLoaded()
    click('team-member-remove-u-ada')
    click('remove-team-member-confirm')
    expect((await screen.findByTestId('remove-team-member-error')).textContent).toBe('Could not remove this member.')
    expect(screen.getByTestId('team-member-u-ada')).toBeTruthy()
  })
})
