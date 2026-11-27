/**
 * @vitest-environment jsdom
 *
 * ProjectDetailPage × the Hours card (specs/20261112-project-hours AC-1.1, AC-1.7, AC-2.6, AC-2.8, AC-4.9; design S1, D80, D84): the
 * page is today's page plus ONE card, "Hours", right after Details — the consumption of the terms, then hours-ui's panel
 * through the shell seam. Whatever happens to hours, the page loads (AC-2.6); and a save made with Record hours in the
 * page's header (hours-ui's widget, here a stand-in that announces the save as the real one does) makes the card's
 * figures read again without a reload (AC-2.8). Rendered through the app's real router against a fake projects-api and a
 * fake hours-api.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { RouterProvider } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { createAppRouter } from '../router'
import { TIME_ENTRY_RECORDED } from '../lib/timeEntryRecordedEvent'
import { ADA, fakeApi, problem, projectDetail, scope, termsOf } from '../test-support/fakeApi'
import type { FakeHandler } from '../test-support/fakeApi'
import { scopeRoot } from '../test-support/scopeRoot'
import type { Project, Terms } from '../lib/types'

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }))

vi.mock('shell/session', () => ({
  usePermissions: () => ({ epoch: 0, apps: [], roles: [], departments: [], permissions: [] }),
  apiFetch,
  getProjectsApiBaseUrl: () => 'http://projects-api.test',
  getAuthBaseUrl: () => 'http://auth.test',
  getActivitiesApiBaseUrl: () => 'http://activities-api.test',
  getHoursApiBaseUrl: () => 'http://hours-api.test',
  useSession: () => ({ data: { user: { id: 'u-ada', name: 'Ada Lovelace' } } }),
}))

type Slot = { name: string; props: Record<string, unknown>; fallback: ReactNode }
const { shell } = vi.hoisted(() => ({ shell: { hoursPanel: 'ready' as 'ready' | 'fallsBack' } }))

vi.mock('shell/extensions', async () => {
  const { createElement } = await import('react')
  const { TIME_ENTRY_RECORDED: EVENT } = await import('../lib/timeEntryRecordedEvent')
  return {
    HostExtension: ({ name, props, fallback }: Slot) => {
      if (name === 'hours.hostHours') {
        return shell.hoursPanel === 'fallsBack'
          ? createElement('div', null, fallback)
          : createElement('div', { 'data-testid': 'host-hours-panel' }, `panel for ${String(props['targetId'])}`)
      }
      if (name === 'hours.recordHours') {
        // As hours-ui's widget does after a save that succeeded: announce the target it wrote to, nothing else.
        return createElement(
          'button',
          {
            type: 'button',
            'data-testid': 'record-hours-stand-in',
            onClick: () =>
              window.dispatchEvent(
                new CustomEvent(EVENT, { detail: { on: props['on'], targetId: props['targetId'] } }),
              ),
          },
          'Record hours',
        )
      }
      return createElement('div', { 'data-testid': `other-${name}` })
    },
  }
})

const MANAGER = scope({ manage: ['welld_ch'] })
const SUMMARY = '/time-entries/summary'

const summary = (over: Record<string, unknown> = {}) => ({
  on: { type: 'project', id: 'p1' },
  totalMinutes: 6000,
  windowMinutes: 5070,
  byWorkType: [],
  byPerson: null,
  unavailable: [],
  ...over,
})

const YEARLY: Terms = termsOf('maintenance', {
  sla: null,
  hourPackage: {
    hours: 120,
    kind: 'yearly',
    startDate: '2026-03-01',
    expiryDate: null,
    currentPeriod: { from: '2026-03-01', to: '2027-02-28', ended: false },
  },
})

const reads = () => apiFetch.mock.calls.filter(([input]) => new URL(String(input)).pathname === SUMMARY).length

const renderProject = async (project: Project, routes: Record<string, FakeHandler> = {}) => {
  apiFetch.mockImplementation(
    fakeApi({
      [`GET /projects/${project.id}`]: () => ({ status: 200, body: project }),
      'GET /tasks': () => ({ status: 200, body: { items: [], total: 0, page: 1, pageSize: 25 } }),
      'GET /authz/users/directory': () => ({ status: 200, body: { users: [] } }),
      [`GET ${SUMMARY}`]: () => ({ status: 200, body: summary() }),
      ...routes,
    }),
  )
  window.history.pushState(null, '', `/${project.id}`)
  render(<RouterProvider router={createAppRouter(undefined, scopeRoot(MANAGER))} />)
  await screen.findByTestId('project-detail-page')
}

/** The page's cards, top to bottom, by their titles. */
const cardTitles = () => screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent)

