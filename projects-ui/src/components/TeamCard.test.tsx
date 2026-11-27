/**
 * @vitest-environment jsdom
 *
 * TeamCard (specs/20261126-teams AC-1.3, AC-4.1, AC-4.2, AC-4.3, AC-4.7, AC-5.4, AC-5.6; design S6, F16): the Team
 * card has a People section (the listed team, unchanged) and a Teams section — each attached team by its LIVE name
 * (never a copy), its members with the Deactivated / No access to Projects badges, and, by the project's one
 * `teamsStatus` (the Status rule), at most one banner: "Some teams could not be loaded" (AC-5.4) or "Too many requests"
 * (AC-5.6), never both, never a guess. Retry reloads the project in place; the card keeps focus where a screen-reader
 * user left it.
 */
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ADA, projectDetail } from '../test-support/fakeApi'
import type { AttachedTeamView, Project, TeamMemberView, TeamsStatus } from '../lib/types'

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock('shell/session', () => ({
  usePermissions: () => ({ epoch: 0, apps: [], roles: [], departments: [], permissions: [] }),
  apiFetch,
  getProjectsApiBaseUrl: () => 'http://projects-api.test',
  getAuthBaseUrl: () => 'http://auth.test',
  useSession: () => ({ data: { user: { id: 'u-ada', name: 'Ada Lovelace' } } }),
}))

import TeamCard from './TeamCard'

const member = (id: string, name: string | null, over: Partial<TeamMemberView> = {}): TeamMemberView => ({
  id,
  name,
  deleted: false,
  projectsAccess: true,
  ...over,
})

const team = (
  id: string,
  name: string | null,
  members: TeamMemberView[] | null,
  archived: boolean | null = false,
): AttachedTeamView => ({ id, name, archived, members })

const BACKEND = team('t-back', 'Backend', [
  member('u-bob', 'Bob Builder'),
  member('u-gone', null, { deleted: true, projectsAccess: false }),
  member('u-nox', 'Nora NoAccess', { projectsAccess: false }),
])
const DESIGN = team('t-design', 'Design', [member('u-cara', 'Cara Coder')], true)

const projectWith = (teams: AttachedTeamView[], over: Partial<Project> = {}): Project =>
  projectDetail({
    teams,
    onProject: [ADA],
    onProjectComplete: true,
    teamsStatus: 'complete',
    teamsRetryAfterSeconds: null,
    ...over,
  })

const limited = (teams: AttachedTeamView[], seconds: number | null = 150, over: Partial<Project> = {}) =>
  projectWith(
    teams.map((entry) => team(entry.id, null, null, null)),
    { onProjectComplete: false, teamsStatus: 'rate_limited', teamsRetryAfterSeconds: seconds, ...over },
  )

const onSaved = vi.fn()
const onStale = vi.fn()
const reload = vi.fn<() => Promise<Project | null>>()

const renderCard = (project: Project, canManage = true) => {
  render(
    <TeamCard
      project={project}
      currentUserId="u-ada"
      canManage={canManage}
      onSaved={onSaved}
      onStale={onStale}
      onReloadTeams={reload}
    />,
  )
  return screen.getByTestId('project-team')
}

