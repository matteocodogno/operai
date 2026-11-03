/**
 * @vitest-environment jsdom
 *
 * ProjectDetailPage (AC-1.2 – AC-1.7, AC-4.4): the details, derived dates, team
 * and contracts; only the allowed state moves (Resume back to `stateBeforeHold`);
 * "Make SaaS" on an internal project only; controls hidden without manage scope;
 * the project manager and the team picked among module users; and a stale write
 * (409 `version_conflict`) asking the person to reload. Rendered through the
 * app's real router against a fake projects-api.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { RouterProvider } from '@tanstack/react-router'
import { createAppRouter } from '../router'
import { fakeApi, problem, projectDetail, scope } from '../test-support/fakeApi'
import type { FakeHandler } from '../test-support/fakeApi'
import { scopeRoot } from '../test-support/scopeRoot'
import type { Project, ProjectState, Scope } from '../lib/types'

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock('shell/session', () => ({
  apiFetch,
  getProjectsApiBaseUrl: () => 'http://projects-api.test',
  getAuthBaseUrl: () => 'http://auth.test',
  useSession: () => ({ data: { user: { id: 'u-ada', name: 'Ada Lovelace' } } }),
}))

const BOB = { id: 'u-bob', name: 'Bob Builder', email: 'bob@welld.ch', entity: 'welld_ch' }
const BOB_PERSON = { id: 'u-bob', name: 'Bob Builder', deleted: false }
const CARA = { id: 'u-cara', name: 'Cara Coder', email: 'cara@welld.ch', entity: 'welld_ch' }
const MANAGER = scope({ manage: ['welld_ch'] })

const renderProject = async (
  project: Project,
  routes: Record<string, FakeHandler> = {},
  callerScope: Scope = MANAGER,
) => {
  apiFetch.mockImplementation(
    fakeApi({
      [`GET /projects/${project.id}`]: () => ({ status: 200, body: project }),
      'GET /authz/users/directory': () => ({ status: 200, body: { users: [BOB, CARA] } }),
      ...routes,
    }),
  )
  window.history.pushState(null, '', `/${project.id}`)
  render(<RouterProvider router={createAppRouter(undefined, scopeRoot(callerScope))} />)
  await screen.findByTestId('project-detail-page')
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

const writes = () =>
  apiFetch.mock.calls
    .filter(([, init]) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes((init as RequestInit | undefined)?.method ?? ''))
    .map(([input, init]) => ({
      method: (init as RequestInit).method!,
      path: new URL(String(input)).pathname,
      ifMatch: ((init as RequestInit).headers as Record<string, string>)['If-Match'],
      body: JSON.parse(String((init as RequestInit).body ?? 'null')) as unknown,
    }))

const actionLabels = () => {
  const actions = screen.queryByTestId('project-actions')
  return actions
    ? within(actions)
        .queryAllByRole('button')
        .map((button) => button.textContent)
    : []
}

describe('the project page (AC-1.4, AC-1.5)', () => {
  it('shows the details, the derived dates, the team and the contracts', async () => {
    await renderProject(
      projectDetail({
        name: 'Intranet',
        state: 'active',
        company: { id: 'c1', name: 'Acme SA' },
        team: [BOB_PERSON, { id: 'u-gone', name: null, deleted: true }],
        startDate: '2026-02-01',
        endDate: '2026-12-31',
        contracts: [
          {
            id: 'k1',
            type: 't_and_m',
            company: { id: 'c1', name: 'Acme SA' },
            origin: 'manual',
            bexioOrderId: 'AB-100',
            startDate: '2026-02-01',
            endDate: '2026-12-31',
          },
        ],
      }),
    )
    expect(screen.getByRole('heading', { level: 2, name: 'Intranet' })).not.toBeNull()
    const facts = screen.getByTestId('project-facts')
    expect(facts.textContent).toContain('Time & material')
    expect(facts.textContent).toContain('wellD CH')
    expect(facts.textContent).toContain('Acme SA')
    expect(facts.textContent).toContain('Ada Lovelace (You)')
    expect(facts.textContent).toContain('01.02.2026')
    expect(facts.textContent).toContain('31.12.2026')
    const team = screen.getByTestId('project-team')
    expect(team.textContent).toContain('Bob Builder')
    expect(team.textContent).toContain('Deleted user')
    const contracts = screen.getByTestId('project-contracts')
    expect(contracts.textContent).toContain('Acme SA')
    expect(contracts.textContent).toContain('AB-100')
    expect(screen.getByTestId('project-detail-back').getAttribute('href')).toBe('/')
  })

  it('shows "Open-ended" when a contract has no end, and no dates without a contract', async () => {
    await renderProject(projectDetail({ startDate: '2026-02-01', endDate: null, contracts: [CONTRACT] }))
    expect(screen.getByTestId('project-facts').textContent).toContain('Open-ended')
    cleanup()
    await renderProject(projectDetail())
    expect(screen.getByTestId('project-facts').textContent).not.toContain('Open-ended')
    expect(screen.getByTestId('project-contracts').textContent).toContain('No contracts yet')
  })

  it('says a SaaS has clients (the contract companies), and an internal project has none', async () => {
    await renderProject(
      projectDetail({
        type: 'saas',
        company: null,
        contracts: [CONTRACT, { ...CONTRACT, id: 'k2', company: { id: 'c2', name: 'Beta AG' } }],
      }),
    )
    expect(screen.getByTestId('project-facts').textContent).toContain('2 clients')
    cleanup()
    await renderProject(projectDetail({ type: 'internal', company: null }))
    expect(screen.getByTestId('project-facts').textContent).toContain('Internal')
    expect(screen.getByTestId('project-contracts').textContent).toContain('Internal projects have no contracts')
  })

  it('an unknown project is "not found", with the way back to the list', async () => {
    apiFetch.mockImplementation(fakeApi({ 'GET /projects/zzz': () => problem(404, 'not_found') }))
    window.history.pushState(null, '', '/zzz')
    render(<RouterProvider router={createAppRouter(undefined, scopeRoot(MANAGER))} />)
    expect(await screen.findByTestId('project-not-found')).not.toBeNull()
    expect(screen.getByTestId('project-detail-back').getAttribute('href')).toBe('/')
  })

  it('a failed load shows the retry banner', async () => {
    let calls = 0
    apiFetch.mockImplementation(
      fakeApi({
        'GET /projects/p1': () => {
          calls += 1
          return calls === 1 ? problem(500, undefined, {}, 'boom') : { status: 200, body: projectDetail() }
        },
      }),
    )
    window.history.pushState(null, '', '/p1')
    render(<RouterProvider router={createAppRouter(undefined, scopeRoot(MANAGER))} />)
    expect((await screen.findByTestId('projects-load-error')).textContent).toContain('boom')
    fireEvent.click(screen.getByTestId('projects-load-error-retry'))
    expect(await screen.findByTestId('project-detail-page')).not.toBeNull()
  })
})

describe('state actions (AC-1.3)', () => {
  it.each<[ProjectState, ProjectState | null, string[]]>([
    ['planned', null, ['Start project', 'Put on hold', 'Cancel project']],
    ['active', null, ['Put on hold', 'Close project', 'Cancel project']],
    ['on_hold', 'active', ['Resume', 'Cancel project']],
    ['closed', null, ['Reopen']],
    ['cancelled', null, []],
  ])('a %s project offers only its allowed moves', async (state, stateBeforeHold, labels) => {
    await renderProject(projectDetail({ state, stateBeforeHold }))
    expect(actionLabels()).toEqual(labels)
  })

  it('moves a planned project to active with the version as If-Match, and shows the new state', async () => {
    await renderProject(projectDetail({ state: 'planned' }), {
      'POST /projects/p1/transitions': () => ({
        status: 200,
        body: projectDetail({ state: 'active', version: 4 }),
      }),
    })
    fireEvent.click(screen.getByRole('button', { name: 'Start project' }))
    await waitFor(() => expect(actionLabels()).toEqual(['Put on hold', 'Close project', 'Cancel project']))
    expect(writes()).toEqual([
      { method: 'POST', path: '/projects/p1/transitions', ifMatch: '"3"', body: { to: 'active' } },
    ])
    expect((await screen.findByTestId('projects-saved')).textContent).toContain('The project is now Active.')
  })

  it.each<ProjectState>(['planned', 'active'])(
    '"Resume" returns an on-hold project to the state it left (%s)',
    async (before) => {
      await renderProject(projectDetail({ state: 'on_hold', stateBeforeHold: before }), {
        'POST /projects/p1/transitions': () => ({
          status: 200,
          body: projectDetail({ state: before, version: 4 }),
        }),
      })
      fireEvent.click(screen.getByRole('button', { name: 'Resume' }))
      await waitFor(() => expect(writes().length).toBe(1))
      expect(writes()[0]!.body).toEqual({ to: before })
    },
  )

  it('cancelling asks first, says it is final, and only then moves the project', async () => {
    await renderProject(projectDetail({ state: 'active' }), {
      'POST /projects/p1/transitions': () => ({
        status: 200,
        body: projectDetail({ state: 'cancelled', version: 4 }),
      }),
    })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel project' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Cancel this project?' })
    expect(dialog.textContent).toContain('final')
    expect(writes()).toEqual([])
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep project' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(writes()).toEqual([])

    fireEvent.click(screen.getByRole('button', { name: 'Cancel project' }))
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByTestId('project-cancel-confirm'))
    await waitFor(() => expect(actionLabels()).toEqual([]))
    expect(writes()).toEqual([
      { method: 'POST', path: '/projects/p1/transitions', ifMatch: '"3"', body: { to: 'cancelled' } },
    ])
  })

  it('a refused move (409 invalid_transition) says so and changes nothing on the page', async () => {
    await renderProject(projectDetail({ state: 'planned' }), {
      'POST /projects/p1/transitions': () => problem(409, 'invalid_transition'),
    })
    fireEvent.click(screen.getByRole('button', { name: 'Start project' }))
    const banner = await screen.findByTestId('project-action-error')
    expect(banner.textContent).toContain('cannot move to that state')
    expect(actionLabels()).toEqual(['Start project', 'Put on hold', 'Cancel project'])
  })
})

describe('internal → SaaS (AC-1.2)', () => {
  it('"Make SaaS" is offered on an internal project only', async () => {
    for (const type of ['t_and_m', 'fixed_price', 'maintenance', 'saas'] as const) {
      await renderProject(projectDetail({ type }))
      expect(screen.queryByRole('button', { name: 'Make SaaS' })).toBeNull()
      cleanup()
    }
    await renderProject(projectDetail({ type: 'internal', company: null }))
    expect(screen.getByRole('button', { name: 'Make SaaS' })).not.toBeNull()
  })

  it('asks first, then PUTs the type with the version, and the project becomes SaaS', async () => {
    await renderProject(projectDetail({ type: 'internal', company: null }), {
      'PUT /projects/p1/type': () => ({
        status: 200,
        body: projectDetail({ type: 'saas', company: null, version: 4 }),
      }),
    })
    fireEvent.click(screen.getByRole('button', { name: 'Make SaaS' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Make this project SaaS?' })
    expect(writes()).toEqual([])
    fireEvent.click(within(dialog).getByTestId('project-saas-confirm'))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Make SaaS' })).toBeNull())
    expect(writes()).toEqual([{ method: 'PUT', path: '/projects/p1/type', ifMatch: '"3"', body: { type: 'saas' } }])
    expect(screen.getByTestId('project-facts').textContent).toContain('SaaS')
  })

  it('a refusal (409 type_change_refused) stays in the dialog, which stays open', async () => {
    await renderProject(projectDetail({ type: 'internal', company: null }), {
      'PUT /projects/p1/type': () => problem(409, 'type_change_refused'),
    })
    fireEvent.click(screen.getByRole('button', { name: 'Make SaaS' }))
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByTestId('project-saas-confirm'))
    expect((await screen.findByTestId('project-saas-error')).textContent).toContain('Only an internal project')
    expect(screen.getByRole('alertdialog')).not.toBeNull()
  })
})

describe('who may change the project (AC-4.4)', () => {
  const NO_CONTROLS = ['project-actions']

  it.each<[string, Scope]>([
    ['manages nothing', scope()],
    ['manages only the other entity', scope({ manage: ['welld_it'] })],
  ])('a caller who %s reads the project and gets no control', async (_name, callerScope) => {
    await renderProject(projectDetail({ state: 'planned', type: 'internal', company: null }), {}, callerScope)
    for (const id of NO_CONTROLS) expect(screen.queryByTestId(id)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Make SaaS' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Edit details' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Edit team' })).toBeNull()
    expect(screen.getByText('You can read this project but not change it.')).not.toBeNull()
    expect(screen.getByRole('heading', { level: 2, name: 'Intranet' })).not.toBeNull()
  })

  it('the controls are there for the entity the caller manages', async () => {
    await renderProject(projectDetail({ state: 'planned' }), {}, scope({ manage: ['welld_ch'] }))
    expect(actionLabels()).toContain('Start project')
    expect(screen.queryByText('You can read this project but not change it.')).toBeNull()
  })
})

describe('a stale write (AC-1.7)', () => {
  it('409 version_conflict asks the person to reload, and Reload reads the project again', async () => {
    let reads = 0
    await renderProject(projectDetail({ state: 'planned' }), {
      'GET /projects/p1': () => {
        reads += 1
        return { status: 200, body: projectDetail({ state: reads === 1 ? 'planned' : 'active', version: 3 + reads }) }
      },
      'POST /projects/p1/transitions': () => problem(409, 'version_conflict', { currentVersion: 4 }),
    })
    fireEvent.click(screen.getByRole('button', { name: 'Start project' }))
    const banner = await screen.findByTestId('projects-stale-write')
    expect(banner.textContent).toContain('Reload')
    fireEvent.click(screen.getByTestId('projects-stale-write-reload'))
    await waitFor(() => expect(actionLabels()).toEqual(['Put on hold', 'Close project', 'Cancel project']))
    expect(screen.queryByTestId('projects-stale-write')).toBeNull()
    expect(reads).toBe(2)
  })

  it('428 (no precondition) is treated the same, and a stale cancel closes its dialog for the banner', async () => {
    await renderProject(projectDetail({ state: 'active' }), {
      'POST /projects/p1/transitions': () => problem(428, 'precondition_required'),
    })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel project' }))
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByTestId('project-cancel-confirm'))
    expect(await screen.findByTestId('projects-stale-write')).not.toBeNull()
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })
})

describe('editing the name and the project manager (AC-1.6, AC-1.7)', () => {
  const openEdit = async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Edit details' }))
    return screen.findByRole('dialog', { name: 'Edit project' })
  }

  it('starts from the current values and sends only what changed, with the version', async () => {
    await renderProject(projectDetail(), {
      'PATCH /projects/p1': () => ({ status: 200, body: projectDetail({ name: 'Intranet 2', version: 4 }) }),
    })
    const dialog = await openEdit()
    expect((within(dialog).getByLabelText(/^Name/) as HTMLInputElement).value).toBe('Intranet')
    fireEvent.change(within(dialog).getByLabelText(/^Name/), { target: { value: ' Intranet 2 ' } })
    fireEvent.click(within(dialog).getByTestId('project-edit-submit'))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(writes()).toEqual([{ method: 'PATCH', path: '/projects/p1', ifMatch: '"3"', body: { name: 'Intranet 2' } }])
    expect(screen.getByRole('heading', { level: 2, name: 'Intranet 2' })).not.toBeNull()
  })

  it('picks the project manager among the people with access to the module (ADR-0055)', async () => {
    await renderProject(projectDetail(), {
      'PATCH /projects/p1': () => ({ status: 200, body: projectDetail({ projectManager: BOB_PERSON, version: 4 }) }),
    })
    const dialog = await openEdit()
    const picker = within(dialog).getByRole('combobox', { name: /Project manager/ })
    fireEvent.focus(picker)
    expect((await within(dialog).findAllByRole('option')).map((option) => option.textContent)).toEqual([
      'Bob Builderbob@welld.ch',
      'Cara Codercara@welld.ch',
    ])
    const directory = apiFetch.mock.calls
      .map(([input]) => new URL(String(input)))
      .find((url) => url.pathname === '/authz/users/directory')!
    expect(directory.searchParams.get('appId')).toBe('projects')
    fireEvent.click(within(dialog).getByRole('option', { name: /Bob Builder/ }))
    fireEvent.click(within(dialog).getByTestId('project-edit-submit'))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(writes()[0]!.body).toEqual({ projectManagerId: 'u-bob' })
    expect(screen.getByTestId('project-facts').textContent).toContain('Bob Builder')
  })

  it('a name left empty is refused before any request', async () => {
    await renderProject(projectDetail())
    const dialog = await openEdit()
    fireEvent.change(within(dialog).getByLabelText(/^Name/), { target: { value: '  ' } })
    fireEvent.click(within(dialog).getByTestId('project-edit-submit'))
    expect(await within(dialog).findByText('This field is required.')).not.toBeNull()
    expect(writes()).toEqual([])
  })

  it('a project manager without access (422 not_project_user) is refused on that field, values kept', async () => {
    await renderProject(projectDetail(), {
      'PATCH /projects/p1': () => problem(422, 'not_project_user', { userIds: ['u-bob'] }),
    })
    const dialog = await openEdit()
    fireEvent.focus(within(dialog).getByRole('combobox', { name: /Project manager/ }))
    fireEvent.click(await within(dialog).findByRole('option', { name: /Bob Builder/ }))
    fireEvent.click(within(dialog).getByTestId('project-edit-submit'))
    expect(await within(dialog).findByText(/no access to Projects/)).not.toBeNull()
    expect(screen.getByRole('dialog')).not.toBeNull()
  })

  it('a stale save closes the dialog and shows the reload banner', async () => {
    await renderProject(projectDetail(), {
      'PATCH /projects/p1': () => problem(409, 'version_conflict', { currentVersion: 9 }),
    })
    const dialog = await openEdit()
    fireEvent.change(within(dialog).getByLabelText(/^Name/), { target: { value: 'Renamed' } })
    fireEvent.click(within(dialog).getByTestId('project-edit-submit'))
    expect(await screen.findByTestId('projects-stale-write')).not.toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('the team (AC-1.5, AC-1.6)', () => {
  const openTeam = async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Edit team' }))
    return screen.findByRole('dialog', { name: 'Edit team' })
  }
  const addPerson = async (dialog: HTMLElement, name: RegExp) => {
    fireEvent.focus(within(dialog).getByRole('combobox', { name: /Add a team member/ }))
    fireEvent.click(await within(dialog).findByRole('option', { name }))
  }

  it('lists the members, and offers "Edit team" to a manager only', async () => {
    await renderProject(projectDetail({ team: [BOB_PERSON] }))
    expect(within(screen.getByTestId('project-team')).getByRole('button', { name: 'Edit team' })).not.toBeNull()
    cleanup()
    await renderProject(projectDetail({ team: [BOB_PERSON] }), {}, scope())
    expect(screen.queryByRole('button', { name: 'Edit team' })).toBeNull()
    expect(screen.getByTestId('project-team').textContent).toContain('Bob Builder')
  })

  it('adds a person picked among the module users and PUTs the whole team with the version', async () => {
    await renderProject(projectDetail({ team: [BOB_PERSON] }), {
      'PUT /projects/p1/team': () => ({
        status: 200,
        body: projectDetail({ team: [BOB_PERSON, { id: 'u-cara', name: 'Cara Coder', deleted: false }], version: 4 }),
      }),
    })
    const dialog = await openTeam()
    expect(within(dialog).getByRole('button', { name: 'Remove Bob Builder' })).not.toBeNull()
    fireEvent.focus(within(dialog).getByRole('combobox', { name: /Add a team member/ }))
    // The people already on the team are not offered again.
    expect((await within(dialog).findAllByRole('option')).map((option) => option.textContent)).toEqual([
      'Cara Codercara@welld.ch',
    ])
    fireEvent.click(within(dialog).getByRole('option', { name: /Cara Coder/ }))
    expect(within(dialog).getByRole('button', { name: 'Remove Cara Coder' })).not.toBeNull()
    expect((within(dialog).getByRole('combobox', { name: /Add a team member/ }) as HTMLInputElement).value).toBe('')
    fireEvent.click(within(dialog).getByTestId('project-team-submit'))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(writes()).toEqual([
      { method: 'PUT', path: '/projects/p1/team', ifMatch: '"3"', body: { memberIds: ['u-bob', 'u-cara'] } },
    ])
    expect(screen.getByTestId('project-team').textContent).toContain('Cara Coder')
  })

  it('removing the last member sends an empty team', async () => {
    await renderProject(projectDetail({ team: [BOB_PERSON] }), {
      'PUT /projects/p1/team': () => ({ status: 200, body: projectDetail({ team: [], version: 4 }) }),
    })
    const dialog = await openTeam()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove Bob Builder' }))
    expect(within(dialog).getByText('Nobody yet.')).not.toBeNull()
    fireEvent.click(within(dialog).getByTestId('project-team-submit'))
    await waitFor(() => expect(writes().length).toBe(1))
    expect(writes()[0]!.body).toEqual({ memberIds: [] })
    expect(await screen.findByText('No team members yet.')).not.toBeNull()
  })

  it('there is nothing to save until the team changes', async () => {
    await renderProject(projectDetail({ team: [BOB_PERSON] }))
    const dialog = await openTeam()
    expect((within(dialog).getByTestId('project-team-submit') as HTMLButtonElement).disabled).toBe(true)
  })

  it('names the people refused for lack of access (422 not_project_user), and keeps the dialog', async () => {
    await renderProject(projectDetail({ team: [] }), {
      'PUT /projects/p1/team': () => problem(422, 'not_project_user', { userIds: ['u-cara'] }),
    })
    const dialog = await openTeam()
    await addPerson(dialog, /Cara Coder/)
    fireEvent.click(within(dialog).getByTestId('project-team-submit'))
    expect((await within(dialog).findByTestId('project-team-error')).textContent).toContain('Cara Coder')
    expect(within(dialog).getByRole('button', { name: 'Remove Cara Coder' })).not.toBeNull()
  })

  it('says so when the user directory is down (503 identity_unavailable), nothing changed', async () => {
    await renderProject(projectDetail({ team: [] }), {
      'PUT /projects/p1/team': () => problem(503, 'identity_unavailable'),
    })
    const dialog = await openTeam()
    await addPerson(dialog, /Cara Coder/)
    fireEvent.click(within(dialog).getByTestId('project-team-submit'))
    expect((await within(dialog).findByTestId('project-team-error')).textContent).toContain('cannot be reached')
  })

  it('a stale save closes the dialog and shows the reload banner', async () => {
    await renderProject(projectDetail({ team: [] }), {
      'PUT /projects/p1/team': () => problem(409, 'version_conflict', { currentVersion: 9 }),
    })
    const dialog = await openTeam()
    await addPerson(dialog, /Cara Coder/)
    fireEvent.click(within(dialog).getByTestId('project-team-submit'))
    expect(await screen.findByTestId('projects-stale-write')).not.toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('refuses a team of more than 100 before any request', async () => {
    const team = Array.from({ length: 100 }, (_, index) => ({
      id: `u-${index}`,
      name: `Member ${index}`,
      deleted: false,
    }))
    await renderProject(projectDetail({ team }))
    const dialog = await openTeam()
    await addPerson(dialog, /Cara Coder/)
    fireEvent.click(within(dialog).getByTestId('project-team-submit'))
    expect((await within(dialog).findByTestId('project-team-error')).textContent).toContain('at most 100')
    expect(writes()).toEqual([])
  })
})

const CONTRACT = {
  id: 'k1',
  type: 't_and_m' as const,
  company: { id: 'c1', name: 'Acme SA' },
  origin: 'manual' as const,
  bexioOrderId: null,
  startDate: '2026-02-01',
  endDate: null,
}
