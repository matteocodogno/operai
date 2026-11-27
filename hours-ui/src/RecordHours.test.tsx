/**
 * @vitest-environment jsdom
 *
 * The Record hours button other tools embed (specs/20261116-record-hours-in-place T2; plan § API contracts
 * "`hours/RecordHours`", Decision 2, R3, R10; design S1–S5; AC-1.3, AC-2.3, AC-3.2–3.5, AC-4.1–4.4, AC-4.6). It is
 * rendered the way the shell's `HostExtension` renders it, with the six props and nothing else; `shell/session`
 * is `fakeApi` over the real `lib/hoursApi.ts`, so the paths, queries and bodies are the contract's. The dialog is My
 * hours' own `EntryDialog` (its rules and words are tested with it): what is shown here is that it opens on what the
 * host passed, records the same body, and that the message after a save is the widget's.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const { apiFetch, navigateSuite } = vi.hoisted(() => ({
  apiFetch: vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(),
  navigateSuite: vi.fn<(to: string) => void>(),
}))
vi.mock('shell/session', async () =>
  (await import('./test-support/fakeSession')).shellSessionMock(apiFetch, { navigateSuite }),
)

import RecordHours from './RecordHours'
import type { RecordHoursProps } from './RecordHoursModel'
import { presetValues, toInput } from './components/EntryDialogModel'
import { strings } from './strings'
import { deferred, fakeApi, requests } from './test-support/fakeApi'
import { afterAFrame, emulateFocusFixup } from './test-support/focusFixup'
import type { FakeAnswer } from './test-support/fakeApi'
import { activitiesAnswer, projectTasks } from './test-support/fixtures/activity'
import { DEAL_ROWS, ENTRY_LISTS, PROJECT_ROWS, TODAY, refusal } from './test-support/fixtures/entry'
import { typeDuration } from './test-support/typeDuration'
import { CONFIRMATION_DISMISS_MS } from '@operai/ui'
import { TIME_ENTRY_RECORDED, isTimeEntryRecordedDetail } from './lib/timeEntryRecordedEvent'

const e = strings.entry
const f = e.fields
const t = strings.recordHours

const PROJECT: RecordHoursProps = {
  on: 'project',
  targetId: 'p1',
  targetName: 'Alpenstrom — portale clienti',
  activityId: '',
  activityName: '',
  placement: 'page',
}
const DEAL: RecordHoursProps = { ...PROJECT, on: 'deal', targetId: 'd1', targetName: 'Acme renewal' }
const PROJECT_TASK: RecordHoursProps = {
  ...PROJECT,
  activityId: 'a-offer',
  activityName: 'Write the offer',
  placement: 'row',
}
const DEAL_TASK: RecordHoursProps = { ...DEAL, activityId: 'a-call', activityName: 'Send the offer', placement: 'row' }
/** A CRM task about a company with no deal: other work, and its subject only names the button (G3). */
const CRM_TASK: RecordHoursProps = {
  on: 'none',
  targetId: '',
  targetName: '',
  activityId: '',
  activityName: 'Call Acme about the budget',
  placement: 'row',
}

const stubApi = (overrides: Parameters<typeof fakeApi>[0] = {}) => {
  apiFetch.mockImplementation(
    fakeApi({
      'GET /time-lists': () => ({ status: 200, body: ENTRY_LISTS }),
      'GET /projects': () => ({ status: 200, body: PROJECT_ROWS }),
      'GET /deals': () => ({ status: 200, body: DEAL_ROWS }),
      ...overrides,
    }),
  )
}

