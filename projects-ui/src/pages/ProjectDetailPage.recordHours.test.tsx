/**
 * @vitest-environment jsdom
 *
 * ProjectDetailPage × Record hours (specs/20261116-record-hours-in-place AC-1.1, AC-1.2, AC-4.5, AC-4.6): the
 * project's manager and the members of its team are offered hours-ui's widget as the FIRST action of the header,
 * through the shell's `hours.recordHours` extension with the six plain strings of the project; anyone else who can
 * read the project is offered nothing. When the widget cannot be had the page works as before and shows a link to
 * My hours in its place. Rendered through the app's real router against a fake projects-api; `shell/extensions`
 * is a spy that records what the page hands the widget (the real one is the shell's).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, within } from '@testing-library/react'
import { RouterProvider } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { createAppRouter } from '../router'
import { ADA, OLGA, fakeApi, projectDetail, scope } from '../test-support/fakeApi'
import { scopeRoot } from '../test-support/scopeRoot'
import type { Person, Project, Scope } from '../lib/types'

type Mode = 'ready' | 'fallsBack' | 'noExport'
type Call = { name: string; props: Record<string, unknown>; hasLoading: boolean }
const { apiFetch, session, seam } = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  session: { id: 'u-ada' as string | null },
  seam: { mode: 'ready' as Mode, calls: [] as Call[] },
}))

vi.mock('shell/session', () => ({
  apiFetch,
  getProjectsApiBaseUrl: () => 'http://projects-api.test',
  getAuthBaseUrl: () => 'http://auth.test',
  getActivitiesApiBaseUrl: () => 'http://activities-api.test',
  useSession: () => ({ data: session.id === null ? null : { user: { id: session.id, name: 'Someone' } } }),
}))

vi.mock('shell/extensions', () => {
  const HostExtension = ({
    name,
    props,
    fallback,
    ...rest
  }: {
    name: string
    props: Record<string, unknown>
    fallback: ReactNode
    loading?: ReactNode
  }) => {
    seam.calls.push({ name, props, hasLoading: 'loading' in rest })
    return seam.mode === 'fallsBack' ? <>{fallback}</> : <button data-testid="widget-record-hours">Record hours</button>
  }
  return {
    get HostExtension() {
      return seam.mode === 'noExport' ? undefined : HostExtension
    },
  }
})

const MANAGER = scope({ manage: ['welld_ch'] })
const BOB: Person = { id: 'u-bob', name: 'Bob Builder', deleted: false }

const renderProject = async (project: Project, callerScope: Scope = MANAGER) => {
  apiFetch.mockImplementation(
    fakeApi({
      [`GET /projects/${project.id}`]: () => ({ status: 200, body: project }),
      'GET /tasks': () => ({ status: 200, body: { items: [], total: 0, page: 1, pageSize: 25 } }),
      'GET /authz/users/directory': () => ({ status: 200, body: { users: [] } }),
    }),
  )
  window.history.pushState(null, '', `/${project.id}`)
  const view = render(<RouterProvider router={createAppRouter(undefined, scopeRoot(callerScope))} />)
  await screen.findByTestId('project-detail-page')
  // Let the wrapper's dynamic import of `shell/extensions` settle, so an absence below is not just "not yet".
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 25))
  })
  return view
}

/** The header's action cluster, which PageHeader draws only when it has something to hold. */
const headerActions = (container: HTMLElement) => container.querySelector('.page-actions')

