/**
 * @vitest-environment jsdom
 *
 * ProjectTaskItem × Record hours (specs/20261116-record-hours-in-place AC-3.1, AC-3.2, AC-3.6, AC-4.5, design S2): a
 * task's row on the project's Tasks card offers hours-ui's widget, through the shell's `hours.recordHours`
 * extension, to the task's assignee and to its participants and to nobody else — as the LAST item of the row's
 * actions, done rows included — with the six plain strings of the task and its project. When the widget cannot be
 * had the row works as before and shows the link to My hours in its place. `shell/extensions` is a spy that records
 * what the row hands the widget (the real one is the shell's).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { projectTask } from '../test-support/fakeApi'
import type { ProjectTask } from '../lib/activitiesApi'
import ProjectTaskItem from './ProjectTaskItem'

type Mode = 'ready' | 'fallsBack' | 'noExport'
type Call = { name: string; props: Record<string, unknown>; hasLoading: boolean }
const seam = vi.hoisted(() => ({ mode: 'ready' as Mode, calls: [] as Call[] }))

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

const noop = () => undefined

/** A project task as the card lists it: assigned to `u-ada`, written by `u-ada`, in project `p1` "Intranet". */
const task = (over: Record<string, unknown> = {}, details: Record<string, unknown> = {}) =>
  projectTask('t1', { subject: 'Write the offer', ...over }, details) as unknown as ProjectTask

const person = (id: string) => ({ id, name: id, status: 'active' })

const renderRow = (row: ProjectTask, me: string | null = 'u-ada') =>
  render(
    <ProjectTaskItem task={row} currentUserId={me} error={undefined} onChanged={noop} onFailed={noop} onEdit={noop} />,
  )

/** The row's action group, which names itself after the task. */
const actions = () => screen.getByRole('group', { name: 'Actions for Write the offer' })

/** Waits for the wrapper's dynamic import of `shell/extensions` to settle, so an absence is not just "not yet". */
const settled = () => new Promise((resolve) => setTimeout(resolve, 25))