beforeEach(() => {
  apiFetch.mockReset()
  navigateSuite.mockReset()
  stubApi()
  // Only the clock: the waits below run on real timers.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-13T12:00:00.000Z'))
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const recordButton = (name: string = e.record) => screen.getByRole('button', { name })
const dialog = () => screen.getByRole('dialog', { name: e.dialog.recordTitle })
const queryDialog = () => screen.queryByRole('dialog')
const describedBy = (control: HTMLElement) =>
  (control.getAttribute('aria-describedby') ?? '')
    .split(' ')
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent ?? '')
    .join(' ')
const durationField = () => screen.getByRole('textbox', { name: f.duration.label }) as HTMLInputElement
const dayField = () => screen.getByLabelText(new RegExp(`^${f.day}`)) as HTMLInputElement
const noteField = () => screen.getByRole('textbox', { name: new RegExp(`^${f.note.label}`) }) as HTMLTextAreaElement
const select = (name: string) => screen.getByRole('combobox', { name }) as HTMLSelectElement
const save = () => userEvent.click(screen.getByRole('button', { name: e.dialog.save }))
const open = async (props: RecordHoursProps) => {
  render(<RecordHours {...props} />)
  await userEvent.click(recordButton(props.activityName === '' ? e.record : t.buttonOn(props.activityName)))
  await screen.findByRole('dialog')
}
/**
 * The message the widget leaves after a save, found by its own id: the dialog has live regions of its own (the activity
 * field announces its loading), so the role alone does not tell them apart. That it IS a polite `status` is asserted
 * where the message is first shown.
 */
const MESSAGE = 'hours-record-hours-message'
const message = () => screen.queryByTestId(MESSAGE)

describe('the button (design S1, S2; AC-4.6)', () => {
  it('on a page is a secondary button with the label My hours uses, and asks for a dialog', () => {
    render(<RecordHours {...PROJECT} />)

    const button = recordButton()
    expect(button.className).toContain('btn-secondary')
    expect(button.className).not.toContain('btn-sm')
    expect(button.getAttribute('aria-haspopup')).toBe('dialog')
    expect(button.getAttribute('type')).toBe('button')
    expect(queryDialog()).toBeNull()
  })

  it('on a task row is the same button, smaller', () => {
    render(<RecordHours {...PROJECT_TASK} />)

    const button = recordButton(t.buttonOn('Write the offer'))
    expect(button.className).toContain('btn-secondary')
    expect(button.className).toContain('btn-sm')
  })

  it('is named "Record hours on <task>" when the host gave the task, and shows the plain label', () => {
    render(<RecordHours {...DEAL_TASK} />)

    const button = recordButton('Record hours on Send the offer')
    expect(button.textContent).toBe(e.record)
    expect(screen.queryByRole('button', { name: e.record })).toBeNull()
  })

  it('is named after the task for a CRM task with no deal too, though the task is never recorded on (G3)', () => {
    render(<RecordHours {...CRM_TASK} />)

    expect(recordButton('Record hours on Call Acme about the budget').textContent).toBe(e.record)
  })

  it('is named only "Record hours" when there is no task', () => {
    render(<RecordHours {...DEAL} />)

    expect(recordButton().getAttribute('aria-label')).toBeNull()
  })

  it('draws nothing until it is asked: no read of anything', () => {
    render(<RecordHours {...PROJECT_TASK} />)

    expect(requests(apiFetch)).toEqual([])
  })
})

describe('a prop set that records on nothing (plan "valid sets", R10)', () => {
  it.each([
    ['a project with no id', { ...PROJECT, targetId: '' }],
    ['a task name with no task', { ...PROJECT, activityName: 'Write the offer' }],
    ['other work with a target', { ...CRM_TASK, targetId: 'p1' }],
    ['other work with a task', { ...CRM_TASK, activityId: 'a1' }],
    ['an unknown kind', { ...PROJECT, on: 'meeting' }],
  ])('throws at render for %s, so the host’s boundary shows its fallback', (_what, props) => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => render(<RecordHours {...(props as RecordHoursProps)} />)).toThrow(/RecordHours/)
    logged.mockRestore()
  })
})