beforeEach(() => {
  seam.mode = 'ready'
  seam.calls = []
  session.id = 'u-ada'
  window.scrollTo = () => undefined
  window.requestAnimationFrame = (callback: FrameRequestCallback) => {
    callback(0)
    return 0
  }
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

describe('Record hours on the project page — who is offered it (AC-1.1, AC-1.2)', () => {
  it('offers it to a member of the team with the six plain strings of the project, as the first header action', async () => {
    session.id = BOB.id
    const { container } = await renderProject(
      projectDetail({ id: 'p-9', name: 'Alpenstrom — portale clienti', projectManager: ADA, team: [BOB] }),
    )

    expect(seam.calls.length).toBeGreaterThan(0)
    for (const call of seam.calls) {
      expect(call.name).toBe('hours.recordHours')
      expect(call.props).toEqual({
        on: 'project',
        targetId: 'p-9',
        targetName: 'Alpenstrom — portale clienti',
        activityId: '',
        activityName: '',
        placement: 'page',
      })
      // Nothing is shown while the widget loads: the page asks for no placeholder.
      expect(call.hasLoading).toBe(false)
    }
    const actions = headerActions(container)!
    expect(actions.firstElementChild).toBe(screen.getByTestId('widget-record-hours'))
  })

  it('puts it ahead of the manage actions for a manager who is also on the team, so it is always at the left end', async () => {
    // Ada is the project manager and manages welld_ch: the state actions follow the widget.
    const { container } = await renderProject(projectDetail({ projectManager: ADA, team: [] }))
    const actions = headerActions(container)!
    const widget = screen.getByTestId('widget-record-hours')
    const states = screen.getByTestId('project-actions')
    expect(actions.firstElementChild).toBe(widget)
    expect(actions.contains(states)).toBe(true)
    expect(widget.compareDocumentPosition(states) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(within(states).queryByText('Record hours')).toBeNull()
  })

  it('offers it to the project manager who cannot manage the project: it does not depend on the manage scope', async () => {
    await renderProject(projectDetail({ projectManager: ADA }), scope())
    expect(screen.getByTestId('widget-record-hours')).not.toBeNull()
    expect(screen.queryByTestId('project-actions')).toBeNull()
  })

  it('offers it to nobody else who can read the project — not even one who manages it (AC-1.2)', async () => {
    session.id = 'u-reader'
    const { container } = await renderProject(projectDetail({ projectManager: ADA, team: [BOB] }))
    expect(seam.calls).toEqual([])
    expect(screen.queryByTestId('widget-record-hours')).toBeNull()
    expect(screen.queryByTestId('record-hours-fallback')).toBeNull()
    // The manager of the entity still has the state actions, now first.
    expect(headerActions(container)!.firstElementChild).toBe(screen.getByTestId('project-actions'))
  })

  it('draws no empty header cluster for a reader with nothing to do', async () => {
    session.id = 'u-reader'
    const { container } = await renderProject(projectDetail({ projectManager: ADA, team: [BOB] }), scope())
    expect(seam.calls).toEqual([])
    expect(headerActions(container)).toBeNull()
  })

  it('offers it to nobody while the session has not given the person’s id', async () => {
    session.id = null
    await renderProject(projectDetail({ projectManager: ADA, team: [BOB] }))
    expect(seam.calls).toEqual([])
    expect(screen.queryByTestId('widget-record-hours')).toBeNull()
  })

  it('offers it to a team member of a project that awaits its manager, and to nobody else (`projectManager: null`)', async () => {
    const awaiting = projectDetail({
      projectManager: null,
      awaitingProjectManager: true,
      state: 'planned',
      team: [BOB],
      purchaseOrder: {
        id: 'po1',
        deal: { id: 'd1', title: 'Website relaunch', won: true },
        estimate: null,
        bexioOrderId: null,
        referent: null,
        opsManager: OLGA,
        version: 2,
      },
    })

    session.id = 'u-reader'
    await renderProject(awaiting)
    expect(seam.calls).toEqual([])
    cleanup()

    session.id = BOB.id
    await renderProject(awaiting)
    expect(screen.getByTestId('widget-record-hours')).not.toBeNull()
  })

  it('offers no hours action besides Record hours: one widget, and the page has no Edit or Delete of hours (AC-4.4)', async () => {
    await renderProject(projectDetail({ projectManager: ADA }))
    expect(new Set(seam.calls.map((call) => call.name))).toEqual(new Set(['hours.recordHours']))
    expect(screen.getAllByTestId('widget-record-hours')).toHaveLength(1)
  })
})

describe('Record hours on the project page — when the hours screens cannot be loaded (AC-4.5)', () => {
  it('works as before and shows a link to My hours in the widget’s place, for a person who would have had the button', async () => {
    seam.mode = 'fallsBack'
    const { container } = await renderProject(projectDetail({ name: 'Intranet', projectManager: ADA }))

    expect(screen.getByRole('heading', { name: 'Intranet' })).not.toBeNull()
    expect(screen.getByTestId('project-facts')).not.toBeNull()
    expect(screen.getByTestId('project-actions')).not.toBeNull()
    const link = screen.getByRole('link', { name: 'Record hours in My hours' })
    expect(link.getAttribute('href')).toBe('/hours')
    expect(headerActions(container)!.firstElementChild).toBe(link)
  })

  it('shows no link to a person who would not have had the button', async () => {
    seam.mode = 'fallsBack'
    session.id = 'u-reader'
    await renderProject(projectDetail({ projectManager: ADA }))
    expect(screen.queryByRole('link', { name: 'Record hours in My hours' })).toBeNull()
  })

  it('shows the link too when the shell has no HostExtension (a shell that predates the expose)', async () => {
    seam.mode = 'noExport'
    await renderProject(projectDetail({ projectManager: ADA }))
    expect(screen.getByRole('link', { name: 'Record hours in My hours' }).getAttribute('href')).toBe('/hours')
    expect(screen.getByTestId('project-facts')).not.toBeNull()
  })
})