beforeEach(() => {
  seam.mode = 'ready'
  seam.calls = []
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('Record hours on a project task row — who is offered it (AC-3.1)', () => {
  it('offers it to the assignee as the LAST item of the row’s actions, after Mark done, Edit and Delete (design S2)', async () => {
    renderRow(task())

    const widget = await screen.findByTestId('widget-record-hours')
    const group = actions()
    expect(group.lastElementChild).toBe(widget)
    const labels = Array.from(group.children).map((item) => item.textContent)
    expect(labels).toEqual(['Mark done', 'Edit', 'Delete', 'Record hours'])
  })

  it('hands the widget the extension’s name and the six plain strings of the task and its project (AC-3.2, R10)', async () => {
    renderRow(task({ id: 't-7', project: { id: 'p-9', name: 'Alpenstrom — portale clienti' } }))

    await screen.findByTestId('widget-record-hours')
    expect(seam.calls.length).toBeGreaterThan(0)
    for (const call of seam.calls) {
      expect(call.name).toBe('hours.recordHours')
      expect(call.props).toEqual({
        on: 'project',
        targetId: 'p-9',
        targetName: 'Alpenstrom — portale clienti',
        activityId: 't-7',
        activityName: 'Write the offer',
        placement: 'row',
      })
      // Nothing is shown while the widget loads: the row asks for no placeholder.
      expect(call.hasLoading).toBe(false)
    }
  })

  it('offers it to a participant who is not the assignee', async () => {
    renderRow(task({ participants: [person('u-pat')] }, { assignee: person('u-bob') }), 'u-pat')
    await screen.findByTestId('widget-record-hours')
    expect(actions().lastElementChild).toBe(screen.getByTestId('widget-record-hours'))
  })

  it('offers it to nobody else who can read the task: the author alone, or anyone else', async () => {
    // Written by u-author, assigned to u-bob, u-pat takes part.
    const row = task({ author: person('u-author'), participants: [person('u-pat')] }, { assignee: person('u-bob') })

    renderRow(row, 'u-author')
    await settled()
    expect(seam.calls).toEqual([])
    expect(screen.queryByTestId('widget-record-hours')).toBeNull()
    expect(screen.queryByTestId('record-hours-fallback')).toBeNull()
    // The row's own buttons are all still there.
    expect(Array.from(actions().children).map((item) => item.textContent)).toEqual(['Mark done', 'Edit', 'Delete'])
    cleanup()

    renderRow(row, 'u-someone-else')
    await settled()
    expect(seam.calls).toEqual([])
    expect(screen.queryByTestId('widget-record-hours')).toBeNull()
  })

  it('offers it to nobody while the session has not given the person’s id', async () => {
    renderRow(task(), null)
    await settled()
    expect(seam.calls).toEqual([])
    expect(screen.queryByTestId('widget-record-hours')).toBeNull()
  })

  it('does not depend on the row’s `may` flags: a person who may not edit, delete or complete still records', async () => {
    renderRow(task({ may: { edit: false, delete: false, complete: false } }))

    const widget = await screen.findByTestId('widget-record-hours')
    expect(Array.from(actions().children)).toEqual([widget])
  })

  it('offers no button for a task whose project the answer left out: the widget would have nothing to record on', async () => {
    renderRow(task({ project: null }))
    await settled()
    expect(seam.calls).toEqual([])
    expect(screen.queryByTestId('widget-record-hours')).toBeNull()
    expect(screen.queryByTestId('record-hours-fallback')).toBeNull()
  })
})

describe('Record hours on a done project task row (AC-3.6)', () => {
  const done = { completedAt: '2026-11-05T10:00:00.000Z', completedBy: person('u-ada') }

  it('offers it exactly as an open row does: same props, same place — last, after Mark not done', async () => {
    renderRow(task({}, done))

    const widget = await screen.findByTestId('widget-record-hours')
    expect(Array.from(actions().children).map((item) => item.textContent)).toEqual([
      'Mark not done',
      'Edit',
      'Delete',
      'Record hours',
    ])
    expect(actions().lastElementChild).toBe(widget)
    expect(seam.calls.at(-1)?.props).toEqual({
      on: 'project',
      targetId: 'p1',
      targetName: 'Intranet',
      activityId: 't1',
      activityName: 'Write the offer',
      placement: 'row',
    })
  })

  it('is withheld from a done row for the author alone, as from an open one', async () => {
    renderRow(task({ author: person('u-author') }, { ...done, assignee: person('u-bob') }), 'u-author')
    await settled()
    expect(seam.calls).toEqual([])
    expect(screen.queryByTestId('widget-record-hours')).toBeNull()
  })
})

describe('Record hours on a project task row when the hours screens cannot be loaded (AC-4.5)', () => {
  it('works as before and shows the link to My hours, centred, as the last action', async () => {
    seam.mode = 'fallsBack'
    renderRow(task())

    const link = await waitFor(() => screen.getByRole('link', { name: 'Record hours in My hours' }))
    expect(link.getAttribute('href')).toBe('/hours')
    expect(link.className).toContain('self-center')
    expect(actions().lastElementChild).toBe(link)
    // The row's own actions still work and are in their places.
    expect(within(actions()).getByRole('button', { name: 'Mark done' })).not.toBeNull()
    expect(within(actions()).getByRole('button', { name: 'Edit' })).not.toBeNull()
  })

  it('shows the same link when the shell predates the expose (no HostExtension)', async () => {
    seam.mode = 'noExport'
    renderRow(task())
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Record hours in My hours' })).not.toBeNull())
  })

  it('shows no link to someone who would not have been offered the button', async () => {
    seam.mode = 'fallsBack'
    renderRow(task({ author: person('u-author') }, { assignee: person('u-bob') }), 'u-author')
    await settled()
    expect(screen.queryByRole('link', { name: 'Record hours in My hours' })).toBeNull()
  })
})