describe('opening the dialog (AC-1.3, AC-2.3, AC-3.2–3.4; plan Sequences)', () => {
  it('opens only after the lists have been read, with a busy button until then', async () => {
    const lists = deferred<FakeAnswer>()
    stubApi({ 'GET /time-lists': () => lists.promise })
    render(<RecordHours {...PROJECT} />)

    await userEvent.click(recordButton())

    await waitFor(() => expect(requests(apiFetch, 'GET /time-lists')).toHaveLength(1))
    expect(queryDialog()).toBeNull()
    expect(recordButton().getAttribute('aria-busy')).toBe('true')

    await act(async () => lists.resolve({ status: 200, body: ENTRY_LISTS }))

    expect(dialog()).not.toBeNull()
    expect(recordButton().getAttribute('aria-busy')).toBeNull()
  })

  it('reads the lists as My hours does, retired ones included, and writes nothing yet', async () => {
    await open(PROJECT)

    expect(requests(apiFetch, 'GET /time-lists').map((request) => request.query)).toEqual([{ includeRetired: 'true' }])
    expect(requests(apiFetch, 'POST /time-entries')).toEqual([])
  })

  it('drops a read nobody waits for any more, when the page goes before the lists answer', async () => {
    const lists = deferred<FakeAnswer>()
    stubApi({ 'GET /time-lists': () => lists.promise })
    const view = render(<RecordHours {...PROJECT} />)
    await userEvent.click(recordButton())
    await waitFor(() => expect(requests(apiFetch, 'GET /time-lists')).toHaveLength(1))
    const signal = apiFetch.mock.calls.find(([input]) => String(input).includes('/time-lists'))?.[1]?.signal

    view.unmount()

    expect(signal?.aborted).toBe(true)
    await act(async () => lists.resolve({ status: 200, body: ENTRY_LISTS }))
    expect(queryDialog()).toBeNull()
  })

  it('a project: the project is text in the dialog’s description, no picker and no other kind; Day is today; focus is on Duration', async () => {
    await open(PROJECT)

    expect(describedBy(dialog())).toBe(
      `${e.fixed.onProject.lead}Alpenstrom — portale clienti${e.fixed.onProject.trail}`,
    )
    expect(screen.queryByRole('radiogroup')).toBeNull()
    expect(screen.queryByRole('combobox', { name: f.project.label })).toBeNull()
    expect(dayField().value).toBe(TODAY)
    expect(document.activeElement).toBe(durationField())
  })

  it('a deal: the deal is text in the description; Day is today; focus is on Duration', async () => {
    await open(DEAL)

    expect(describedBy(dialog())).toBe(`${e.fixed.onDeal.lead}Acme renewal${e.fixed.onDeal.trail}`)
    expect(screen.queryByRole('radio')).toBeNull()
    expect(screen.queryByRole('combobox', { name: f.deal.label })).toBeNull()
    expect(dayField().value).toBe(TODAY)
    expect(document.activeElement).toBe(durationField())
  })

  it('says "this project" / "this deal" when the host could not name it, never a blank and never an id', async () => {
    await open({ ...PROJECT, targetName: '' })

    expect(describedBy(dialog())).toBe(e.fixed.onThisProject)
    expect(dialog().textContent).not.toContain('p1')
  })

  it.each([
    ['a project task', PROJECT_TASK, 'Write the offer'],
    ['a deal task', DEAL_TASK, 'Send the offer'],
  ])(
    '%s: the task is shown as a fact, with no select and no read of activities-api (AC-3.2, AC-3.3)',
    async (_what, props, subject) => {
      stubApi({ 'GET /activities': () => activitiesAnswer(projectTasks) })
      await open(props)

      expect(screen.getByText(subject, { selector: 'dd' })).not.toBeNull()
      expect(screen.getByText(strings.activity.fixed.hint)).not.toBeNull()
      expect(screen.queryByRole('combobox', { name: strings.activity.label })).toBeNull()
      expect(requests(apiFetch, 'GET /activities')).toEqual([])
      expect(document.activeElement).toBe(durationField())
    },
  )

  it('from a page, the Activity select works as in My hours: the project’s activities, optional (AC-1.3)', async () => {
    stubApi({ 'GET /activities': () => activitiesAnswer(projectTasks) })
    await open(PROJECT)

    await waitFor(() => expect(select(strings.activity.label).getAttribute('aria-disabled')).toBeNull())
    expect(requests(apiFetch, 'GET /activities').map((request) => request.query['projectId'])).toEqual(['p1'])
  })

  it('a CRM task with no deal: other work, fixed, with a category to choose and nothing chosen (AC-3.4)', async () => {
    await open(CRM_TASK)

    expect(describedBy(dialog())).toBe(e.fixed.onOtherWork)
    expect(screen.queryByRole('radiogroup')).toBeNull()
    expect(select(f.category.label).value).toBe('')
    expect(screen.queryByRole('combobox', { name: strings.activity.label })).toBeNull()
    expect(screen.queryByText(strings.activity.fixed.hint)).toBeNull()
    expect(document.activeElement).toBe(durationField())
  })

  it('opens with the lists’ failure said, and reads them again on Try again, when they could not be read', async () => {
    let attempt = 0
    stubApi({
      'GET /time-lists': () => (++attempt === 1 ? refusal(503) : { status: 200, body: ENTRY_LISTS }),
    })
    await open(CRM_TASK)

    expect(screen.getByText(f.category.loadFailed)).not.toBeNull()
    await userEvent.click(screen.getByTestId('hours-entry-lists-retry'))

    await waitFor(() => expect(select(f.category.label).getAttribute('aria-disabled')).toBeNull())
    expect(requests(apiFetch, 'GET /time-lists')).toHaveLength(2)
  })

  it('a Try again that is answered after the dialog was cancelled does not open it again', async () => {
    const again = deferred<FakeAnswer>()
    let attempt = 0
    stubApi({ 'GET /time-lists': () => (++attempt === 1 ? refusal(503) : again.promise) })
    await open(CRM_TASK)
    await userEvent.click(screen.getByTestId('hours-entry-lists-retry'))
    await waitFor(() => expect(requests(apiFetch, 'GET /time-lists')).toHaveLength(2))

    await userEvent.click(screen.getByRole('button', { name: strings.common.cancel }))
    await act(async () => again.resolve({ status: 200, body: ENTRY_LISTS }))

    expect(queryDialog()).toBeNull()
  })

  it('nor does one answered after the entry was saved: a Try again, then Save, then the lists arrive', async () => {
    const again = deferred<FakeAnswer>()
    let attempt = 0
    stubApi({ 'GET /time-lists': () => (++attempt === 1 ? refusal(503) : again.promise) })
    await open(PROJECT)
    await typeDuration(durationField(), '2:30')
    await userEvent.click(screen.getByTestId('hours-entry-lists-retry'))
    await waitFor(() => expect(requests(apiFetch, 'GET /time-lists')).toHaveLength(2))

    await save()
    await waitFor(() => expect(queryDialog()).toBeNull())
    await act(async () => again.resolve({ status: 200, body: ENTRY_LISTS }))

    expect(queryDialog()).toBeNull()
    expect(message()).not.toBeNull()
  })

  it('gives focus back to Record hours when the dialog is cancelled, whether or not the browser focused it on click', async () => {
    render(<RecordHours {...PROJECT} />)
    // Safari does not focus a button on a mouse click: a fired click leaves the focus where it was.
    fireEvent.click(recordButton())
    await screen.findByRole('dialog')

    await userEvent.click(screen.getByRole('button', { name: strings.common.cancel }))

    expect(queryDialog()).toBeNull()
    expect(document.activeElement).toBe(recordButton())
  })
})