/** The page's part of a reload: the next answers are served in order and become the card's project. */
function Harness({ first, next }: { first: Project; next: Project[] }) {
  const [project, setProject] = useState(first)
  const answers = useState(() => [...next])[0]
  return (
    <TeamCard
      project={project}
      currentUserId="u-ada"
      canManage
      onSaved={onSaved}
      onStale={onStale}
      onReloadTeams={async () => {
        const answer = answers.shift()!
        reload()
        setProject(answer)
        return answer
      }}
    />
  )
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

const banners = () => ({
  unavailable: screen.queryByTestId('project-attached-teams-unavailable'),
  rateLimited: screen.queryByTestId('project-attached-teams-rate-limited'),
})

describe('the People and Teams sections (AC-1.3, AC-4.1)', () => {
  it('has a People section with the listed people, and a Teams section, under one Team card', () => {
    const card = renderCard(projectWith([BACKEND], { team: [{ id: 'u-d', name: 'Dora Dev', deleted: false }] }))
    expect(within(card).getByRole('heading', { level: 3, name: 'Team' })).not.toBeNull()
    expect(within(card).getByRole('heading', { level: 4, name: 'People' })).not.toBeNull()
    expect(within(card).getByRole('heading', { level: 4, name: 'Teams' })).not.toBeNull()
    expect(within(screen.getByTestId('project-team-people')).getByText('Dora Dev')).not.toBeNull()
  })

  it('says so when nobody is listed, and when no team is attached', () => {
    const card = renderCard(projectWith([]))
    expect(within(card).getByText('No people listed yet.')).not.toBeNull()
    expect(within(card).getByText('No teams attached.')).not.toBeNull()
  })

  it('offers "Edit people" and "Edit teams" to a manager, each in its own section, and neither to anyone else', () => {
    renderCard(projectWith([BACKEND]))
    const people = screen.getByTestId('project-team-people')
    const teams = screen.getByTestId('project-attached-teams')
    expect(within(people).getByRole('button', { name: 'Edit people' })).not.toBeNull()
    expect(within(people).queryByRole('button', { name: 'Edit teams' })).toBeNull()
    expect(within(teams).getByRole('button', { name: 'Edit teams' })).not.toBeNull()
    cleanup()
    renderCard(projectWith([BACKEND]), false)
    expect(screen.queryByRole('button', { name: /^Edit/ })).toBeNull()
  })

  it('shows a team by the name it has now, its members and who counts (AC-1.3, AC-4.3, AC-4.7)', () => {
    renderCard(projectWith([BACKEND]))
    const block = screen.getByTestId('project-attached-team-t-back')
    expect(within(block).getByTestId('project-attached-team-name-t-back').textContent).toBe('Backend')
    // Bob counts; the deactivated and the one without access do not.
    expect(within(block).getByTestId('project-attached-team-count-t-back').textContent).toBe(
      '1 person counts on this project',
    )
    const members = within(block).getByRole('list', { name: 'Members of Backend' })
    expect(within(members).getAllByRole('listitem')).toHaveLength(3)
    expect(within(members).getByText('Bob Builder')).not.toBeNull()
    expect(within(members).getByText('Deleted user')).not.toBeNull()
    expect(
      within(screen.getByTestId('project-attached-team-member-deactivated-t-back-u-gone')).getByText('Deactivated'),
    ).not.toBeNull()
    expect(
      within(screen.getByTestId('project-attached-team-member-noaccess-t-back-u-nox')).getByText(
        'No access to Projects',
      ),
    ).not.toBeNull()
    expect(screen.queryByTestId('project-attached-team-member-noaccess-t-back-u-bob')).toBeNull()
    // A deactivated member is marked Deactivated only: auth reports no access for every deactivated account, so a second badge would say nothing new.
    expect(screen.queryByTestId('project-attached-team-member-noaccess-t-back-u-gone')).toBeNull()
    expect(screen.queryByTestId('project-attached-team-member-deactivated-t-back-u-bob')).toBeNull()
    expect(screen.getByTestId('project-attached-teams-legend').textContent).toBe(
      'People marked “No access to Projects” do not count as on this project until an administrator gives them access.',
    )
  })

  it('shows no legend when everyone has access, and says a team without members has none', () => {
    renderCard(projectWith([team('t-a', 'Alpha', [member('u-1', 'One')]), team('t-e', 'Empty', [])]))
    expect(screen.queryByTestId('project-attached-teams-legend')).toBeNull()
    expect(
      within(screen.getByTestId('project-attached-team-t-e')).getByText('This team has no members.'),
    ).not.toBeNull()
  })

  it('marks an archived team with a badge and a note, its members still counting (AC-4.2)', () => {
    renderCard(projectWith([DESIGN]))
    const block = screen.getByTestId('project-attached-team-t-design')
    expect(within(block).getByTestId('project-attached-team-archived-t-design').textContent).toContain('Archived')
    expect(within(block).getByText('Archived: it stays on this project until it is removed.')).not.toBeNull()
    expect(within(block).getByTestId('project-attached-team-count-t-design').textContent).toBe(
      '1 person counts on this project',
    )
  })

  it('shows teams in the order the server sent them', () => {
    renderCard(projectWith([DESIGN, BACKEND]))
    expect(
      within(screen.getByRole('list', { name: 'Attached teams' }))
        .getAllByTestId(/^project-attached-team-name-/)
        .map((name) => name.textContent),
    ).toEqual(['Design', 'Backend'])
  })

  it('shows the first 12 members of a long team and the rest on request (AC-4.3, O9)', () => {
    const many = team(
      't-big',
      'Big',
      Array.from({ length: 34 }, (_, index) => member(`u-${index}`, `Person ${index}`)),
    )
    renderCard(projectWith([many]))
    const list = screen.getByTestId('project-attached-team-members-t-big')
    expect(within(list).getAllByRole('listitem')).toHaveLength(12)
    const more = screen.getByTestId('project-attached-team-more-t-big')
    expect(more.textContent).toBe('Show all 34 people')
    expect(more.getAttribute('aria-expanded')).toBe('false')
    expect(more.getAttribute('aria-controls')).toBe(list.id)
    fireEvent.click(more)
    expect(within(list).getAllByRole('listitem')).toHaveLength(34)
    expect(more.textContent).toBe('Show fewer')
    expect(more.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(more)
    expect(within(list).getAllByRole('listitem')).toHaveLength(12)
  })

  it('needs no toggle for 12 members or fewer', () => {
    renderCard(
      projectWith([
        team(
          't-12',
          'Twelve',
          Array.from({ length: 12 }, (_, index) => member(`u-${index}`, `P ${index}`)),
        ),
      ]),
    )
    expect(screen.queryByTestId('project-attached-team-more-t-12')).toBeNull()
  })

  it('opens the Edit teams dialog beside the card, never inside a form (ADR 20261118)', () => {
    renderCard(projectWith([BACKEND]))
    fireEvent.click(screen.getByTestId('project-attached-teams-edit'))
    expect(screen.getByRole('dialog', { name: 'Edit teams' })).not.toBeNull()
    expect(document.querySelectorAll('form form').length).toBe(0)
    expect(screen.getByTestId('project-team').contains(screen.getByRole('dialog'))).toBe(false)
  })

  it('opens the Edit people dialog from its own section', () => {
    renderCard(projectWith([BACKEND]))
    fireEvent.click(screen.getByTestId('project-team-edit'))
    expect(screen.getByRole('dialog', { name: 'Edit team' })).not.toBeNull()
    expect(document.querySelectorAll('form form').length).toBe(0)
  })
})

describe('a team that could not be read (AC-5.4)', () => {
  it('keeps the name it still has and says the members could not be loaded, guessing nothing', () => {
    renderCard(
      projectWith([team('t-a', 'Alpha', null), team('t-b', 'Beta', [member('u-1', 'One')])], {
        onProjectComplete: false,
        teamsStatus: 'unavailable',
      }),
    )
    const block = screen.getByTestId('project-attached-team-t-a')
    expect(within(block).getByTestId('project-attached-team-name-t-a').textContent).toBe('Alpha')
    expect(within(block).getByTestId('project-attached-team-members-unavailable-t-a').textContent).toBe(
      'Members could not be loaded',
    )
    expect(within(block).queryByRole('list', { name: /Members of/ })).toBeNull()
    expect(within(block).queryByTestId('project-attached-team-count-t-a')).toBeNull()
    expect(within(screen.getByTestId('project-attached-team-t-b')).getByText('One')).not.toBeNull()
  })

  it('says "Team could not be loaded" for a team with no name', () => {
    renderCard(projectWith([team('t-x', null, null, null)], { onProjectComplete: false, teamsStatus: 'unavailable' }))
    const block = screen.getByTestId('project-attached-team-t-x')
    expect(within(block).getByTestId('project-attached-team-name-t-x').textContent).toBe('Team could not be loaded')
    expect(within(block).queryByTestId('project-attached-team-archived-t-x')).toBeNull()
  })

  it('tells how the unavailable state affects the lists of people, once, as a polite banner with Retry', () => {
    renderCard(projectWith([team('t-a', 'Alpha', null)], { onProjectComplete: false, teamsStatus: 'unavailable' }))
    const banner = screen.getByTestId('project-attached-teams-unavailable')
    expect(banner.getAttribute('role')).toBe('status')
    expect(within(banner).getByText('Some teams could not be loaded')).not.toBeNull()
    expect(banner.textContent).toContain('People who are on this project only through a team may be missing')
    expect(banner.textContent).not.toContain('Nothing was changed')
    expect(within(banner).getByRole('button', { name: 'Retry' })).not.toBeNull()
    expect(banners().rateLimited).toBeNull()
  })
})

describe('the Status rule: one banner, by teamsStatus (S6)', () => {
  const unavailableOf = (over: Partial<Project> = {}) =>
    projectWith([BACKEND], { onProjectComplete: false, teamsStatus: 'unavailable', ...over })

  it('shows no banner for complete', () => {
    renderCard(projectWith([BACKEND]))
    expect(banners()).toEqual({ unavailable: null, rateLimited: null })
  })

  it('shows no banner without a team, whatever the status says', () => {
    renderCard(projectWith([], { teamsStatus: 'rate_limited', onProjectComplete: false, teamsRetryAfterSeconds: 60 }))
    expect(banners()).toEqual({ unavailable: null, rateLimited: null })
    expect(screen.getByText('No teams attached.')).not.toBeNull()
  })

  it.each([
    ['an unknown value', { teamsStatus: 'quota' as unknown as TeamsStatus, onProjectComplete: false }],
    ['a null status', { teamsStatus: null, onProjectComplete: false }],
    ['a missing status', { teamsStatus: undefined, onProjectComplete: undefined }],
    ['complete with an incomplete onProject', { teamsStatus: 'complete' as const, onProjectComplete: false }],
    ['rate_limited with a complete onProject', { teamsStatus: 'rate_limited' as const, onProjectComplete: true }],
  ])('reads %s as "could not be loaded", never as silence', (_name, over) => {
    renderCard(projectWith([BACKEND], over))
    expect(banners().unavailable).not.toBeNull()
    expect(banners().rateLimited).toBeNull()
  })

  it('shows the service’s own window (unavailable, no wait) as "could not be loaded", not as too many requests', () => {
    renderCard(unavailableOf({ teamsRetryAfterSeconds: null }))
    expect(banners().unavailable).not.toBeNull()
    expect(banners().rateLimited).toBeNull()
  })
})

describe('over the person’s limit (AC-5.6, F16)', () => {
  it('marks every team as one that could not be loaded and shows the Too many requests banner instead of the other', () => {
    renderCard(limited([BACKEND, DESIGN]))
    for (const id of ['t-back', 't-design']) {
      const block = screen.getByTestId(`project-attached-team-${id}`)
      expect(within(block).getByTestId(`project-attached-team-name-${id}`).textContent).toBe('Team could not be loaded')
      expect(within(block).getByTestId(`project-attached-team-members-unavailable-${id}`).textContent).toBe(
        'Members could not be loaded',
      )
      expect(within(block).queryByTestId(`project-attached-team-archived-${id}`)).toBeNull()
      expect(within(block).queryByTestId(`project-attached-team-count-${id}`)).toBeNull()
    }
    expect(screen.queryByTestId('project-attached-teams-legend')).toBeNull()
    expect(banners().unavailable).toBeNull()
    const banner = banners().rateLimited!
    expect(banner.getAttribute('role')).toBe('status')
    expect(within(banner).getByTestId('project-attached-teams-rate-limited-title').textContent).toBe(
      'Too many requests',
    )
    expect(banner.textContent).toContain(
      'You made too many requests, so teams and their members are not shown for now.',
    )
    expect(banner.textContent).toContain('may not be offered Record hours on this page')
    expect(banner.textContent).toContain('You can still record hours from My hours.')
    expect(banner.textContent).not.toContain('Nothing was changed')
  })

  it.each([
    [150, 'Try again in 3 minutes.'],
    [180, 'Try again in 3 minutes.'],
    [181, 'Try again in 4 minutes.'],
    [60, 'Try again in a minute.'],
    [1, 'Try again in a minute.'],
    [600, 'Try again in 10 minutes.'],
    [null, 'Try again later.'],
    [0, 'Try again later.'],
    [12.5, 'Try again later.'],
  ])('rounds %s seconds up to whole minutes: %s', (seconds, sentence) => {
    renderCard(limited([BACKEND], seconds))
    expect(banners().rateLimited!.textContent).toContain(sentence)
  })

  it('keeps the people editors and Edit teams for a manager, and the rest of the card unchanged', () => {
    renderCard(limited([BACKEND], 150, { team: [{ id: 'u-d', name: 'Dora Dev', deleted: false }] }))
    expect(screen.getByRole('button', { name: 'Edit teams' })).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Edit people' })).not.toBeNull()
    expect(screen.getByText('Dora Dev')).not.toBeNull()
  })
})

describe('Retry (S6 "Retry behaviour")', () => {
  it('reloads once, and a second click while it is in flight does nothing', async () => {
    let settle!: (project: Project | null) => void
    const pending = new Promise<Project | null>((resolve) => (settle = resolve))
    reload.mockReturnValue(pending)
    renderCard(limited([BACKEND]))
    const retry = screen.getByTestId('project-attached-teams-rate-limited-retry')
    fireEvent.click(retry)
    fireEvent.click(retry)
    expect(reload).toHaveBeenCalledTimes(1)
    await act(async () => settle(null))
    fireEvent.click(retry)
    expect(reload).toHaveBeenCalledTimes(2)
  })

  it('uses the same handler for the unavailable banner', () => {
    reload.mockResolvedValue(null)
    renderCard(projectWith([BACKEND], { onProjectComplete: false, teamsStatus: 'unavailable' }))
    fireEvent.click(screen.getByTestId('project-attached-teams-unavailable-retry'))
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('keeps the banner and the focus on Retry while still limited, updates the minutes and says it checked again', async () => {
    render(<Harness first={limited([BACKEND], 400)} next={[limited([BACKEND], 100)]} />)
    const retry = screen.getByTestId('project-attached-teams-rate-limited-retry')
    expect(screen.getByTestId('project-attached-teams-rate-limited').textContent).toContain('7 minutes')
    const status = screen.getByTestId('project-attached-teams-retry-status')
    expect(status.getAttribute('aria-live')).toBe('polite')
    expect(status.textContent).toBe('')
    retry.focus()
    fireEvent.click(retry)
    await waitFor(() => expect(status.textContent).toBe('Checked again. Teams are still not shown.'))
    expect(screen.getByTestId('project-attached-teams-rate-limited').textContent).toContain('2 minutes')
    // The very same element, still focused: no remount, no lost place.
    expect(screen.getByTestId('project-attached-teams-rate-limited-retry')).toBe(retry)
    expect(document.activeElement).toBe(retry)
  })

  it('says it again after a second click with the same answer (the line is cleared first)', async () => {
    render(<Harness first={limited([BACKEND], 400)} next={[limited([BACKEND], 400), limited([BACKEND], 400)]} />)
    const retry = screen.getByTestId('project-attached-teams-rate-limited-retry')
    const status = screen.getByTestId('project-attached-teams-retry-status')
    retry.focus()
    fireEvent.click(retry)
    await waitFor(() => expect(status.textContent).toBe('Checked again. Teams are still not shown.'))
    fireEvent.click(retry)
    expect(status.textContent).toBe('')
    await waitFor(() => expect(status.textContent).toBe('Checked again. Teams are still not shown.'))
  })

  it('shows the teams again after the wait, and moves the focus to the Teams heading when Retry goes away', async () => {
    render(<Harness first={limited([BACKEND])} next={[projectWith([BACKEND])]} />)
    const retry = screen.getByTestId('project-attached-teams-rate-limited-retry')
    retry.focus()
    fireEvent.click(retry)
    await waitFor(() => expect(banners().rateLimited).toBeNull())
    expect(screen.getByTestId('project-attached-team-name-t-back').textContent).toBe('Backend')
    const heading = screen.getByTestId('project-attached-teams-heading')
    expect(heading.tabIndex).toBe(-1)
    expect(heading.textContent).toBe('Teams')
    await waitFor(() => expect(document.activeElement).toBe(heading))
    expect(screen.getByTestId('project-attached-teams-retry-status').textContent).toBe('')
  })

  it('swaps to "could not be loaded" when the reload answers unavailable, and the focus goes to the Teams heading', async () => {
    render(
      <Harness
        first={limited([BACKEND])}
        next={[projectWith([BACKEND], { teamsStatus: 'unavailable', onProjectComplete: false })]}
      />,
    )
    const retry = screen.getByTestId('project-attached-teams-rate-limited-retry')
    retry.focus()
    fireEvent.click(retry)
    await waitFor(() => expect(banners().unavailable).not.toBeNull())
    expect(banners().rateLimited).toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('project-attached-teams-heading')))
  })

  it('does not take the focus when Retry was not the focused element', async () => {
    render(<Harness first={limited([BACKEND])} next={[projectWith([BACKEND])]} />)
    const edit = screen.getByTestId('project-attached-teams-edit')
    edit.focus()
    fireEvent.click(screen.getByTestId('project-attached-teams-rate-limited-retry'))
    await waitFor(() => expect(banners().rateLimited).toBeNull())
    // Let the reload settle completely, so a focus move (there must be none) has had its chance.
    await act(async () => {})
    expect(document.activeElement).toBe(edit)
  })

  it('leaves the card to the page when the reload fails outright (its own load-failure handling)', async () => {
    reload.mockResolvedValue(null)
    renderCard(limited([BACKEND]))
    fireEvent.click(screen.getByTestId('project-attached-teams-rate-limited-retry'))
    await waitFor(() => expect(reload).toHaveBeenCalled())
    expect(screen.getByTestId('project-attached-teams-retry-status').textContent).toBe('')
  })
})
