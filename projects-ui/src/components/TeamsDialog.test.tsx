/**
 * @vitest-environment jsdom
 *
 * TeamsDialog (specs/20261126-teams AC-4.1, AC-4.2, AC-4.3, AC-5.6; design S7): the teams attached to a project,
 * edited in one go. The attach field is a SERVER-searched `SearchPicker` (`GET /attachable-teams?q=`): nothing is
 * fetched on open, the attached and the staged teams are left out, text over 80 characters cannot match, a
 * 503 / 429 / network failure is "could not be searched" (never "no match"). Picking stages a team, the limit is
 * named at 10, one `PUT /projects/{id}/teams` with the project's version saves, and each refusal has its own message:
 * 409 → the page's stale prompt, 422 / 503 inline, and a 429 inline with the dialog still open and the set kept.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { fakeApi, problem, projectDetail } from '../test-support/fakeApi'
import type { FakeHandler } from '../test-support/fakeApi'
import type { AttachedTeamView, Project } from '../lib/types'

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock('shell/session', () => ({
  usePermissions: () => ({ epoch: 0, apps: [], roles: [], departments: [], permissions: [] }),
  apiFetch,
  getProjectsApiBaseUrl: () => 'http://projects-api.test',
  getAuthBaseUrl: () => 'http://auth.test',
  useSession: () => ({ data: { user: { id: 'u-ada', name: 'Ada Lovelace' } } }),
}))

import TeamsDialog from './TeamsDialog'

const attached = (id: string, name: string | null, archived: boolean | null = false): AttachedTeamView => ({
  id,
  name,
  archived,
  members: [],
})

const BACKEND = attached('t-back', 'Backend')
const DESIGN = attached('t-design', 'Design')

const withTeams = (teams: AttachedTeamView[], version = 7): Project =>
  projectDetail({ teams, version, teamsStatus: 'complete', onProjectComplete: true, onProject: [] })

const onSaved = vi.fn()
const onCancel = vi.fn()
const onStale = vi.fn()

const SEARCH: FakeHandler = () => ({
  status: 200,
  body: {
    items: [
      { id: 't-back', name: 'Backend' },
      { id: 't-design', name: 'Design' },
      { id: 't-ops', name: 'Operations' },
    ],
    truncated: false,
  },
})

const renderDialog = (project: Project, routes: Record<string, FakeHandler> = {}) => {
  apiFetch.mockImplementation(fakeApi({ 'GET /attachable-teams': SEARCH, ...routes }))
  render(<TeamsDialog project={project} onSaved={onSaved} onCancel={onCancel} onStale={onStale} />)
  return screen.getByRole('dialog', { name: 'Edit teams' })
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

const requests = () =>
  apiFetch.mock.calls.map(([input, init]) => ({
    method: (init as RequestInit | undefined)?.method ?? 'GET',
    url: new URL(String(input)),
  }))

const writes = () =>
  apiFetch.mock.calls
    .filter(([, init]) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes((init as RequestInit | undefined)?.method ?? ''))
    .map(([input, init]) => ({
      method: (init as RequestInit).method!,
      path: new URL(String(input)).pathname,
      ifMatch: ((init as RequestInit).headers as Record<string, string>)['If-Match'],
      body: JSON.parse(String((init as RequestInit).body ?? 'null')) as unknown,
    }))

const field = (dialog: HTMLElement) => within(dialog).getByRole('combobox', { name: /Attach a team/ })
const openList = (dialog: HTMLElement) => fireEvent.focus(field(dialog))
const choose = async (dialog: HTMLElement, name: RegExp) => {
  openList(dialog)
  fireEvent.click(await within(dialog).findByRole('option', { name }))
}
const submitButton = (dialog: HTMLElement) =>
  within(dialog).getByTestId('project-attached-teams-dialog-submit') as HTMLButtonElement
const save = (dialog: HTMLElement) => fireEvent.click(submitButton(dialog))
const error = (dialog: HTMLElement) => within(dialog).findByTestId('project-attached-teams-dialog-error')

describe('searching the teams to attach (S7)', () => {
  it('fetches nothing when the dialog opens, and asks the server for the first teams when the field is focused', async () => {
    const dialog = renderDialog(withTeams([]))
    expect(requests()).toEqual([])
    openList(dialog)
    expect((await within(dialog).findAllByRole('option')).map((option) => option.textContent)).toEqual([
      'Backend',
      'Design',
      'Operations',
    ])
    const [search] = requests()
    expect(search!.method).toBe('GET')
    expect(search!.url.pathname).toBe('/attachable-teams')
    expect(search!.url.searchParams.has('q')).toBe(false)
  })

  it('sends the trimmed text as q', async () => {
    const dialog = renderDialog(withTeams([]))
    fireEvent.change(field(dialog), { target: { value: '  back  ' } })
    await waitFor(() => expect(requests().some(({ url }) => url.searchParams.get('q') === 'back')).toBe(true))
  })

  it('leaves out the teams already attached and the ones already staged', async () => {
    const dialog = renderDialog(withTeams([BACKEND]))
    openList(dialog)
    expect((await within(dialog).findAllByRole('option')).map((option) => option.textContent)).toEqual([
      'Design',
      'Operations',
    ])
    fireEvent.click(within(dialog).getByRole('option', { name: 'Design' }))
    openList(dialog)
    expect((await within(dialog).findAllByRole('option')).map((option) => option.textContent)).toEqual(['Operations'])
  })

  it('answers "no match" for text over 80 characters without calling the server', async () => {
    const dialog = renderDialog(withTeams([]))
    fireEvent.change(field(dialog), { target: { value: 'x'.repeat(81) } })
    expect(await within(dialog).findAllByText('No active team matches, or it is already attached.')).not.toBeNull()
    expect(requests()).toEqual([])
  })

  it('adds "type more of the name" to the hint when the answer was truncated', async () => {
    const dialog = renderDialog(withTeams([BACKEND]), {
      'GET /attachable-teams': () => ({
        status: 200,
        body: { items: [{ id: 't-ops', name: 'Operations' }], truncated: true },
      }),
    })
    expect(within(dialog).queryByText(/Type more of the name/)).toBeNull()
    expect(within(dialog).getByText(/1 of 10 teams\./)).not.toBeNull()
    openList(dialog)
    await within(dialog).findByRole('option', { name: 'Operations' })
    expect(within(dialog).getByText(/Type more of the name to narrow the list\./)).not.toBeNull()
  })

  it.each([
    ['a 503 teams_unavailable', () => problem(503, 'teams_unavailable')],
    ['a 429 of the search', () => problem(429, 'rate_limited', { retryAfterSeconds: 30 })],
    ['a 500', () => problem(500)],
  ])('says the teams "could not be searched" on %s, never "no match"', async (_name, answer) => {
    const dialog = renderDialog(withTeams([]), { 'GET /attachable-teams': answer })
    openList(dialog)
    expect(
      (await within(dialog).findAllByText('Teams could not be searched. Nothing was changed. Try again.')).length,
    ).toBeGreaterThan(0)
    expect(within(dialog).queryByText('No active team matches, or it is already attached.')).toBeNull()
  })

  it('says the teams could not be searched on a network failure', async () => {
    apiFetch.mockImplementation(() => Promise.reject(new TypeError('Failed to fetch')))
    render(<TeamsDialog project={withTeams([])} onSaved={onSaved} onCancel={onCancel} onStale={onStale} />)
    const dialog = screen.getByRole('dialog', { name: 'Edit teams' })
    openList(dialog)
    expect(
      (await within(dialog).findAllByText('Teams could not be searched. Nothing was changed. Try again.')).length,
    ).toBeGreaterThan(0)
  })

  it('says "You may not attach teams." on a 403', async () => {
    const dialog = renderDialog(withTeams([]), { 'GET /attachable-teams': () => problem(403, 'forbidden') })
    openList(dialog)
    expect((await within(dialog).findAllByText('You may not attach teams.')).length).toBeGreaterThan(0)
  })

  it('still removes and saves while the search is down', async () => {
    const next = withTeams([DESIGN], 8)
    const dialog = renderDialog(withTeams([BACKEND, DESIGN]), {
      'GET /attachable-teams': () => problem(503, 'teams_unavailable'),
      'PUT /projects/p1/teams': () => ({ status: 200, body: next }),
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove Backend' }))
    save(dialog)
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(next))
  })
})

describe('attaching, detaching and the limit (AC-4.1, AC-4.2)', () => {
  it('stages a picked team, empties the field and PUTs the whole set with the project’s version', async () => {
    const next = withTeams([BACKEND, attached('t-ops', 'Operations')], 8)
    const dialog = renderDialog(withTeams([BACKEND]), { 'PUT /projects/p1/teams': () => ({ status: 200, body: next }) })
    expect(submitButton(dialog).disabled).toBe(true)
    await choose(dialog, /Operations/)
    expect((field(dialog) as HTMLInputElement).value).toBe('')
    const list = within(dialog).getByTestId('project-attached-teams-list')
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['BackendRemove', 'OperationsRemove'])
    // Staging writes nothing.
    expect(writes()).toEqual([])
    expect(submitButton(dialog).disabled).toBe(false)
    save(dialog)
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(next))
    expect(writes()).toEqual([
      { method: 'PUT', path: '/projects/p1/teams', ifMatch: '"7"', body: { teamIds: ['t-back', 't-ops'] } },
    ])
  })

  it('detaches a team, and an archived attached team stays removable with its badge', async () => {
    const next = withTeams([BACKEND], 8)
    const dialog = renderDialog(withTeams([BACKEND, attached('t-old', 'Legacy', true)]), {
      'PUT /projects/p1/teams': () => ({ status: 200, body: next }),
    })
    const row = within(dialog).getByTestId('project-attached-teams-row-t-old')
    expect(within(row).getByText('Archived')).not.toBeNull()
    fireEvent.click(within(row).getByRole('button', { name: 'Remove Legacy' }))
    expect(within(dialog).queryByTestId('project-attached-teams-row-t-old')).toBeNull()
    save(dialog)
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(next))
    expect(writes()[0]!.body).toEqual({ teamIds: ['t-back'] })
  })

  it('cannot be saved while the set is unchanged, and again once a removal is undone by a re-attach', async () => {
    const dialog = renderDialog(withTeams([BACKEND]))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove Backend' }))
    expect(submitButton(dialog).disabled).toBe(false)
    await choose(dialog, /Backend/)
    expect(submitButton(dialog).disabled).toBe(true)
  })

  it('names the limit at 10: the picker is disabled with its hint until one is removed', async () => {
    const ten = Array.from({ length: 10 }, (_, index) => attached(`t-${index}`, `Team ${index}`))
    const dialog = renderDialog(withTeams(ten))
    expect(field(dialog).getAttribute('aria-disabled')).toBe('true')
    expect(
      within(dialog).getByText('A project can have at most 10 teams. Remove one to attach another.'),
    ).not.toBeNull()
    expect(within(dialog).getByTestId('project-attached-teams-count').textContent).toBe('10 of 10 teams attached')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove Team 3' }))
    expect(field(dialog).getAttribute('aria-disabled')).toBeNull()
    expect(within(dialog).getByText(/9 of 10 teams\./)).not.toBeNull()
  })

  it('keeps the focus in the list after a removal: the next Remove, or the list’s label when none is left', () => {
    const dialog = renderDialog(withTeams([BACKEND, DESIGN]))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove Backend' }))
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Remove Design' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove Design' }))
    expect(document.activeElement).toBe(within(dialog).getByText('Attached teams'))
  })

  it('shows a team that could not be loaded as such, removable by its position (AC-5.4)', () => {
    const dialog = renderDialog(withTeams([BACKEND, attached('t-x', null, null)]))
    const row = within(dialog).getByTestId('project-attached-teams-row-t-x')
    expect(row.textContent).toContain('Team that could not be loaded')
    expect(within(row).getByRole('button', { name: 'Remove team 2 that could not be loaded' })).not.toBeNull()
  })

  it('states what removing a team means, and what attaching one does', () => {
    const dialog = renderDialog(withTeams([]))
    expect(within(dialog).getByText(/Removing a team removes its members from this project/)).not.toBeNull()
    expect(
      within(dialog).getByText(
        /Everyone in an attached team who has access to Projects counts as part of this project/,
      ),
    ).not.toBeNull()
    expect(within(dialog).getByText('No teams attached.')).not.toBeNull()
  })

  it('is not inside a form of the page (ADR 20261118): no nested forms', () => {
    renderDialog(withTeams([BACKEND]))
    expect(document.querySelectorAll('form form').length).toBe(0)
  })
})

describe('what a refused save says (S7)', () => {
  const refuse = async (answer: ReturnType<FakeHandler>, teams = [BACKEND]) => {
    const dialog = renderDialog(withTeams(teams), { 'PUT /projects/p1/teams': () => answer as never })
    await choose(dialog, /Operations/)
    save(dialog)
    return dialog
  }

  it('hands a stale version (409 version_conflict, or 428) to the page, closing nothing itself', async () => {
    await refuse(problem(409, 'version_conflict'))
    await waitFor(() => expect(onStale).toHaveBeenCalledTimes(1))
    expect(onSaved).not.toHaveBeenCalled()
  })

  it('names the archived teams on a 422 team_archived, from its own list', async () => {
    const dialog = await refuse(problem(422, 'team_archived', { teamIds: ['t-ops'] }))
    expect((await error(dialog)).textContent).toBe(
      'These teams were archived and can no longer be attached: Operations. Remove them to save.',
    )
    expect(onSaved).not.toHaveBeenCalled()
  })

  it('says a team no longer exists on a 422 team_not_found', async () => {
    const dialog = await refuse(problem(422, 'team_not_found', { teamIds: ['t-ops'] }))
    expect((await error(dialog)).textContent).toBe(
      'A team you chose no longer exists. Close this dialog and try again.',
    )
  })

  it('says the teams could not be loaded on a 503 teams_unavailable, nothing changed', async () => {
    const dialog = await refuse(problem(503, 'teams_unavailable'))
    expect((await error(dialog)).textContent).toBe(
      'Teams could not be loaded right now. Nothing was changed. Try again in a moment.',
    )
  })

  it('uses the server’s words for any other refusal (403 out_of_scope)', async () => {
    const dialog = await refuse(problem(403, 'out_of_scope', {}, 'You may not change projects of this entity.'))
    expect((await error(dialog)).textContent).toBe('You may not change projects of this entity.')
  })

  it('answers a 429 inline with the wait in whole minutes, rounded up, keeping the dialog, the set and Save (AC-5.6)', async () => {
    const dialog = await refuse(problem(429, 'rate_limited', { retryAfterSeconds: 400 }))
    expect((await error(dialog)).textContent).toBe('Too many requests, so nothing was changed. Try again in 7 minutes.')
    expect(onSaved).not.toHaveBeenCalled()
    expect(onStale).not.toHaveBeenCalled()
    expect(onCancel).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: 'Edit teams' })).not.toBeNull()
    expect(within(dialog).getByTestId('project-attached-teams-row-t-ops')).not.toBeNull()
    expect(submitButton(dialog).disabled).toBe(false)
    // A refused save costs nothing: the same save can be sent again.
    save(dialog)
    await waitFor(() => expect(writes()).toHaveLength(2))
  })

  it('says "Try again in a minute." for up to 60 seconds and "Try again later." without a usable number', async () => {
    let dialog = await refuse(problem(429, 'rate_limited', { retryAfterSeconds: 45 }))
    expect((await error(dialog)).textContent).toBe('Too many requests, so nothing was changed. Try again in a minute.')
    cleanup()
    vi.clearAllMocks()
    dialog = await refuse(problem(429, 'rate_limited'))
    expect((await error(dialog)).textContent).toBe('Too many requests, so nothing was changed. Try again later.')
    cleanup()
    dialog = await refuse(problem(429, 'rate_limited', { retryAfterSeconds: 'soon' }))
    expect((await error(dialog)).textContent).toBe('Too many requests, so nothing was changed. Try again later.')
  })
})