/** Opens the dialog, types a duration (and the note, when the test gives one) and saves. */
const record = async (
  props: RecordHoursProps,
  { duration = '2:30', note }: { duration?: string; note?: string } = {},
) => {
  await open(props)
  await typeDuration(durationField(), duration)
  if (note !== undefined) await userEvent.type(noteField(), note)
  await save()
}
const posted = () => requests(apiFetch, 'POST /time-entries')

describe('what is sent (AC-4.1, AC-3.2, AC-3.5)', () => {
  it('is the body My hours builds from the same values: `toInput`', async () => {
    await open(PROJECT)
    await typeDuration(durationField(), '2:30')
    await userEvent.selectOptions(select(f.workType.label), 'Development')
    await userEvent.type(noteField(), 'Prepared the workshop')
    await save()

    const same = toInput(
      {
        ...presetValues(TODAY, {
          on: { kind: 'project', project: { id: 'p1', name: 'Alpenstrom — portale clienti', companyName: null } },
        }),
        minutes: '2:30',
        workTypeId: 'wt-p-dev',
        note: 'Prepared the workshop',
      },
      ENTRY_LISTS.workTypes.project,
    )
    expect(posted().map((request) => request.body)).toEqual([same])
    expect(same).toEqual({
      day: TODAY,
      minutes: 150,
      on: { type: 'project', id: 'p1' },
      workTypeId: 'wt-p-dev',
      note: 'Prepared the workshop',
    })
  })

  it('a deal: records on the deal', async () => {
    await record(DEAL, { duration: '1:00' })

    expect(posted().map((request) => request.body)).toEqual([
      { day: TODAY, minutes: 60, on: { type: 'deal', id: 'd1' } },
    ])
  })

  it.each([
    ['a project task', PROJECT_TASK, { type: 'project', id: 'p1' }, 'a-offer'],
    ['a deal task', DEAL_TASK, { type: 'deal', id: 'd1' }, 'a-call'],
  ])('%s: records on the project or deal and on the task', async (_what, props, on, activityId) => {
    await record(props)

    expect(posted().map((request) => request.body)).toEqual([{ day: TODAY, minutes: 150, on, activityId }])
  })

  it('from a page, the activity chosen in the select goes with it, as in My hours', async () => {
    stubApi({ 'GET /activities': () => activitiesAnswer(projectTasks) })
    await open(PROJECT)
    await waitFor(() => expect(select(strings.activity.label).getAttribute('aria-disabled')).toBeNull())
    await userEvent.selectOptions(select(strings.activity.label), 'Task · Review the design')
    await typeDuration(durationField(), '1:00')
    await save()

    expect(posted().map((request) => request.body)).toEqual([
      { day: TODAY, minutes: 60, on: { type: 'project', id: 'p1' }, activityId: 'a-review' },
    ])
  })

  it('a CRM task with no deal: other work with the chosen category and NO task, though the button is named after it (AC-3.5)', async () => {
    await open(CRM_TASK)
    await typeDuration(durationField(), '1:30')
    await userEvent.selectOptions(select(f.category.label), 'Formazione')
    await save()

    const [request] = posted()
    expect(request?.body).toEqual({ day: TODAY, minutes: 90, on: { type: 'none', categoryId: 'tc-formazione' } })
    expect(request?.body).not.toHaveProperty('activityId')
  })

  it('a CRM task with no deal asks for a category, and sends nothing until one is chosen', async () => {
    await open(CRM_TASK)
    await typeDuration(durationField(), '1:30')
    await save()

    expect(posted()).toEqual([])
    expect(screen.getByText(e.errors.categoryRequired)).not.toBeNull()
  })

  it('the day can be changed, as in My hours', async () => {
    await open(PROJECT)
    await typeDuration(durationField(), '2:00')
    fireEvent.change(dayField(), { target: { value: '2026-11-12' } })
    await save()

    expect(posted().map((request) => request.body)).toEqual([
      { day: '2026-11-12', minutes: 120, on: { type: 'project', id: 'p1' } },
    ])
  })

  it('writes only with POST /time-entries, once, and reads nothing but the lists and the activities (AC-4.4)', async () => {
    stubApi({ 'GET /activities': () => activitiesAnswer(projectTasks) })
    await record(PROJECT)
    await screen.findByTestId(MESSAGE)

    expect(
      requests(apiFetch)
        .map((request) => `${request.method} ${request.path}`)
        .sort(),
    ).toEqual(['GET /activities', 'GET /time-lists', 'POST /time-entries'])
  })
})