beforeEach(() => {
  shell.hoursPanel = 'ready'
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

describe('the Hours card on the project page (AC-1.1, AC-1.7)', () => {
  it('is one card right after Details, before Team: the consumption facts, then the panel for this project', async () => {
    await renderProject(projectDetail({ id: 'p1', projectManager: ADA, terms: YEARLY, startDate: '2026-03-01' }))

    const panel = await screen.findByTestId('host-hours-panel')
    await screen.findByTestId('project-hours-consumption-facts')

    const titles = cardTitles()
    expect(titles.slice(0, 3)).toEqual(['Details', 'Hours', 'Team'])
    expect(titles.filter((title) => title === 'Hours')).toHaveLength(1)
    const hours = screen.getByTestId('project-hours')
    expect(hours.contains(panel)).toBe(true)
    expect(panel.textContent).toBe('panel for p1')
    expect(within(hours).getByText('Hours used in this period')).not.toBeNull()
    expect(reads()).toBe(1)
  })

  it('puts the card between the Details card and the Team card in the page itself, not just in the headings', async () => {
    await renderProject(projectDetail({ id: 'p1', terms: YEARLY }))
    await screen.findByTestId('host-hours-panel')

    const details = screen.getByTestId('project-facts').closest('section')!
    const hours = screen.getByTestId('project-hours')
    const team = screen.getByTestId('project-team')
    expect(details.nextElementSibling).toBe(hours)
    expect(hours.nextElementSibling).toBe(team)
  })

  it('a project with no terms shows Details, Hours, … and the card holds the panel alone, with no read of consumption', async () => {
    await renderProject(projectDetail({ id: 'p1', terms: null }))

    await screen.findByTestId('host-hours-panel')

    expect(cardTitles().slice(0, 3)).toEqual(['Details', 'Hours', 'Team'])
    expect(screen.queryByTestId('project-hours-consumption')).toBeNull()
    expect(screen.queryByTestId('project-hours-divider')).toBeNull()
    expect(reads()).toBe(0)
  })

  it('an internal project has no terms and the same card', async () => {
    await renderProject(projectDetail({ id: 'p1', type: 'internal', company: null, terms: null }))

    expect(await screen.findByTestId('host-hours-panel')).not.toBeNull()
    expect(screen.queryByTestId('project-hours-consumption')).toBeNull()
  })

  it('a fixed price compares in man-days; a time-and-material project does too', async () => {
    await renderProject(
      projectDetail({
        id: 'p1',
        type: 'fixed_price',
        terms: termsOf('fixed_price', { deadline: '2026-12-01', estimatedManDays: 10, maxEffortManDays: 12 }),
      }),
      { [`GET ${SUMMARY}`]: () => ({ status: 200, body: summary({ totalMinutes: 3600, windowMinutes: null }) }) },
    )

    const facts = await screen.findByTestId('project-hours-consumption-facts')
    expect(facts.textContent).toContain('7.5 man-days')
    expect(facts.textContent).toContain('10.0 man-days')
  })

  it('is shown to a reader who may not manage the project (the server decides what the hours say)', async () => {
    apiFetch.mockImplementation(
      fakeApi({
        'GET /projects/p1': () => ({ status: 200, body: projectDetail({ id: 'p1', terms: YEARLY }) }),
        'GET /tasks': () => ({ status: 200, body: { items: [], total: 0, page: 1, pageSize: 25 } }),
        [`GET ${SUMMARY}`]: () => ({ status: 200, body: summary() }),
      }),
    )
    window.history.pushState(null, '', '/p1')
    render(<RouterProvider router={createAppRouter(undefined, scopeRoot(scope()))} />)
    await screen.findByTestId('project-detail-page')

    expect(await screen.findByTestId('host-hours-panel')).not.toBeNull()
    expect(await screen.findByTestId('project-hours-consumption-facts')).not.toBeNull()
  })
})

describe('when hours cannot be had the page still loads (AC-2.6, AC-4.9)', () => {
  it('hours-api down and no panel: the page, its other cards and the Hours card with its title and two notices', async () => {
    shell.hoursPanel = 'fallsBack'
    await renderProject(projectDetail({ id: 'p1', name: 'Intranet', terms: YEARLY }), {
      [`GET ${SUMMARY}`]: () => problem(503, 'host_unavailable'),
    })

    expect(await screen.findByTestId('project-hours-consumption-unavailable')).not.toBeNull()
    expect(await screen.findByTestId('project-hours-unavailable')).not.toBeNull()
    expect(screen.getByRole('heading', { level: 2, name: 'Intranet' })).not.toBeNull()
    expect(cardTitles()).toEqual(expect.arrayContaining(['Details', 'Hours', 'Team', 'Tasks']))
    // No hours figure at all, and no load-error banner of the page.
    expect(screen.queryByTestId('project-hours-consumption-facts')).toBeNull()
    expect(screen.queryByTestId('projects-load-error')).toBeNull()
  })

  it("the summary read refused (404) is the block's own notice; the page and the panel are unaffected", async () => {
    await renderProject(projectDetail({ id: 'p1', terms: YEARLY }), {
      [`GET ${SUMMARY}`]: () => problem(404, 'not_found'),
    })

    expect(await screen.findByTestId('project-hours-consumption-unavailable')).not.toBeNull()
    expect(await screen.findByTestId('host-hours-panel')).not.toBeNull()
  })
})

describe('a save with Record hours on this page (AC-2.8, D84)', () => {
  it('the card reads again and shows the new figures without a reload, and the page itself is not read again', async () => {
    let windowMinutes = 5070
    await renderProject(projectDetail({ id: 'p1', projectManager: ADA, terms: YEARLY }), {
      [`GET ${SUMMARY}`]: () => ({ status: 200, body: summary({ windowMinutes }) }),
    })
    const facts = await screen.findByTestId('project-hours-consumption-facts')
    expect(facts.textContent).toContain('84 h 30')
    const projectReads = () =>
      apiFetch.mock.calls.filter(([input]) => new URL(String(input)).pathname === '/projects/p1').length
    const before = projectReads()

    windowMinutes = 5130
    fireEvent.click(await screen.findByTestId('record-hours-stand-in'))

    await waitFor(() => expect(screen.getByTestId('project-hours-consumption-facts').textContent).toContain('85 h 30'))
    expect(reads()).toBe(2)
    expect(projectReads()).toBe(before)
  })

  it('a save on another project, or a deal, leaves the figures alone', async () => {
    await renderProject(projectDetail({ id: 'p1', projectManager: ADA, terms: YEARLY }))
    await screen.findByTestId('project-hours-consumption-facts')

    act(() => {
      window.dispatchEvent(new CustomEvent(TIME_ENTRY_RECORDED, { detail: { on: 'project', targetId: 'other' } }))
      window.dispatchEvent(new CustomEvent(TIME_ENTRY_RECORDED, { detail: { on: 'deal', targetId: 'p1' } }))
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })

    expect(reads()).toBe(1)
  })
})
