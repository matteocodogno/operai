/**
 * @vitest-environment jsdom
 *
 * ActivityItem and Record hours (specs/20261116-record-hours-in-place AC-3.1, AC-3.3, AC-3.4, AC-3.6, AC-4.5; design S2):
 * a task's row offers hours-ui's Record hours widget to the task's assignee and to its participants, last in the row's
 * actions after the author's Edit and Delete, on a done task as on an open one, and never on anything that is not a
 * task or to anyone else. Whether the person may actually record is hours-api's answer at save time; this row only
 * decides whether to show the button.
 *
 * `shell/extensions` is mocked by name, as the shell does: the widget is a button that says what it was given. A row
 * the person may record on is rendered beside every "absent" row as the positive control, so an absence is only
 * believed once the seam has loaded and the control's widget is on screen.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import ActivityItem from './ActivityItem'
import type { Activity, ActivityTask, PersonRef } from '../lib/types'
import { RouterWrapper } from '../test-support/RouterWrapper'

const { session, extensionCalls } = vi.hoisted(() => ({
  session: { id: 'u-me' as string | null },
  extensionCalls: [] as { name: string; props: Record<string, string> }[],
}))
vi.mock('shell/session', () => ({
  useSession: () => ({ data: session.id === null ? null : { user: { id: session.id } } }),
  apiFetch: vi.fn(),
  getCrmApiBaseUrl: () => 'http://crm-api.test',
  getActivitiesApiBaseUrl: () => 'http://activities-api.test',
  getAuthBaseUrl: () => 'http://auth.test',
}))
vi.mock('shell/extensions', () => ({
  HostExtension: ({ name, props }: { name: string; props: Record<string, string>; fallback: ReactNode }) => {
    extensionCalls.push({ name, props })
    return name === 'hours.recordHours' ? (
      <button type="button" data-testid="hours-widget">
        {props.activityName ? `Record hours on ${props.activityName}` : 'Record hours'}
      </button>
    ) : null
  },
}))

const person = (id: string, name = `Person ${id}`): PersonRef => ({ id, name, status: 'active' })

const task = (overrides: Partial<ActivityTask> = {}): ActivityTask => ({
  dueDate: '2026-11-20',
  assignee: person('u-me', 'Me Myself'),
  completedAt: null,
  completedBy: null,
  ...overrides,
})

const taskActivity = (overrides: Partial<Activity> = {}): Activity => ({
  id: 't1',
  type: 'task',
  subject: 'Send the offer',
  body: null,
  occurredAt: '2026-11-03T09:30:00.000Z',
  company: { id: 'c1', name: 'Acme SA' },
  contact: null,
  deal: { id: 'd1', title: 'Platform rebuild' },
  author: person('u-author', 'Ada Author'),
  participants: [],
  task: task(),
  createdAt: '2026-11-03T08:00:00.000Z',
  updatedAt: '2026-11-03T08:00:00.000Z',
  ...overrides,
})

const noop = () => undefined
const row = (activity: Activity) => (
  <ActivityItem key={activity.id} activity={activity} onChanged={noop} onEdit={noop} onDeleted={noop} />
)
const show = (...activities: Activity[]) => render(<>{activities.map(row)}</>, { wrapper: RouterWrapper })

/** The control: a task the signed-in person is assigned to. Its widget proves the seam has loaded. */
const CONTROL = taskActivity({ id: 'control', subject: 'The control task' })
const rowOf = (id: string) => screen.getByTestId(`crm-activity-${id}`)
const widgetsIn = (element: HTMLElement) => within(element).queryAllByTestId('hours-widget')

beforeEach(() => {
  session.id = 'u-me'
  extensionCalls.length = 0
})

afterEach(cleanup)