describe('what hours-api refuses (AC-4.2): the words and places My hours uses, every value kept', () => {
  const refuseWith = (status: number, code?: string) => stubApi({ 'POST /time-entries': () => refusal(status, code) })
  const keptValues = () => {
    expect(queryDialog()).not.toBeNull()
    expect(durationField().value).toBe('2:30')
    expect(noteField().value).toBe('Prepared the workshop')
    expect(message()).toBeNull()
  }
  const formAlert = async () => (await within(dialog()).findByRole('alert')).textContent

  it('403 not_on_project: the dialog’s one alert, with the sentence My hours gives', async () => {
    refuseWith(403, 'not_on_project')
    await record(PROJECT, { note: 'Prepared the workshop' })

    expect(await formAlert()).toBe(e.errors.notOnProject)
    keptValues()
  })

  it('403 not_involved_in_deal: the same, for a deal', async () => {
    refuseWith(403, 'not_involved_in_deal')
    await record(DEAL, { note: 'Prepared the workshop' })

    expect(await formAlert()).toBe(e.errors.notInvolvedInDeal)
    keptValues()
  })

  it('404: this project is no longer available to you, without an invitation to choose another (D13)', async () => {
    refuseWith(404, 'not_found')
    await record(PROJECT, { note: 'Prepared the workshop' })

    expect(await formAlert()).toBe(e.errors.targetGoneFixed.project)
    keptValues()
  })

  it('503 host_unavailable: the owner could not be asked, so it is refused (fail closed)', async () => {
    refuseWith(503, 'host_unavailable')
    await record(PROJECT, { note: 'Prepared the workshop' })

    expect(await formAlert()).toBe(e.errors.hostUnavailable.project)
    keptValues()
  })

  it('422 invalid_minutes: on the Duration field', async () => {
    refuseWith(422, 'invalid_minutes')
    await record(PROJECT, { note: 'Prepared the workshop' })

    await waitFor(() => expect(durationField().getAttribute('aria-invalid')).toBe('true'))
    expect(screen.getByText(e.errors.durationUnreadable)).not.toBeNull()
    keptValues()
  })

  it('a day after today: refused before anything is sent, on the Day field', async () => {
    await open(PROJECT)
    await typeDuration(durationField(), '2:30')
    fireEvent.change(dayField(), { target: { value: '2026-11-14' } })
    await save()

    expect(posted()).toEqual([])
    expect(screen.getByText(e.errors.dayFuture)).not.toBeNull()
    expect(dayField().getAttribute('aria-invalid')).toBe('true')
    expect(queryDialog()).not.toBeNull()
  })

  it('a refusal is not final: the same dialog saves once it is put right', async () => {
    let attempt = 0
    stubApi({
      'POST /time-entries': () => (++attempt === 1 ? refusal(503, 'host_unavailable') : { status: 201, body: {} }),
    })
    await record(PROJECT)
    await within(dialog()).findByRole('alert')

    await save()

    await waitFor(() => expect(queryDialog()).toBeNull())
    expect(posted()).toHaveLength(2)
    expect(message()).not.toBeNull()
  })
})

describe('a task the page fixed that hours-api no longer accepts (AC-4.2, QE D1)', () => {
  it.each([
    ['a project task', PROJECT_TASK, e.errors.activityNotAllowed.project],
    ['a deal task', DEAL_TASK, e.errors.activityNotAllowed.deal],
  ] as const)(
    '%s: the refusal is the dialog’s alert, in My hours’ words, and every value is kept',
    async (_name, props, sentence) => {
      stubApi({ 'POST /time-entries': () => refusal(422, 'activity_not_allowed') })
      await record(props, { note: 'Prepared the workshop' })

      expect((await within(dialog()).findByRole('alert')).textContent).toBe(sentence)
      expect(queryDialog()).not.toBeNull()
      expect(durationField().value).toBe('2:30')
      expect(noteField().value).toBe('Prepared the workshop')
      expect(message()).toBeNull()
    },
  )
})

