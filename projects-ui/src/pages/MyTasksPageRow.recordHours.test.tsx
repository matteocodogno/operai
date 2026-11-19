/**
 * @vitest-environment jsdom
 *
 * My tasks × Record hours (specs/20261116-record-hours-in-place AC-3.1 – AC-3.4, AC-3.6, AC-4.5, design S2): a
 * row of My tasks — a project task or a pre-sales task — offers hours-ui's widget, through the shell's
 * `hours.recordHours` extension, to the task's assignee and its participants and to nobody else, as the LAST item
 * of the row's actions (after "Open in CRM" on a pre-sales row), done rows included. A project task records on its
 * project and the task, a pre-sales task with a deal on that deal and the task, a pre-sales task with no deal as
 * other work with no ids. Rendered through the app's real router against a fake activities-api; `shell/extensions`
 * is a spy that records what each row hands the widget.
 *
 * `shell/extensions` is AUTOMOCKED here, with the widget set per test, and not given a `vi.mock` factory: rows mount
 * together and each asks for the module in the same tick, and vitest hands a factory mock only to the first of
 * several concurrent imports and the aliased stub file to the others (a harness limit, the one the shell's
 * extensions.test.tsx works around too; the federation runtime caches the module, so production has no such race).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { RouterProvider } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import ProjectsShell from '../components/ProjectsShell'
import { createAppRouter } from '../router'
import { fakeApi, personRef, projectTask, scope } from '../test-support/fakeApi'
import { HostExtension } from 'shell/extensions'

type Mode = 'ready' | 'fallsBack'
type Call = { name: string; props: Record<string, unknown> }
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

vi.mock('shell/extensions')

/** The widget of a shell that has hours-ui: its button; or, when it cannot be had, the host's fallback it renders. */
const widget = ({ name, props, fallback }: { name: string; props: Record<string, unknown>; fallback: ReactNode }) => {
  seam.calls.push({ name, props })
  return seam.mode === 'fallsBack' ? <>{fallback}</> : <button data-testid="widget-record-hours">Record hours</button>
}

const page = (items: unknown[]) => ({ items, total: items.length, page: 1, pageSize: 25 })

/** A pre-sales task as `GET /tasks?kind=all` returns it: a CRM company, no project, assigned to `u-ada`. */
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

const renderPage = async (items: unknown[], first: string) => {
  apiFetch.mockImplementation(
    fakeApi({
      'GET /scope': () => ({ status: 200, body: scope() }),
      'GET /tasks': () => ({ status: 200, body: page(items) }),
    }),
  )
  window.history.pushState(null, '', '/tasks')
  render(<RouterProvider router={createAppRouter(undefined, ProjectsShell)} />)
  await screen.findByTestId(`my-task-${first}`)
}

/** A row's action group, named after the task. */
const actionsOf = (id: string, subject: string) =>
  within(screen.getByTestId(`my-task-${id}`)).queryByRole('group', { name: `Actions for ${subject}` })

const labels = (group: HTMLElement) => Array.from(group.children).map((item) => item.textContent)

/** Waits for the wrapper's dynamic import of `shell/extensions` to settle, so an absence is not just "not yet". */
const settled = () => new Promise((resolve) => setTimeout(resolve, 25))

const person = (id: string) => personRef(id, id)