describe('ActivityItem — Record hours on a task row (AC-3.1)', () => {
  it('offers the widget to the task’s assignee, with the props of the task’s deal and the task (AC-3.3)', async () => {
    show(
      taskActivity({
        id: 't9',
        subject: 'Write the offer',
        deal: { id: 'd7', title: 'Alpenstrom portal' },
        author: person('u-me'),
      }),
    )
    await screen.findByTestId('hours-widget')

    expect(extensionCalls).toEqual([
      {
        name: 'hours.recordHours',
        props: {
          on: 'deal',
          targetId: 'd7',
          targetName: 'Alpenstrom portal',
          activityId: 't9',
          activityName: 'Write the offer',
          placement: 'row',
        },
      },
    ])
  })

  it('offers it to a participant of the task', async () => {
    session.id = 'u-part'
    show(
      taskActivity({
        id: 'p1',
        task: task({ assignee: person('u-else') }),
        participants: [person('u-part'), person('u-x')],
      }),
    )
    expect(await within(rowOf('p1')).findAllByTestId('hours-widget')).toHaveLength(1)
  })

  it('puts it last in the row’s actions, after the author’s Edit and Delete', async () => {
    session.id = 'u-both'
    show(taskActivity({ id: 'm1', author: person('u-both'), task: task({ assignee: person('u-both') }) }))
    await screen.findByTestId('hours-widget')

    const group = screen.getByRole('group', { name: 'Actions for Send the offer' })
    expect(
      within(group)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['Mark done', 'Edit', 'Delete', 'Record hours on Send the offer'])
  })

  it('shows it alone after Mark done when the person is not the author (no Edit or Delete)', async () => {
    show(taskActivity({ id: 'a1' }))
    await screen.findByTestId('hours-widget')

    const group = screen.getByRole('group', { name: 'Actions for Send the offer' })
    expect(
      within(group)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['Mark done', 'Record hours on Send the offer'])
  })

  it('does not offer it to the author alone, nor to anyone who merely reads the task', async () => {
    show(
      CONTROL,
      taskActivity({ id: 'author-only', author: person('u-me'), task: task({ assignee: person('u-else') }) }),
      taskActivity({
        id: 'reader',
        author: person('u-author'),
        task: task({ assignee: person('u-else') }),
        participants: [person('u-x')],
      }),
      taskActivity({ id: 'unassigned', task: task({ assignee: null }) }),
    )
    await within(rowOf('control')).findByTestId('hours-widget')

    expect(widgetsIn(rowOf('author-only'))).toHaveLength(0)
    expect(widgetsIn(rowOf('reader'))).toHaveLength(0)
    expect(widgetsIn(rowOf('unassigned'))).toHaveLength(0)
    // and the author-only row still has its own actions
    expect(within(rowOf('author-only')).getByRole('button', { name: 'Edit' })).not.toBeNull()
    expect(extensionCalls).toHaveLength(1)
  })

  it('does not offer it on an activity that is not a task, even to someone who took part in it (AC-3.1)', async () => {
    show(
      CONTROL,
      taskActivity({ id: 'call', type: 'call', task: null, participants: [person('u-me')], author: person('u-me') }),
      taskActivity({ id: 'note', type: 'note', task: null, body: 'Spoke to the CFO', participants: [person('u-me')] }),
    )
    await within(rowOf('control')).findByTestId('hours-widget')

    expect(widgetsIn(rowOf('call'))).toHaveLength(0)
    expect(widgetsIn(rowOf('note'))).toHaveLength(0)
    expect(extensionCalls).toHaveLength(1)
  })

  it('offers nothing while the session has not given the person’s id yet', async () => {
    session.id = null
    const view = show(taskActivity({ id: 'a1' }))
    // nothing to wait for: the row is the control. Let the seam's import settle first, so an absence means "not offered".
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(widgetsIn(view.container)).toHaveLength(0)
    expect(extensionCalls).toHaveLength(0)
  })
})

describe('ActivityItem — Record hours on a done task (AC-3.6)', () => {
  const done = (overrides: Partial<Activity> = {}) =>
    taskActivity({
      ...overrides,
      task: task({ completedAt: '2026-11-10T10:00:00.000Z', completedBy: person('u-me'), ...(overrides.task ?? {}) }),
    })

  it('offers it exactly as on an open task: same place, same props', async () => {
    show(done({ id: 'done1' }), taskActivity({ id: 'open1' }))
    await within(rowOf('done1')).findByTestId('hours-widget')
    await within(rowOf('open1')).findByTestId('hours-widget')

    const group = within(rowOf('done1')).getByRole('group', { name: 'Actions for Send the offer' })
    expect(
      within(group)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['Reopen', 'Record hours on Send the offer'])
    const propsOf = (activityId: string) => extensionCalls.find((call) => call.props.activityId === activityId)!.props
    expect(propsOf('done1')).toEqual({ ...propsOf('open1'), activityId: 'done1' })
  })

  it('still does not offer it to the author alone or to someone else', async () => {
    show(
      CONTROL,
      done({
        id: 'done-author',
        author: person('u-me'),
        task: task({ assignee: person('u-else'), completedAt: '2026-11-10T10:00:00.000Z' }),
      }),
    )
    await within(rowOf('control')).findByTestId('hours-widget')
    expect(widgetsIn(rowOf('done-author'))).toHaveLength(0)
  })
})

describe('ActivityItem — a task about a company and no deal (AC-3.4, AC-3.5, G3)', () => {
  it('hands the widget other work, no ids, and the subject only to name the button', async () => {
    show(taskActivity({ id: 'nodeal', subject: 'Call the CFO', deal: null, contact: { id: 'k1', name: 'Bea Meier' } }))
    await screen.findByTestId('hours-widget')

    expect(extensionCalls).toEqual([
      {
        name: 'hours.recordHours',
        props: {
          on: 'none',
          targetId: '',
          targetName: '',
          activityId: '',
          activityName: 'Call the CFO',
          placement: 'row',
        },
      },
    ])
    expect(screen.getByRole('button', { name: 'Record hours on Call the CFO' })).not.toBeNull()
  })
})