describe('where the keyboard is after a refusal (QE D2; design S4 "Errors")', () => {
  // A request takes a frame or more, and a browser takes focus off the disabled Save in that time.
  let stopFixup: () => void
  beforeEach(() => {
    stopFixup = emulateFocusFixup()
  })
  afterEach(() => stopFixup())

  const saveButton = () => screen.getByRole('button', { name: e.dialog.save })
  const refusedAfterAFrame = (status: number, code?: string) =>
    stubApi({ 'POST /time-entries': () => afterAFrame(refusal(status, code)) })

  it.each([
    ['the project page', PROJECT, 403, 'not_on_project'],
    ['the deal page', DEAL, 403, 'not_involved_in_deal'],
    ['the project page, the project gone', PROJECT, 404, 'not_found'],
    ['a project task row', PROJECT_TASK, 403, 'not_on_project'],
    ['a deal task row', DEAL_TASK, 403, 'not_involved_in_deal'],
    ['a project task row, the task gone (QE D1)', PROJECT_TASK, 422, 'activity_not_allowed'],
    ['a deal task row, the task gone (QE D1)', DEAL_TASK, 422, 'activity_not_allowed'],
    ['a project page, hours-api could not ask the owner', PROJECT, 503, 'host_unavailable'],
    ['a deal task row, something went wrong', DEAL_TASK, 500, undefined],
  ] as const)('from %s: Save has it again, where pressing it is the retry', async (_where, props, status, code) => {
    refusedAfterAFrame(status, code)
    await record(props)

    await within(dialog()).findByRole('alert')
    await waitFor(() => expect(document.activeElement).toBe(saveButton()))
  })

  it('a refusal on a field is still the field’s: Duration keeps the keyboard it is given', async () => {
    refusedAfterAFrame(422, 'invalid_minutes')
    await record(PROJECT)

    await waitFor(() => expect(durationField().getAttribute('aria-invalid')).toBe('true'))
    await waitFor(() => expect(document.activeElement).toBe(durationField()))
  })
})

