/**
 * @vitest-environment jsdom
 *
 * TaskFormDialog (specs/20261110-activities AC-3.1, AC-3.2, AC-3.7, AC-4.1, AC-5.1): a title is
 * required; the assignee is optional and limited to the project manager and the
 * team, except that a departed assignee stays selectable and saves unchanged;
 * blockers come from the project's other open tasks (at most 10); participants
 * are module users (at most 10); the body that reaches POST / PATCH; and each
 * refusal landing on the field it names while every typed value stays.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { fakeApi, personRef, problem, projectDetail, projectTask } from '../test-support/fakeApi'
import type { FakeHandler } from '../test-support/fakeApi'

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock('shell/session', () => ({
  usePermissions: () => ({ epoch: 0, apps: [], roles: [], departments: [], permissions: [] }),
  apiFetch,
  getProjectsApiBaseUrl: () => 'http://projects-api.test',
  getAuthBaseUrl: () => 'http://auth.test',
  getActivitiesApiBaseUrl: () => 'http://activities-api.test',
  useSession: () => ({ data: { user: { id: 'u-ada', name: 'Ada Lovelace' } } }),
}))

import TaskFormDialog from './TaskFormDialog'
import type { ProjectTask } from '../lib/activitiesApi'
import type { Project } from '../lib/types'

const BOB = { id: 'u-bob', name: 'Bob Builder', deleted: false }
const CARA = { id: 'u-cara', name: 'Cara Coder', deleted: false }
const directoryUser = (id: string, name: string) => ({
  id,
  name,
  email: `${name.split(' ')[0]!.toLowerCase()}@welld.ch`,
  entity: 'welld_ch',
})
const DIRECTORY = [
  directoryUser('u-ada', 'Ada Lovelace'),
  directoryUser('u-bob', 'Bob Builder'),
  directoryUser('u-dan', 'Dan Dev'),
]

const onSaved = vi.fn()
const onCancel = vi.fn()
const onHostReadOnly = vi.fn()

const page = (items: unknown[]) => ({ items, total: items.length, page: 1, pageSize: 100 })

const renderDialog = (
  routes: Record<string, FakeHandler> = {},
  {
    task,
    team = [BOB],
    currentUserId = 'u-ada',
    awaitingManager = false,
    project: projectOver = {},
  }: {
    task?: ProjectTask
    team?: (typeof BOB)[]
    currentUserId?: string
    awaitingManager?: boolean
    project?: Partial<Project>
  } = {},
) => {
  apiFetch.mockImplementation(
    fakeApi({
      'GET /tasks': () => ({ status: 200, body: page([]) }),
      'GET /authz/users/directory': () => ({ status: 200, body: { users: DIRECTORY } }),
      'POST /activities': () => ({ status: 201, body: projectTask('new') }),
      ...routes,
    }),
  )
  const project = projectDetail({ team, ...(awaitingManager ? { projectManager: null } : {}), ...projectOver })
  render(
    <TaskFormDialog
      project={project}
      task={task}
      currentUserId={currentUserId}
      onSaved={onSaved}
      onCancel={onCancel}
      onHostReadOnly={onHostReadOnly}
    />,
  )
  return screen.getByRole('dialog')
}

const writes = () =>
  apiFetch.mock.calls
    .filter(([, init]) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes((init as RequestInit | undefined)?.method ?? ''))
    .map(([input, init]) => ({
      method: (init as RequestInit).method!,
      path: new URL(String(input)).pathname,
      body: JSON.parse(String((init as RequestInit).body ?? 'null')) as Record<string, unknown>,
    }))

const type = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label, { exact: false }), { target: { value } })
const submit = (name = 'Add task') => fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name }))

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

describe('adding a task (AC-3.1)', () => {
  it('needs a title, tells you so on the field, and sends nothing', async () => {
    renderDialog()
    submit()
    expect(await screen.findByText('This field is required.')).toBeTruthy()
    expect(writes()).toHaveLength(0)
  })

  it('refuses a title over 200 characters before the server does', async () => {
    renderDialog()
    type('Title', 'x'.repeat(201))
    submit()
    expect(await screen.findByText('Use at most 200 characters.')).toBeTruthy()
    expect(writes()).toHaveLength(0)
  })

  it('creates a task about this project: title, no due date, the signed-in team member as assignee, nothing else', async () => {
    renderDialog()
    type('Title', '  Send the offer  ')

    submit()

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith('Task added.'))
    expect(writes()).toEqual([
      {
        method: 'POST',
        path: '/activities',
        body: {
          type: 'task',
          projectId: 'p1',
          subject: 'Send the offer',
          description: null,
          dueDate: null,
          assigneeUserId: 'u-ada',
          blockedByIds: [],
          participantIds: [],
        },
      },
    ])
  })

  it('offers the project manager and the team, with the empty "Me (the author)" first, and nobody else', () => {
    renderDialog({}, { team: [BOB, CARA] })
    const select = screen.getByLabelText('Assignee') as HTMLSelectElement
    expect([...select.options].map((option) => option.textContent)).toEqual([
      'Me (the author)',
      'Ada Lovelace (You)',
      'Bob Builder',
      'Cara Coder',
    ])
  })

  it('offers only the team while a project from a deal awaits its project manager (specs/20261103-projects-handoff D42)', () => {
    renderDialog({}, { team: [BOB, CARA], awaitingManager: true })
    const select = screen.getByLabelText('Assignee') as HTMLSelectElement
    expect([...select.options].map((option) => option.textContent)).toEqual([
      'Me (the author)',
      'Bob Builder',
      'Cara Coder',
    ])
  })

  it('defaults the assignee to the empty option when the signed-in user is neither manager nor member, and omits it', async () => {
    renderDialog({}, { currentUserId: 'u-outsider' })
    const select = screen.getByLabelText('Assignee') as HTMLSelectElement
    expect(select.value).toBe('')
    expect(screen.getByText('Left empty, the task is assigned to you.')).toBeTruthy()
    type('Title', 'Plan')

    submit()

    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(writes()[0]!.body).not.toHaveProperty('assigneeUserId')
  })

  it('sends a due date and an explicit assignee', async () => {
    renderDialog()
    type('Title', 'Plan')
    type('Due date', '2026-12-01')
    type('Assignee', 'u-bob')

    submit()

    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(writes()[0]!.body).toMatchObject({ dueDate: '2026-12-01', assigneeUserId: 'u-bob' })
  })

  it('offers no task type (AC-3.6), and a rich description with its attachments (ADR 20261113-task-description-files-in-activities-api-bucket)', () => {
    renderDialog()
    expect(screen.queryByLabelText('Type')).toBeNull()
    expect(screen.getByRole('textbox', { name: 'Description' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Insert image' })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Attach files/ })).toBeTruthy()
  })

  it('a chosen attachment waits for the save, then is uploaded to the new task: start, bucket, confirm', async () => {
    const bucket = vi.fn(async () => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', bucket)
    renderDialog({
      'POST /activities': () => ({ status: 201, body: projectTask('t-new', { subject: 'Plan' }) }),
      'POST /activities/t-new/files': () => ({
        status: 201,
        body: {
          fileId: 'f-1',
          upload: { url: 'https://bucket.test/activities', fields: { key: 'activities/t-new/f-1' } },
        },
      }),
      'POST /activities/t-new/files/f-1/confirm': () => ({
        status: 200,
        body: {
          id: 'f-1',
          kind: 'attachment',
          fileName: 'spec.pdf',
          contentType: 'application/pdf',
          sizeBytes: 3,
          uploadedBy: personRef('u-ada', 'Ada Lovelace'),
          createdAt: '2026-11-13T10:00:00Z',
        },
      }),
    })
    type('Title', 'Plan')
    fireEvent.change(screen.getByTestId('task-form-description-files-input'), {
      target: { files: [new File(['pdf'], 'spec.pdf', { type: 'application/pdf' })] },
    })
    expect(screen.getByTestId('task-form-description-files-list').textContent).toContain('spec.pdf')
    expect(writes()).toEqual([])

    submit()

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith('Task added.'))
    expect(writes().map((write) => `${write.method} ${write.path}`)).toEqual([
      'POST /activities',
      'POST /activities/t-new/files',
      'POST /activities/t-new/files/f-1/confirm',
    ])
    expect(writes()[1]!.body).toEqual({
      kind: 'attachment',
      fileName: 'spec.pdf',
      contentType: 'application/pdf',
      sizeBytes: 3,
    })
    expect(bucket).toHaveBeenCalledWith('https://bucket.test/activities', expect.objectContaining({ method: 'POST' }))
    vi.unstubAllGlobals()
  })

  it('a file outside the policy is refused at once and never sent', () => {
    renderDialog()
    fireEvent.change(screen.getByTestId('task-form-description-files-input'), {
      target: { files: [new File(['x'], 'tool.exe', { type: 'application/x-msdownload' })] },
    })
    expect(screen.getByRole('alert').textContent).toContain('tool.exe')
    expect(screen.queryByTestId('task-form-description-files-list')?.textContent ?? '').not.toContain('tool.exe')
  })
})

describe('editing a task (AC-3.2, AC-3.7)', () => {
  const existing = (assignee = personRef('u-bob', 'Bob Builder'), over: Record<string, unknown> = {}) =>
    projectTask('t1', { subject: 'Send offer', ...over }, { assignee, dueDate: '2026-11-20' }) as unknown as ProjectTask

  it('starts from the task’s own values and PATCHes only that task, with no default for the assignee', async () => {
    renderDialog({ 'PATCH /activities/t1': () => ({ status: 200, body: existing() }) }, { task: existing() })
    expect((screen.getByLabelText('Title', { exact: false }) as HTMLInputElement).value).toBe('Send offer')
    expect((screen.getByLabelText('Assignee') as HTMLSelectElement).value).toBe('u-bob')
    type('Title', 'Send the final offer')

    submit('Save')

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith('Task saved.'))
    expect(writes()).toEqual([
      {
        method: 'PATCH',
        path: '/activities/t1',
        body: {
          subject: 'Send the final offer',
          description: null,
          dueDate: '2026-11-20',
          assigneeUserId: 'u-bob',
          blockedByIds: [],
          participantIds: [],
        },
      },
    ])
  })

  it('shows an assignee who left the team as "(no longer on the project)" and saves without changing them', async () => {
    const departed = existing(personRef('u-zed', 'Zed Gone'))
    renderDialog({ 'PATCH /activities/t1': () => ({ status: 200, body: departed }) }, { task: departed })
    const select = screen.getByLabelText('Assignee') as HTMLSelectElement
    expect(select.value).toBe('u-zed')
    expect(select.selectedOptions[0]!.textContent).toBe('Zed Gone (no longer on the project)')

    type('Title', 'Send offer today')
    submit('Save')

    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    // Resent unchanged: the server does not revalidate an assignee that did not change.
    expect(writes()[0]!.body).toMatchObject({ assigneeUserId: 'u-zed' })
  })

  it('once someone else is picked, the departed person is no longer an option', () => {
    const departed = existing(personRef('u-zed', 'Zed Gone'))
    renderDialog({}, { task: departed })

    type('Assignee', 'u-bob')

    const select = screen.getByLabelText('Assignee') as HTMLSelectElement
    expect([...select.options].map((option) => option.value)).not.toContain('u-zed')
  })

  it('does not offer the empty option for a task that has an assignee', () => {
    renderDialog({}, { task: existing() })
    const select = screen.getByLabelText('Assignee') as HTMLSelectElement
    expect([...select.options].map((option) => option.value)).not.toContain('')
  })
})

describe('blockers (AC-4.1)', () => {
  const open = (id: string, subject: string) => projectTask(id, { subject })

  it('lists the project’s other open tasks, never the task itself, with a count in the legend', async () => {
    const task = projectTask('t1', { subject: 'Me' }) as unknown as ProjectTask
    renderDialog(
      {
        'GET /tasks': () => ({ status: 200, body: page([open('t1', 'Me'), open('a', 'Draft'), open('b', 'Review')]) }),
      },
      { task },
    )

    const group = await screen.findByRole('group', { name: /Blocked by/ })
    expect(
      within(group)
        .getAllByRole('checkbox')
        .map((box) => box.parentElement!.textContent),
    ).toEqual(['Draft', 'Review'])
    expect(group.querySelector('legend')!.textContent).toBe('Blocked by (0 of 10 selected)')
    const [url] = apiFetch.mock.calls.find(([input]) => String(input).includes('/tasks'))!
    expect(Object.fromEntries(new URL(String(url)).searchParams)).toMatchObject({
      projectId: 'p1',
      status: 'open',
      pageSize: '100',
    })
  })

  it('keeps a current blocker that is already done, labelled "(done)", and pre-ticks it', async () => {
    const task = projectTask(
      't1',
      {},
      { blockedBy: [{ id: 'z', subject: 'Old one', completed: true }] },
    ) as unknown as ProjectTask
    renderDialog({ 'GET /tasks': () => ({ status: 200, body: page([open('a', 'Draft')]) }) }, { task })

    const box = await screen.findByLabelText('Old one (done)')
    expect((box as HTMLInputElement).checked).toBe(true)
  })

  it('sends the ticked blockers as the whole set', async () => {
    renderDialog({ 'GET /tasks': () => ({ status: 200, body: page([open('a', 'Draft'), open('b', 'Review')]) }) })
    type('Title', 'Ship')
    fireEvent.click(await screen.findByLabelText('Review'))
    expect(screen.getByRole('group', { name: /Blocked by/ }).querySelector('legend')!.textContent).toBe(
      'Blocked by (1 of 10 selected)',
    )

    submit()

    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(writes()[0]!.body).toMatchObject({ blockedByIds: ['b'] })
  })

  it('refuses an eleventh blocker with a visible reason', async () => {
    const many = Array.from({ length: 11 }, (_, index) => open(`b${index}`, `Blocker ${index}`))
    renderDialog({ 'GET /tasks': () => ({ status: 200, body: page(many) }) })
    for (let index = 0; index < 10; index += 1) fireEvent.click(await screen.findByLabelText(`Blocker ${index}`))

    fireEvent.click(screen.getByLabelText('Blocker 10'))

    expect(screen.getByText('A task can wait on at most 10 others.')).toBeTruthy()
    expect((screen.getByLabelText('Blocker 10') as HTMLInputElement).checked).toBe(false)
  })

  it('with no other open task, says so', async () => {
    renderDialog()
    expect(await screen.findByText('No other open tasks on this project.')).toBeTruthy()
  })

  it('when the other tasks cannot be loaded, says so with a Retry, and an edit still sends the blockers unchanged', async () => {
    const task = projectTask(
      't1',
      {},
      { blockedBy: [{ id: 'a', subject: 'Draft', completed: false }] },
    ) as unknown as ProjectTask
    renderDialog(
      {
        'GET /tasks': () => problem(503, 'maintenance'),
        'PATCH /activities/t1': () => ({ status: 200, body: task }),
      },
      { task },
    )
    expect(await screen.findByText(/other tasks could not be loaded/)).toBeTruthy()

    submit('Save')

    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(writes()[0]!.body).toMatchObject({ blockedByIds: ['a'] })
  })

  it('Retry loads the other tasks again', async () => {
    let healthy = false
    renderDialog({
      'GET /tasks': () =>
        healthy ? { status: 200, body: page([open('a', 'Draft')]) } : problem(503, 'host_unavailable'),
    })
    const failed = await screen.findByTestId('task-form-blocked-by-failed')

    healthy = true
    fireEvent.click(within(failed).getByRole('button', { name: 'Retry' }))

    expect(await screen.findByLabelText('Draft')).toBeTruthy()
  })
})

describe('the assignee list follows project.onProject (AC-4.8 of the teams spec: AC-5.2, AC-5.4, design S9, G10)', () => {
  const ADA_P = { id: 'u-ada', name: 'Ada Lovelace', deleted: false }
  const DAN_GONE = { id: 'u-dan', name: 'Dan Dev', deleted: true }
  const optionLabels = () =>
    [...(screen.getByLabelText('Assignee', { exact: false }) as HTMLSelectElement).options].map((o) => o.textContent)

  it('offers the people of onProject, a person on the project only through a team included, and not a deleted one', () => {
    // BOB is listed in `team`, but the server's answer is the authority: onProject does not hold him here.
    renderDialog({}, { team: [BOB], project: { onProject: [ADA_P, CARA, DAN_GONE], onProjectComplete: true } })
    expect(optionLabels()).toEqual(['Me (the author)', 'Ada Lovelace (You)', 'Cara Coder'])
  })

  it('says nothing about missing people while the list is complete', () => {
    renderDialog({}, { project: { onProject: [ADA_P, CARA], onProjectComplete: true } })
    expect(screen.queryByText(/could not be loaded/)).toBeNull()
  })

  it('says the list may be missing people when the teams could not be loaded (onProjectComplete false)', () => {
    renderDialog({}, { project: { onProject: [ADA_P], onProjectComplete: false } })
    expect(screen.getByText(/Some team members could not be loaded, so this list may be missing people\./)).toBeTruthy()
    // The note joins the existing hint, it does not replace it.
    expect(screen.getByText(/Left empty, the task is assigned to you\./)).toBeTruthy()
  })

  it('also says it when editing, where the usual hint is not shown', () => {
    const task = projectTask('t1', {}, { assignee: personRef('u-ada', 'Ada Lovelace') }) as unknown as ProjectTask
    renderDialog({}, { task, project: { onProject: [ADA_P], onProjectComplete: false } })
    expect(screen.getByText('Some team members could not be loaded, so this list may be missing people.')).toBeTruthy()
    expect(screen.queryByText(/Left empty/)).toBeNull()
  })

  it('G10: a task already given to a team-only person keeps them selected, unmarked, and resends them unchanged while the teams are not loaded', async () => {
    const task = projectTask(
      't1',
      { subject: 'Send offer' },
      { assignee: personRef('u-cara', 'Cara Coder') },
    ) as unknown as ProjectTask
    renderDialog(
      { 'PATCH /activities/t1': () => ({ status: 200, body: task }) },
      { task, project: { onProject: [ADA_P], onProjectComplete: false } },
    )
    const select = screen.getByLabelText('Assignee', { exact: false }) as HTMLSelectElement
    expect(select.value).toBe('u-cara')
    // Not "no longer on the project": that is not known while the teams are not loaded.
    expect(select.selectedOptions[0]!.textContent).toBe('Cara Coder')

    type('Title', 'Send offer today')
    submit('Save')

    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(writes()[0]!.body).toMatchObject({ assigneeUserId: 'u-cara' })
  })

  it('keeps the "no longer on the project" mark when the list is complete and the person is not in it', () => {
    const task = projectTask('t1', {}, { assignee: personRef('u-cara', 'Cara Coder') }) as unknown as ProjectTask
    renderDialog({}, { task, project: { onProject: [ADA_P], onProjectComplete: true } })
    const select = screen.getByLabelText('Assignee', { exact: false }) as HTMLSelectElement
    expect(select.selectedOptions[0]!.textContent).toBe('Cara Coder (no longer on the project)')
  })

  it('R6: against a projects-api without onProject it falls back to the project manager and the listed team', () => {
    renderDialog({}, { team: [BOB, CARA] })
    expect(optionLabels()).toEqual(['Me (the author)', 'Ada Lovelace (You)', 'Bob Builder', 'Cara Coder'])
    expect(screen.queryByText(/could not be loaded/)).toBeNull()
  })
})

describe('participants (AC-5.1)', () => {
  it('adds people picked from the directory as removable chips and sends their ids', async () => {
    renderDialog()
    type('Title', 'Ship')
    const picker = screen.getByTestId('task-form-participants-picker-input')
    fireEvent.focus(picker)
    fireEvent.change(picker, { target: { value: 'dan' } })
    fireEvent.click(await screen.findByRole('option', { name: /Dan Dev/ }))

    const chips = screen.getByRole('list', { name: 'Participants' })
    expect(within(chips).getByText('Dan Dev')).toBeTruthy()

    submit()
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(writes()[0]!.body).toMatchObject({ participantIds: ['u-dan'] })
  })

  it('removes a chip with a button named after the person', () => {
    const task = projectTask('t1', { participants: [personRef('u-dan', 'Dan Dev')] }) as unknown as ProjectTask
    renderDialog({}, { task })

    fireEvent.click(screen.getByRole('button', { name: 'Remove Dan Dev' }))

    expect(screen.queryByRole('list', { name: 'Participants' })).toBeNull()
  })

  it('stops at ten participants with the cap message', () => {
    const task = projectTask('t1', {
      participants: Array.from({ length: 10 }, (_, index) => personRef(`u-${index}`, `Person ${index}`)),
    }) as unknown as ProjectTask
    renderDialog({}, { task })
    expect(screen.getByText('A task can have at most 10 participants.')).toBeTruthy()
  })
})

describe('refusals keep what was typed and land where they belong', () => {
  const fill = () => type('Title', 'Send the offer')

  it('assignee_not_on_project: on the Assignee field', async () => {
    renderDialog({ 'POST /activities': () => problem(422, 'assignee_not_on_project') })
    fill()
    type('Assignee', 'u-bob')

    submit()

    expect(await screen.findByText('Choose someone who is on this project.')).toBeTruthy()
    expect((screen.getByLabelText('Title', { exact: false }) as HTMLInputElement).value).toBe('Send the offer')
    expect(onSaved).not.toHaveBeenCalled()
  })

  it('blocker_cycle: on Blocked by, in the words of the design', async () => {
    renderDialog({
      'GET /tasks': () => ({ status: 200, body: page([projectTask('a', { subject: 'Draft' })]) }),
      'POST /activities': () => problem(422, 'blocker_cycle'),
    })
    fill()
    fireEvent.click(await screen.findByLabelText('Draft'))

    submit()

    expect(await screen.findByText('These tasks would wait on each other.')).toBeTruthy()
  })

  it.each(['blocker_is_self', 'blocker_not_in_host'])('%s: on Blocked by, with the server’s detail', async (code) => {
    renderDialog({ 'POST /activities': () => problem(422, code, {}, 'Detail from server') })
    fill()
    submit()
    const group = await screen.findByRole('group', { name: /Blocked by/ })
    await waitFor(() => expect(group.textContent).toContain('Detail from server'))
  })

  it('owner_not_app_user: on Participants', async () => {
    renderDialog({ 'POST /activities': () => problem(422, 'owner_not_app_user', {}, 'Dan has no access') })
    fill()
    submit()
    expect(await screen.findByText('Dan has no access')).toBeTruthy()
  })

  it('a validation error naming a field lands on it', async () => {
    renderDialog({ 'POST /activities': () => problem(422, 'validation_failed', { field: 'dueDate' }, 'Not a date') })
    fill()
    submit()
    expect(await screen.findByText('Not a date')).toBeTruthy()
  })

  it('409 host_read_only: an alert that nothing can change, and the list is told to reload', async () => {
    renderDialog({ 'POST /activities': () => problem(409, 'host_read_only') })
    fill()
    submit()
    expect((await screen.findByRole('alert')).textContent).toContain(
      'This project is closed or cancelled; its tasks can no longer be changed.',
    )
    expect(onHostReadOnly).toHaveBeenCalled()
  })

  it.each([
    [403, 'forbidden', 'You are not allowed to change this project’s tasks.'],
    [404, 'not_found', 'This project or task no longer exists.'],
    [503, 'host_unavailable', 'Your access could not be confirmed. Nothing was saved. Try again.'],
    [503, 'maintenance', 'Tasks are paused for maintenance. Nothing was saved.'],
    [422, 'type_not_allowed', 'Detail from server'],
  ])('%s %s: a dialog alert, the dialog stays open', async (status, code, text) => {
    renderDialog({ 'POST /activities': () => problem(status, code, {}, 'Detail from server') })
    fill()
    submit()
    await waitFor(() => expect(screen.getByRole('dialog').textContent).toContain(text))
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(onSaved).not.toHaveBeenCalled()
  })

  it('a network failure keeps the dialog open with the generic line', async () => {
    renderDialog({
      'POST /activities': () => {
        throw new TypeError('offline')
      },
    })
    fill()
    submit()
    await waitFor(() => expect(screen.getByRole('dialog').textContent).toContain('The server could not be reached'))
  })
})