beforeEach(() => {
  vi.mocked(HostExtension).mockImplementation(widget as unknown as typeof HostExtension)
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

describe('Record hours on a My tasks row — what it records on (AC-3.2, AC-3.3, AC-3.4)', () => {
  it('a project task records on its project and on the task, after Mark done', async () => {
    await renderPage([projectTask('p1', { subject: 'Write the offer' })], 'p1')

    const widget = await screen.findByTestId('widget-record-hours')
    const group = actionsOf('p1', 'Write the offer')!
    expect(group.lastElementChild).toBe(widget)
    expect(labels(group)).toEqual(['Mark done', 'Record hours'])
    expect(seam.calls.at(-1)).toEqual({
      name: 'hours.recordHours',
      props: {
        on: 'project',
        targetId: 'p1',
        targetName: 'Intranet',
        activityId: 'p1',
        activityName: 'Write the offer',
        placement: 'row',
      },
    })
  })

  it('a pre-sales task with a deal records on the deal and on the task, as the last item after "Open in CRM"', async () => {
    await renderPage([preSalesTask('s1', { subject: 'Send the quote' })], 's1')

    const widget = await screen.findByTestId('widget-record-hours')
    const group = actionsOf('s1', 'Send the quote')!
    expect(labels(group)).toEqual(['Mark done', 'Open in CRM', 'Record hours'])
    expect(group.lastElementChild).toBe(widget)
    expect(seam.calls.at(-1)?.props).toEqual({
      on: 'deal',
      targetId: 'd1',
      targetName: 'Website',
      activityId: 's1',
      activityName: 'Send the quote',
      placement: 'row',
    })
  })

  it('a pre-sales task with no deal records as other work: no ids, no name, the subject only names the button', async () => {
    await renderPage([preSalesTask('s2', { subject: 'Call Globex back', deal: null })], 's2')

    await screen.findByTestId('widget-record-hours')
    expect(seam.calls.at(-1)?.props).toEqual({
      on: 'none',
      targetId: '',
      targetName: '',
      activityId: '',
      activityName: 'Call Globex back',
      placement: 'row',
    })
    expect(actionsOf('s2', 'Call Globex back')!.lastElementChild).toBe(screen.getByTestId('widget-record-hours'))
  })

  it('offers it on a pre-sales row that has no company link: it is then the only action besides Mark done', async () => {
    await renderPage([preSalesTask('s3', { subject: 'Orphan', company: null })], 's3')
    await screen.findByTestId('widget-record-hours')
    expect(labels(actionsOf('s3', 'Orphan')!)).toEqual(['Mark done', 'Record hours'])
  })
})

describe('Record hours on a My tasks row — who is offered it (AC-3.1, AC-3.6)', () => {
  it('offers it to a participant who is not the assignee', async () => {
    session.id = 'u-pat'
    await renderPage(
      [projectTask('p1', { participants: [person('u-pat')] }, { assignee: person('u-bob') }), projectTask('p2')],
      'p1',
    )
    await waitFor(() => expect(screen.getAllByTestId('widget-record-hours')).toHaveLength(1))
    // Only the row the person takes part in; the other one is assigned to Ada.
    expect(within(screen.getByTestId('my-task-p1')).getByTestId('widget-record-hours')).not.toBeNull()
    expect(within(screen.getByTestId('my-task-p2')).queryByTestId('widget-record-hours')).toBeNull()
  })

  it('offers it to nobody else who can read the task, and mounts nothing for those rows', async () => {
    session.id = 'u-author'
    await renderPage(
      [
        projectTask('p1', { author: person('u-author') }, { assignee: person('u-bob') }),
        preSalesTask('s1', { author: person('u-author') }, { assignee: person('u-bob') }),
      ],
      'p1',
    )
    await settled()
    expect(seam.calls).toEqual([])
    expect(screen.queryByTestId('widget-record-hours')).toBeNull()
    expect(screen.queryByTestId('record-hours-fallback')).toBeNull()
    // The pre-sales row keeps its own link and Mark done.
    expect(labels(actionsOf('s1', 'Pre-sales s1')!)).toEqual(['Mark done', 'Open in CRM'])
  })

  it('offers it to nobody while the session has not given the person’s id', async () => {
    session.id = null
    await renderPage([projectTask('p1')], 'p1')
    await settled()
    expect(seam.calls).toEqual([])
  })

  it('draws no action group for a row with nothing to put in it: not completable, and not the person’s', async () => {
    session.id = 'u-author'
    await renderPage(
      [
        projectTask(
          'p1',
          { author: person('u-author'), may: { edit: false, delete: false, complete: false } },
          { assignee: person('u-bob') },
        ),
      ],
      'p1',
    )
    await settled()
    expect(within(screen.getByTestId('my-task-p1')).queryByRole('group')).toBeNull()
  })

  it('draws the group with only the button for a row the person cannot complete but may record on', async () => {
    await renderPage([projectTask('p1', { may: { edit: false, delete: false, complete: false } })], 'p1')
    const widget = await screen.findByTestId('widget-record-hours')
    expect(labels(actionsOf('p1', 'Task p1')!)).toEqual(['Record hours'])
    expect(actionsOf('p1', 'Task p1')!.lastElementChild).toBe(widget)
  })

  it('offers it on done rows exactly as on open ones: same place, same props (AC-3.6)', async () => {
    const done = { completedAt: '2026-11-05T10:00:00.000Z', completedBy: person('u-ada') }
    await renderPage(
      [
        projectTask('p1', { subject: 'Write the offer' }, done),
        preSalesTask('s1', { subject: 'Send the quote' }, done),
      ],
      'p1',
    )
    await waitFor(() => expect(screen.getAllByTestId('widget-record-hours')).toHaveLength(2))
    expect(labels(actionsOf('p1', 'Write the offer')!)).toEqual(['Mark not done', 'Record hours'])
    expect(labels(actionsOf('s1', 'Send the quote')!)).toEqual(['Mark not done', 'Open in CRM', 'Record hours'])
    const props = seam.calls.map((call) => call.props)
    expect(props).toContainEqual(expect.objectContaining({ on: 'project', targetId: 'p1', activityId: 'p1' }))
    expect(props).toContainEqual(expect.objectContaining({ on: 'deal', targetId: 'd1', activityId: 's1' }))
  })

  it('withholds it from a done row for the author alone, as from an open one', async () => {
    session.id = 'u-author'
    const done = { assignee: person('u-bob'), completedAt: '2026-11-05T10:00:00.000Z', completedBy: person('u-bob') }
    await renderPage([projectTask('p1', { author: person('u-author') }, done)], 'p1')
    await settled()
    expect(seam.calls).toEqual([])
  })
})

describe('Record hours on a My tasks row when the hours screens cannot be loaded (AC-4.5)', () => {
  it('shows the link to My hours as the last action, after "Open in CRM", and the row still works', async () => {
    seam.mode = 'fallsBack'
    await renderPage([preSalesTask('s1', { subject: 'Send the quote' })], 's1')

    const link = await waitFor(() =>
      within(screen.getByTestId('my-task-s1')).getByRole('link', { name: 'Record hours in My hours' }),
    )
    expect(link.getAttribute('href')).toBe('/hours')
    const group = actionsOf('s1', 'Send the quote')!
    expect(group.lastElementChild).toBe(link)
    expect(labels(group)).toEqual(['Mark done', 'Open in CRM', 'Record hours in My hours'])
    expect(within(group).getByRole('link', { name: 'Open in CRM: Send the quote' })).not.toBeNull()
  })
})

describe('Record hours on a long My tasks list (R1)', () => {
  it('mounts one widget for each row the person may record on and none for the rest, each with its own task’s props', async () => {
    // 100 rows. Ada is signed in: 80 are hers — the even ones project tasks, the odd ones pre-sales tasks, of which
    // those with i % 4 === 1 have no deal — and 20 more are somebody else's.
    const mine = (i: number) => (i % 2 === 0 ? projectTask : preSalesTask)
    const items = [
      ...Array.from({ length: 80 }, (_, i) =>
        mine(i)(`m${i}`, { subject: `Mine ${i}`, ...(i % 4 === 1 ? { deal: null } : {}) }),
      ),
      ...Array.from({ length: 20 }, (_, i) =>
        projectTask(`o${i}`, { subject: `Theirs ${i}`, author: person('u-other') }, { assignee: person('u-other') }),
      ),
    ]
    await renderPage(items, 'm0')

    await waitFor(() => expect(screen.getAllByTestId('widget-record-hours')).toHaveLength(80))
    for (let i = 0; i < 80; i += 1) {
      expect(within(screen.getByTestId(`my-task-m${i}`)).getAllByTestId('widget-record-hours')).toHaveLength(1)
    }
    for (let i = 0; i < 20; i += 1) {
      expect(within(screen.getByTestId(`my-task-o${i}`)).queryByTestId('widget-record-hours')).toBeNull()
    }
    // Every row handed the widget the props of its own task: 80 different sets, none crossed.
    const sets = new Map(seam.calls.map((call) => [String(call.props.activityName), call.props]))
    expect(sets.size).toBe(80)
    expect(sets.get('Mine 0')).toMatchObject({ on: 'project', targetId: 'p1', activityId: 'm0' })
    expect(sets.get('Mine 6')).toMatchObject({ on: 'project', targetId: 'p1', activityId: 'm6' })
    expect(sets.get('Mine 1')).toMatchObject({ on: 'none', targetId: '', activityId: '' })
    expect(sets.get('Mine 5')).toMatchObject({ on: 'none', targetId: '', activityId: '' })
    expect(sets.get('Mine 3')).toMatchObject({ on: 'deal', targetId: 'd1', activityId: 'm3' })
    expect(sets.get('Mine 7')).toMatchObject({ on: 'deal', targetId: 'd1', activityId: 'm7' })
  })
})