describe('after a save (AC-4.3, G1; design S3)', () => {
  it('closes the dialog and says what was recorded and where, in a status message with a link to My hours', async () => {
    await record(PROJECT)

    await waitFor(() => expect(queryDialog()).toBeNull())
    const status = message()!
    expect(status.getAttribute('role')).toBe('status')
    expect(status.getAttribute('aria-live')).toBe('polite')
    expect(within(status).getByTestId('hours-record-hours-recorded').textContent).toBe(
      '2 h 30 recorded on Alpenstrom — portale clienti.',
    )
    const link = within(status).getByRole('link', { name: t.seeInMyHours })
    expect(link.getAttribute('href')).toBe('/hours')
    expect(navigateSuite).not.toHaveBeenCalled()
  })

  it('names a deal, and a project or deal the host could not name as "this project" / "this deal"', async () => {
    await record(DEAL, { duration: '1:00' })
    expect((await screen.findByTestId('hours-record-hours-recorded')).textContent).toBe('1 h recorded on Acme renewal.')
    cleanup()

    await record({ ...PROJECT, targetName: '' }, { duration: '0:30' })
    expect((await screen.findByTestId('hours-record-hours-recorded')).textContent).toBe(
      '30 min recorded on this project.',
    )
    cleanup()

    await record({ ...DEAL, targetName: ' ' }, { duration: '1:30' })
    expect((await screen.findByTestId('hours-record-hours-recorded')).textContent).toBe('1 h 30 recorded on this deal.')
  })

  it('says "other work" with the category for hours that went to no project or deal (AC-3.5)', async () => {
    await open(CRM_TASK)
    await typeDuration(durationField(), '2:30')
    await userEvent.selectOptions(select(f.category.label), 'Formazione')
    await save()

    expect((await screen.findByTestId('hours-record-hours-recorded')).textContent).toBe(
      '2 h 30 recorded on other work: Formazione.',
    )
  })

  it('"See in My hours" goes to /hours through the shell’s router, not a reload', async () => {
    await record(PROJECT)
    const link = await screen.findByRole('link', { name: t.seeInMyHours })

    const notCancelled = fireEvent.click(link)

    expect(navigateSuite).toHaveBeenCalledTimes(1)
    expect(navigateSuite).toHaveBeenCalledWith('/hours')
    expect(notCancelled).toBe(false)
  })

  it.each([
    ['Ctrl', { ctrlKey: true }],
    ['Cmd', { metaKey: true }],
    ['Shift', { shiftKey: true }],
    ['the middle button', { button: 1 }],
  ])('leaves a click with %s to the browser (a new tab still works)', async (_key, init) => {
    await record(PROJECT)
    const link = await screen.findByRole('link', { name: t.seeInMyHours })

    const notCancelled = fireEvent.click(link, init)

    expect(navigateSuite).not.toHaveBeenCalled()
    expect(notCancelled).toBe(true)
  })

  it('stays: no timer takes it away, so a keyboard user can reach the link (G1, WCAG 2.2.1)', async () => {
    await open(PROJECT)
    await typeDuration(durationField(), '2:30')
    const timers = vi.spyOn(globalThis, 'setTimeout')
    await save()
    await screen.findByTestId(MESSAGE)
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(timers.mock.calls.map(([, delay]) => delay)).not.toContain(CONFIRMATION_DISMISS_MS)
    expect(message()).not.toBeNull()
    timers.mockRestore()
  })

  it('goes with ×, and focus goes back to Record hours', async () => {
    await record(PROJECT)
    await userEvent.click(await screen.findByRole('button', { name: strings.common.dismiss }))

    expect(message()).toBeNull()
    expect(document.activeElement).toBe(recordButton())
  })

  it('gives focus back to Record hours when the dialog closes on the save', async () => {
    await record(PROJECT)
    await screen.findByTestId(MESSAGE)

    expect(document.activeElement).toBe(recordButton())
  })

  it('is replaced by the next save: one message at a time', async () => {
    await record(PROJECT, { duration: '2:30' })
    await screen.findByTestId(MESSAGE)

    await userEvent.click(recordButton())
    await screen.findByRole('dialog')
    await typeDuration(durationField(), '1:00')
    await save()

    await waitFor(() => expect(queryDialog()).toBeNull())
    expect(screen.getAllByTestId(MESSAGE)).toHaveLength(1)
    expect(screen.getByTestId('hours-record-hours-recorded').textContent).toBe(
      '1 h recorded on Alpenstrom — portale clienti.',
    )
  })

  it('on a page sits just before the button, and may grow to the left of it', async () => {
    await record(PROJECT)
    const status = await screen.findByTestId(MESSAGE)

    expect(status.parentElement).toBe(recordButton().parentElement)
    expect(Boolean(status.compareDocumentPosition(recordButton()) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true)
    expect(status.className).toContain('max-w-sm')
  })

  it('on a row comes last, on its own line, in the row’s own group', async () => {
    await record(PROJECT_TASK)
    const status = await screen.findByTestId(MESSAGE)
    const button = recordButton(t.buttonOn('Write the offer'))

    expect(status.parentElement).toBe(button.parentElement)
    expect(Boolean(button.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true)
    expect(status.className).toContain('basis-full')
  })

  it('changes nothing else: no entry is read again and nothing comes back to the host through the seam', async () => {
    await record(PROJECT)
    await screen.findByTestId(MESSAGE)

    expect(requests(apiFetch, 'GET /time-entries')).toEqual([])
    expect(requests(apiFetch).filter((request) => request.method !== 'GET')).toHaveLength(1)
  })
})

describe('what it never does (AC-4.4)', () => {
  it('offers no Edit, no Delete and no Undo, in the dialog or after the save, and sends no PATCH or DELETE', async () => {
    await open(PROJECT_TASK)
    expect(screen.queryByRole('button', { name: /edit|delete|undo|modifica|elimina/i })).toBeNull()
    await typeDuration(durationField(), '2:30')
    await save()
    await screen.findByTestId(MESSAGE)

    expect(screen.queryByRole('button', { name: /edit|delete|undo|modifica|elimina/i })).toBeNull()
    expect(screen.queryByRole('link', { name: /edit|delete|modifica|elimina/i })).toBeNull()
    const methods = requests(apiFetch).map((request) => request.method)
    expect(methods).not.toContain('PATCH')
    expect(methods).not.toContain('DELETE')
  })
})

describe('the fact it broadcasts after a save (AC-2.8; plan § Refreshing after Record hours, D-P6; ADR 20261116 amended)', () => {
  // Heard the way a panel on the page hears it: on `window`, by name.
  const heard: CustomEvent[] = []
  const listen = (event: Event) => {
    heard.push(event as CustomEvent)
  }
  beforeEach(() => {
    heard.length = 0
    window.addEventListener(TIME_ENTRY_RECORDED, listen)
  })
  afterEach(() => {
    window.removeEventListener(TIME_ENTRY_RECORDED, listen)
  })
  const details = () => heard.map((event) => event.detail as unknown)

  /** A CRM task with no deal records on no entity: it needs a category before it saves. */
  const recordOtherWork = async () => {
    await open(CRM_TASK)
    await typeDuration(durationField(), '1:30')
    await userEvent.selectOptions(select(f.category.label), 'Formazione')
    await save()
  }

  it.each([
    ['the project page', PROJECT, { on: 'project', targetId: 'p1' }],
    ['the deal page', DEAL, { on: 'deal', targetId: 'd1' }],
    ['a project task row: the task’s project, never the task', PROJECT_TASK, { on: 'project', targetId: 'p1' }],
    ['a deal task row: the task’s deal, never the task', DEAL_TASK, { on: 'deal', targetId: 'd1' }],
  ])('%s: exactly one event after the save, naming the target and nothing else', async (_where, props, detail) => {
    await record(props, { note: 'Prepared the workshop' })
    await screen.findByTestId(MESSAGE)

    expect(details()).toEqual([detail])
    expect(isTimeEntryRecordedDetail(details()[0])).toBe(true)
  })

  it('other work (a CRM task with no deal): the event names no target, `targetId` is ""', async () => {
    await recordOtherWork()
    await screen.findByTestId(MESSAGE)

    expect(details()).toEqual([{ on: 'none', targetId: '' }])
    expect(isTimeEntryRecordedDetail(details()[0])).toBe(true)
  })

  it('names the target the POST was sent for: the same project or deal as the body, for every set of props', async () => {
    for (const props of [PROJECT, DEAL, PROJECT_TASK, DEAL_TASK]) {
      apiFetch.mockClear()
      heard.length = 0
      await record(props)
      await screen.findByTestId(MESSAGE)
      const body = posted()[0]?.body as { on: { type: string; id: string } }

      expect(details()).toEqual([{ on: body.on.type, targetId: body.on.id }])
      cleanup()
    }
  })

  it('is a CustomEvent on `window`, whose detail carries no minutes, day, note, person or entry id', async () => {
    await record(PROJECT, { duration: '2:30', note: 'Prepared the workshop' })
    await screen.findByTestId(MESSAGE)

    expect(heard).toHaveLength(1)
    expect(heard[0]).toBeInstanceOf(CustomEvent)
    expect(heard[0]?.type).toBe('operai:time-entry-recorded')
    expect(Object.keys(heard[0]?.detail as object).sort()).toEqual(['on', 'targetId'])
    expect(JSON.stringify(heard[0]?.detail)).not.toMatch(/150|2:30|2026|workshop|u-ada/)
  })

  it('is sent after hours-api has answered, not while the save is still on its way', async () => {
    const answer = deferred<FakeAnswer>()
    stubApi({ 'POST /time-entries': () => answer.promise })
    await record(PROJECT)
    await waitFor(() => expect(posted()).toHaveLength(1))

    expect(details()).toEqual([])
    await act(async () => answer.resolve({ status: 201, body: {} }))
    await screen.findByTestId(MESSAGE)

    expect(details()).toEqual([{ on: 'project', targetId: 'p1' }])
  })

  it.each([
    ['not_on_project', 403, 'not_on_project'],
    ['not_involved_in_deal', 403, 'not_involved_in_deal'],
    ['the project gone', 404, 'not_found'],
    ['an activity hours-api no longer accepts', 422, 'activity_not_allowed'],
    ['an unreadable duration', 422, 'invalid_minutes'],
    ['the owner could not be asked', 503, 'host_unavailable'],
    ['something went wrong', 500, undefined],
  ])('sends none when hours-api refuses the save (%s): nothing was recorded', async (_what, status, code) => {
    stubApi({ 'POST /time-entries': () => refusal(status, code) })
    await record(PROJECT, { note: 'Prepared the workshop' })
    await within(dialog()).findByRole('alert')

    expect(details()).toEqual([])
    expect(queryDialog()).not.toBeNull()
  })

  it('sends none when the request does not reach hours-api at all', async () => {
    stubApi({
      'POST /time-entries': () => {
        throw new TypeError('Failed to fetch')
      },
    })
    await record(PROJECT)
    await within(dialog()).findByRole('alert')

    expect(details()).toEqual([])
  })

  it('sends none for a save the dialog refuses before anything is sent (a day after today)', async () => {
    await open(PROJECT)
    await typeDuration(durationField(), '2:30')
    fireEvent.change(dayField(), { target: { value: '2026-11-14' } })
    await save()
    await screen.findByText(e.errors.dayFuture)

    expect(posted()).toEqual([])
    expect(details()).toEqual([])
  })

  it('sends none for a dialog that was cancelled, or a message that was dismissed afterwards', async () => {
    await open(PROJECT)
    await userEvent.click(screen.getByRole('button', { name: strings.common.cancel }))
    expect(details()).toEqual([])

    await userEvent.click(recordButton())
    await screen.findByRole('dialog')
    await typeDuration(durationField(), '2:30')
    await save()
    await screen.findByTestId(MESSAGE)
    expect(details()).toHaveLength(1)
    await userEvent.click(screen.getByRole('button', { name: strings.common.dismiss }))
    expect(details()).toHaveLength(1)
  })

  it('a refusal that is put right and saved again is one event in all: the save that happened', async () => {
    let attempt = 0
    stubApi({
      'POST /time-entries': () => (++attempt === 1 ? refusal(503, 'host_unavailable') : { status: 201, body: {} }),
    })
    await record(PROJECT)
    await within(dialog()).findByRole('alert')
    expect(details()).toEqual([])

    await save()
    await screen.findByTestId(MESSAGE)

    expect(posted()).toHaveLength(2)
    expect(details()).toEqual([{ on: 'project', targetId: 'p1' }])
  })

  it('is one event for each save: two saves, two events', async () => {
    await record(PROJECT, { duration: '2:30' })
    await screen.findByTestId(MESSAGE)
    await userEvent.click(recordButton())
    await screen.findByRole('dialog')
    await typeDuration(durationField(), '1:00')
    await save()
    await waitFor(() => expect(details()).toHaveLength(2))

    expect(details()).toEqual([
      { on: 'project', targetId: 'p1' },
      { on: 'project', targetId: 'p1' },
    ])
  })

  it('reads nothing more because of it, and sends no second write: the listener re-reads, the widget does not', async () => {
    await record(PROJECT)
    await screen.findByTestId(MESSAGE)

    expect(requests(apiFetch).filter((request) => request.method !== 'GET')).toHaveLength(1)
    expect(requests(apiFetch, 'GET /time-entries')).toEqual([])
  })
})
