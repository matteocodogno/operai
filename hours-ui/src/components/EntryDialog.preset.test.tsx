/**
 * @vitest-environment jsdom
 *
 * EntryDialog recording with a `preset` and `fixed` (specs/20261116-record-hours-in-place T1; plan § API contracts
 * "`EntryDialog` (recording mode only)"; design S4 and S9; AC-1.3, AC-2.3, AC-3.2, AC-3.3, AC-3.4, AC-4.2, AC-5.12,
 * AC-5.13). The dialog opened from another tool's page has its target (and a task) set and shown as text; the one
 * opened from a Week cell has the day and the row's target set and still changeable. Both are the same dialog as
 * My hours', with the same rules and the same body: `onSubmit` is a spy that resolves or rejects with what hours-api
 * would have answered, the activity field and the pickers read from `fakeApi`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const { apiFetch } = vi.hoisted(() => ({
  apiFetch: vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(),
}))
vi.mock('shell/session', async () => (await import('../test-support/fakeSession')).shellSessionMock(apiFetch))

import { HoursApiError } from '../lib/errors'
import type { EntryInput } from '../lib/hoursApi.types'
import { strings } from '../strings'
import { fakeApi, requests } from '../test-support/fakeApi'
import { typeDuration } from '../test-support/typeDuration'
import { activitiesAnswer, projectTasks } from '../test-support/fixtures/activity'
import {
  DEAL_ROWS,
  ENTRY_LISTS,
  MEETING_ROWS,
  PROJECT_ROWS,
  RETIRED_ONLY_LISTS,
  TODAY,
} from '../test-support/fixtures/entry'
import EntryDialog from './EntryDialog'
import type { EntryDialogProps } from './EntryDialog'
import type { EntryPreset } from './EntryDialogModel'

const e = strings.entry
const f = e.fields

type Submit = (input: EntryInput) => Promise<void>

let onSubmit: ReturnType<typeof vi.fn<Submit>>
let onCancel: ReturnType<typeof vi.fn<() => void>>
let onReloadLists: ReturnType<typeof vi.fn<() => void>>

const useApi = (overrides: Parameters<typeof fakeApi>[0] = {}) => {
  apiFetch.mockImplementation(
    fakeApi({
      'GET /projects': () => ({ status: 200, body: PROJECT_ROWS }),
      'GET /deals': () => ({ status: 200, body: DEAL_ROWS }),
      'GET /meetings': () => ({ status: 200, body: MEETING_ROWS }),
      ...overrides,
    }),
  )
}

type Recording = Pick<Extract<EntryDialogProps, { entry?: undefined }>, 'focus'> & {
  preset: EntryPreset
  fixed?: boolean
}

const renderDialog = (recording: Recording, shared: Partial<Pick<EntryDialogProps, 'lists'>> = {}) =>
  render(
    <EntryDialog
      lists={{ status: 'loaded', lists: ENTRY_LISTS }}
      onReloadLists={onReloadLists}
      onSubmit={onSubmit}
      onCancel={onCancel}
      {...shared}
      {...recording}
    />,
  )

beforeEach(() => {
  apiFetch.mockReset()
  useApi()
  onSubmit = vi.fn<Submit>(async () => {})
  onCancel = vi.fn<() => void>()
  onReloadLists = vi.fn<() => void>()
  // Only the clock: the pickers' debounce and the waits below run on real timers.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-13T12:00:00.000Z'))
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const PROJECT = { id: 'p1', name: 'Project Alpha', companyName: 'Acme' }
const DEAL = { id: 'd1', title: 'Acme renewal', companyName: 'Acme' }
const MEETING = { id: 'm1', title: 'Kick-off with Acme', startsAt: '2026-11-03T09:30:00.000Z' }
const ON_PROJECT: EntryPreset = { on: { kind: 'project', project: PROJECT } }
const ON_DEAL: EntryPreset = { on: { kind: 'deal', deal: DEAL } }
const ON_NOTHING: EntryPreset = { on: { kind: 'none', categoryId: null } }

const describedBy = (control: HTMLElement) =>
  (control.getAttribute('aria-describedby') ?? '')
    .split(' ')
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent ?? '')
    .join(' ')
const dialog = () => screen.getByRole('dialog', { name: e.dialog.recordTitle })
const dayField = () => screen.getByLabelText(new RegExp(`^${f.day}`)) as HTMLInputElement
const durationField = () => screen.getByRole('textbox', { name: f.duration.label }) as HTMLInputElement
const noteField = () => screen.getByRole('textbox', { name: new RegExp(`^${f.note.label}`) }) as HTMLTextAreaElement
const select = (name: string) => screen.getByRole('combobox', { name }) as HTMLSelectElement
const submitButton = () => screen.getByRole('button', { name: e.dialog.save })
const save = () => userEvent.click(submitButton())
const kindRadio = (name: string) =>
  within(screen.getByRole('radiogroup', { name: f.on.label })).getByRole('radio', { name }) as HTMLInputElement

describe('the props (plan § API contracts)', () => {
  it('take `fixed` only with a `preset`: without one it does not compile', () => {
    const shared = { lists: { status: 'loading' }, onReloadLists, onCancel, onSubmit } satisfies EntryDialogProps
    // `tsc -b` is the test: were `fixed` allowed alone, this line would be an unused directive and fail the build.
    // @ts-expect-error `fixed` needs a `preset` to fix
    const alone: EntryDialogProps = { ...shared, fixed: true }
    const withPreset: EntryDialogProps = { ...shared, preset: ON_PROJECT, fixed: true }

    expect([alone.entry, withPreset.entry]).toEqual([undefined, undefined])
  })
})

describe('a fixed project (AC-1.3; design S4)', () => {
  it('shows the project as text in the dialog’s description, with no "What was it on" and no picker', () => {
    renderDialog({ preset: ON_PROJECT, fixed: true })

    expect(describedBy(dialog())).toBe(`${e.fixed.onProject.lead}Project Alpha${e.fixed.onProject.trail}`)
    expect(screen.queryByRole('radiogroup')).toBeNull()
    expect(screen.queryByRole('radio')).toBeNull()
    expect(screen.queryByRole('combobox', { name: f.project.label })).toBeNull()
    expect(screen.queryByRole('combobox', { name: f.deal.label })).toBeNull()
    expect(screen.queryByRole('combobox', { name: f.meeting.label })).toBeNull()
  })
})

describe('the sentence under the title of a fixed dialog (AC-1.3, AC-2.3, AC-3.4; design S4)', () => {
  const ON_MEETING: EntryPreset = { on: { kind: 'meeting', meeting: MEETING } }

  it.each([
    ['project', ON_PROJECT, 'Project Alpha', e.fixed.onProject],
    ['deal', ON_DEAL, 'Acme renewal', e.fixed.onDeal],
    ['meeting', ON_MEETING, 'Kick-off with Acme', e.fixed.onMeeting],
  ] as const)('names the %s, set apart from the sentence around it', (_kind, preset, name, sentence) => {
    renderDialog({ preset, fixed: true })

    expect(describedBy(dialog())).toBe(`${sentence.lead}${name}${sentence.trail}`)
    expect(screen.getByText(name).className).toContain('font-medium')
  })

  it.each([
    ['project', { on: { kind: 'project', project: { ...PROJECT, name: '' } } }, e.fixed.onThisProject],
    ['deal', { on: { kind: 'deal', deal: { ...DEAL, title: '' } } }, e.fixed.onThisDeal],
    ['meeting', { on: { kind: 'meeting', meeting: { ...MEETING, title: ' ' } } }, e.fixed.onThisMeeting],
  ] as const)(
    'says "this %s" when the host could not name it, never a blank and never an id',
    (_kind, preset, sentence) => {
      renderDialog({ preset, fixed: true })

      expect(describedBy(dialog())).toBe(sentence)
      expect(dialog().textContent).not.toMatch(/\b(p1|d1|m1)\b/)
    },
  )

  it('says a task about no deal is recorded as other work, and is not linked to the task', () => {
    renderDialog({ preset: ON_NOTHING, fixed: true })

    expect(describedBy(dialog())).toBe(e.fixed.onOtherWork)
  })

  it('has no description when the target is only the starting point', () => {
    renderDialog({ preset: ON_PROJECT })

    expect(dialog().getAttribute('aria-describedby')).toBeNull()
  })
})

describe('other work, fixed (AC-3.4, AC-3.5, A3; design S4 "A deal-less CRM task")', () => {
  it('has Other work as its kind, with nothing to choose it with, and a Category with nothing chosen', () => {
    renderDialog({ preset: ON_NOTHING, fixed: true })

    expect(screen.queryByRole('radiogroup')).toBeNull()
    expect(select(f.category.label).value).toBe('')
    // The placeholder is a hidden, disabled option: what is on offer is the live categories, never "Seminars" (retired).
    expect(
      within(select(f.category.label))
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Formazione', 'Administration', 'Other'])
    expect(screen.queryByRole('combobox', { name: f.workType.label })).toBeNull()
    expect(screen.queryByRole('combobox', { name: strings.activity.label })).toBeNull()
  })

  it('asks for a category, and sends nothing until one is chosen', async () => {
    renderDialog({ preset: ON_NOTHING, fixed: true, focus: 'duration' })
    await typeDuration(durationField(), '1:30')
    await save()

    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByText(e.errors.categoryRequired)).not.toBeNull()
    expect(select(f.category.label).getAttribute('aria-invalid')).toBe('true')
    expect(document.activeElement).toBe(select(f.category.label))
  })

  it('records other work with the chosen category and no task, in the body My hours would send (AC-3.5)', async () => {
    renderDialog({ preset: ON_NOTHING, fixed: true, focus: 'duration' })
    await typeDuration(durationField(), '1:30')
    await userEvent.selectOptions(select(f.category.label), 'Formazione')
    await save()

    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit).toHaveBeenCalledWith({
      day: TODAY,
      minutes: 90,
      on: { type: 'none', categoryId: 'tc-formazione' },
    })
  })

  it('has the preset category chosen, but reads one that was retired since as unchosen', () => {
    const view = renderDialog({ preset: { on: { kind: 'none', categoryId: 'tc-admin' } }, fixed: true })
    expect(select(f.category.label).value).toBe('tc-admin')
    view.unmount()

    renderDialog({ preset: { on: { kind: 'none', categoryId: 'tc-seminars' } }, fixed: true })
    expect(select(f.category.label).value).toBe('')
  })

  it('blocks Save, saying why, when no category is on offer', () => {
    renderDialog({ preset: ON_NOTHING, fixed: true }, { lists: { status: 'loaded', lists: RETIRED_ONLY_LISTS } })

    expect(screen.getByText(f.category.noneAvailable)).not.toBeNull()
    expect((submitButton() as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('a fixed task (AC-3.2, AC-3.3; design S4 "The fixed task")', () => {
  const TASK = { id: 'a-offer', subject: 'Write the offer' }
  const WITH_TASK: EntryPreset = { ...ON_PROJECT, activity: TASK }
  const activityFact = () => screen.getByText(strings.activity.label, { selector: 'dt' }).closest('div') as HTMLElement

  it('shows the task’s subject as a fact with its own hint: no select, and no read of activities-api', async () => {
    useApi({ 'GET /activities': () => activitiesAnswer(projectTasks) })
    renderDialog({ preset: WITH_TASK, fixed: true })
    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(within(activityFact()).getByText('Write the offer', { selector: 'dd' })).not.toBeNull()
    expect(screen.getByText(strings.activity.fixed.hint)).not.toBeNull()
    expect(screen.queryByRole('combobox', { name: strings.activity.label })).toBeNull()
    expect(requests(apiFetch, 'GET /activities')).toEqual([])
  })

  it('does the same for a deal’s task', async () => {
    renderDialog({
      preset: { ...ON_DEAL, activity: { id: 'a-call', subject: 'Call Acme about the renewal' } },
      fixed: true,
    })
    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(within(activityFact()).getByText('Call Acme about the renewal', { selector: 'dd' })).not.toBeNull()
    expect(screen.queryByRole('combobox', { name: strings.activity.label })).toBeNull()
    expect(requests(apiFetch, 'GET /activities')).toEqual([])
  })

  it('reads "This task" for a task with no subject', () => {
    renderDialog({ preset: { ...ON_PROJECT, activity: { id: 'a-offer', subject: null } }, fixed: true })

    expect(within(activityFact()).getByText(strings.activity.fixed.unnamed, { selector: 'dd' })).not.toBeNull()
  })

  it('sits right under the description, before Work type, so what is fixed reads together (design S4)', () => {
    renderDialog({ preset: WITH_TASK, fixed: true })

    const before = (first: Element, second: Element) =>
      Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING)
    expect(before(activityFact(), select(f.workType.label))).toBe(true)
    expect(before(activityFact(), noteField())).toBe(true)
  })

  it('stays after Work type, as in My hours, when there is a select to choose with', () => {
    renderDialog({ preset: ON_PROJECT, fixed: true })

    expect(
      Boolean(
        select(f.workType.label).compareDocumentPosition(select(strings.activity.label)) &
        Node.DOCUMENT_POSITION_FOLLOWING,
      ),
    ).toBe(true)
  })

  it('records the hours on the project and on the task: the body carries `activityId` (AC-3.2)', async () => {
    renderDialog({ preset: WITH_TASK, fixed: true, focus: 'duration' })
    await typeDuration(durationField(), '2:30')
    await save()

    expect(onSubmit).toHaveBeenCalledWith({
      day: TODAY,
      minutes: 150,
      on: { type: 'project', id: 'p1' },
      activityId: 'a-offer',
    })
  })

  it('keeps a preset task that is only the starting point as the field’s chosen option, until another target is picked', async () => {
    useApi({ 'GET /activities': () => activitiesAnswer(projectTasks) })
    // `a-old` is not on the page the field reads (the latest tasks only): the preset is what keeps it on offer.
    renderDialog({ preset: { ...ON_PROJECT, activity: { id: 'a-old', subject: 'Old task' } } })

    await waitFor(() => expect(select(strings.activity.label).getAttribute('aria-disabled')).toBeNull())
    expect(select(strings.activity.label).selectedOptions[0]?.textContent).toBe('Old task')
    await typeDuration(durationField(), '1:00')
    await save()
    expect(onSubmit).toHaveBeenCalledWith({
      day: TODAY,
      minutes: 60,
      on: { type: 'project', id: 'p1' },
      activityId: 'a-old',
    })
  })

  it('opened with no task, offers the project’s activities as My hours does, optional', async () => {
    useApi({ 'GET /activities': () => activitiesAnswer(projectTasks) })
    renderDialog({ preset: ON_PROJECT, fixed: true })

    await waitFor(() => expect(select(strings.activity.label).getAttribute('aria-disabled')).toBeNull())
    expect(requests(apiFetch, 'GET /activities').map((request) => request.query['projectId'])).toEqual(['p1'])
    await userEvent.selectOptions(select(strings.activity.label), 'Task · Review the design')
    await typeDuration(durationField(), '1:00')
    await save()
    expect(onSubmit).toHaveBeenCalledWith({
      day: TODAY,
      minutes: 60,
      on: { type: 'project', id: 'p1' },
      activityId: 'a-review',
    })
  })
})

describe('a preset that is only the starting point (AC-5.12, AC-5.13; design S9)', () => {
  const picker = (name: string) => screen.getByRole('combobox', { name }) as HTMLInputElement
  const ON_MEETING: EntryPreset = { on: { kind: 'meeting', meeting: MEETING } }

  it('opens on the day and the row’s project, with the radio and the picker still there to change them', () => {
    renderDialog({ preset: { day: '2026-11-12', ...ON_PROJECT }, focus: 'duration' })

    expect(dayField().value).toBe('2026-11-12')
    expect(kindRadio(f.on.options.project).checked).toBe(true)
    expect(picker(f.project.label).value).toBe('Project Alpha')
    expect(document.activeElement).toBe(durationField())
  })

  it.each([
    ['deal', ON_DEAL, f.on.options.deal, f.deal.label, 'Acme renewal'],
    ['meeting', ON_MEETING, f.on.options.meeting, f.meeting.label, 'Kick-off with Acme'],
  ] as const)('opens on a %s row’s target in the same way', (_kind, preset, radio, label, name) => {
    renderDialog({ preset })

    expect(kindRadio(radio).checked).toBe(true)
    expect(picker(label).value).toBe(name)
  })

  it('opens on an other-work row’s category, still changeable', async () => {
    renderDialog({ preset: { on: { kind: 'none', categoryId: 'tc-admin' } } })

    expect(kindRadio(f.on.options.none).checked).toBe(true)
    expect(select(f.category.label).value).toBe('tc-admin')
    await userEvent.selectOptions(select(f.category.label), 'Formazione')
    expect(select(f.category.label).value).toBe('tc-formazione')
  })

  it('records on the preset as it stands, in the body My hours would send', async () => {
    renderDialog({ preset: { day: '2026-11-12', ...ON_PROJECT }, focus: 'duration' })
    await typeDuration(durationField(), '1:00')
    await save()

    expect(onSubmit).toHaveBeenCalledWith({ day: '2026-11-12', minutes: 60, on: { type: 'project', id: 'p1' } })
  })

  it('records on what the person changed it to: the day and the target are the changed ones (AC-5.13)', async () => {
    renderDialog({ preset: { day: '2026-11-12', ...ON_PROJECT }, focus: 'duration' })
    fireEvent.change(dayField(), { target: { value: '2026-11-10' } })
    await typeDuration(durationField(), '2:00')
    await userEvent.click(kindRadio(f.on.options.deal))
    await userEvent.type(screen.getByRole('combobox', { name: f.deal.label }), 'a')
    await userEvent.click(await screen.findByRole('option', { name: /Acme renewal/ }))
    await save()

    expect(onSubmit).toHaveBeenCalledWith({ day: '2026-11-10', minutes: 120, on: { type: 'deal', id: 'd1' } })
  })

  it('drops a preset task when another project is picked, as it would a chosen one', async () => {
    renderDialog({ preset: { ...ON_PROJECT, activity: { id: 'a-old', subject: 'Old task' } } })
    await typeDuration(durationField(), '1:00')
    await userEvent.clear(screen.getByRole('combobox', { name: f.project.label }))
    await userEvent.type(screen.getByRole('combobox', { name: f.project.label }), 'b')
    await userEvent.click(await screen.findByRole('option', { name: /Project Beta/ }))
    await save()

    expect(onSubmit).toHaveBeenCalledWith({ day: TODAY, minutes: 60, on: { type: 'project', id: 'p2' } })
  })

  it('still refuses a duration that is not whole half hours, as My hours does (AC-4.2)', async () => {
    renderDialog({ preset: ON_PROJECT, fixed: true, focus: 'duration' })
    await typeDuration(durationField(), '2:10')
    await save()

    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByText(e.errors.durationSteps)).not.toBeNull()
  })

  it('opens on a day after today when the host asked for one, and Save refuses it in the usual words (AC-4.2)', async () => {
    renderDialog({ preset: { day: '2026-11-14', ...ON_PROJECT }, focus: 'duration' })
    expect(dayField().value).toBe('2026-11-14')
    await typeDuration(durationField(), '1:00')
    await save()

    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByText(e.errors.dayFuture)).not.toBeNull()
  })
})

describe('what hours-api refuses in a fixed dialog (AC-4.2; D13)', () => {
  const refusedWith = (status: number, rawCode: string | null) =>
    new HoursApiError({ status, title: `Problem ${status}`, rawCode })
  const formError = () => screen.getByTestId('hours-entry-dialog-error')
  const ON_MEETING: EntryPreset = { on: { kind: 'meeting', meeting: MEETING } }

  /** Types a duration, saves, and waits for the refusal to be shown. */
  const saveRefused = async (error: HoursApiError, preset: EntryPreset) => {
    onSubmit.mockRejectedValueOnce(error)
    renderDialog({ preset, fixed: true, focus: 'duration' })
    await typeDuration(durationField(), '2:30')
    await userEvent.type(noteField(), 'Prepared the workshop')
    await save()
    await screen.findByRole('alert')
  }

  /** Every typed value is still there, nothing is called invalid, and the dialog is open to try again. */
  const valuesSurvived = () => {
    expect(durationField().value).toBe('2:30')
    expect(dayField().value).toBe(TODAY)
    expect(document.querySelector('[aria-invalid="true"]')).toBeNull()
    expect(dialog()).not.toBeNull()
    expect(onCancel).not.toHaveBeenCalled()
  }

  it.each([
    ['not_on_project', ON_PROJECT, e.errors.notOnProject],
    ['not_involved_in_deal', ON_DEAL, e.errors.notInvolvedInDeal],
  ] as const)(
    '%s is the dialog’s one alert, in the words My hours puts on its picker, and every value survives',
    async (code, preset, sentence) => {
      await saveRefused(refusedWith(403, code), preset)

      expect(formError().textContent).toBe(sentence)
      expect(screen.queryByText(e.errors.generic)).toBeNull()
      valuesSurvived()
    },
  )

  it.each([
    ['project', ON_PROJECT, e.errors.targetGoneFixed.project],
    ['deal', ON_DEAL, e.errors.targetGoneFixed.deal],
    ['meeting', ON_MEETING, e.errors.targetGoneFixed.meeting],
  ] as const)(
    'a 404 on the %s is the alert too, with the sentence that offers no other to choose (D13)',
    async (_kind, preset, sentence) => {
      await saveRefused(refusedWith(404, 'not_found'), preset)

      expect(formError().textContent).toBe(sentence)
      expect(sentence).not.toMatch(/choose|exist|delet|permission|allowed to (see|read)|not found|missing/i)
      valuesSurvived()
    },
  )

  it('keeps the invitation to choose another for a dialog that has a picker to choose it with', async () => {
    onSubmit.mockRejectedValueOnce(refusedWith(404, 'not_found'))
    renderDialog({ preset: ON_PROJECT })
    await typeDuration(durationField(), '2:30')
    await save()

    const picker = await screen.findByRole('combobox', { name: f.project.label })
    await waitFor(() => expect(describedBy(picker)).toContain(e.errors.targetGone.project))
    expect(screen.queryByTestId('hours-entry-dialog-error')).toBeNull()
  })

  it('fails closed on host_unavailable as it does in My hours: an alert saying nothing was saved', async () => {
    await saveRefused(refusedWith(503, 'host_unavailable'), ON_PROJECT)

    expect(formError().textContent).toBe(e.errors.hostUnavailable.project)
    valuesSurvived()
  })

  it('puts activity_not_allowed on the Activity select when the page chose no task: the field is there to carry it (QE D1)', async () => {
    useApi({ 'GET /activities': () => activitiesAnswer(projectTasks) })
    onSubmit.mockRejectedValueOnce(refusedWith(422, 'activity_not_allowed'))
    renderDialog({ preset: ON_PROJECT, fixed: true, focus: 'duration' })
    await typeDuration(durationField(), '2:30')
    await save()

    const activity = await screen.findByRole('combobox', { name: strings.activity.label })
    await waitFor(() => expect(describedBy(activity)).toContain(e.errors.activityNotAllowed.project))
    expect(activity.getAttribute('aria-invalid')).toBe('true')
    expect(screen.queryByTestId('hours-entry-dialog-error')).toBeNull()
  })

  it('puts activity_not_allowed on a task it shows as a fact in the dialog’s alert, and keeps every value (QE D1)', async () => {
    await saveRefused(refusedWith(422, 'activity_not_allowed'), {
      on: { kind: 'project', project: PROJECT },
      activity: { id: 'a-gone', subject: 'Write the offer' },
    })

    expect(formError().textContent).toBe(e.errors.activityNotAllowed.project)
    expect(screen.getByTestId('hours-activity-fixed')).not.toBeNull()
    valuesSurvived()
  })

  it('puts invalid_minutes on Duration and future_day on Day, where My hours puts them', async () => {
    onSubmit.mockRejectedValueOnce(refusedWith(422, 'invalid_minutes'))
    renderDialog({ preset: ON_PROJECT, fixed: true, focus: 'duration' })
    await typeDuration(durationField(), '2:30')
    await save()

    await waitFor(() => expect(describedBy(durationField())).toContain(e.errors.durationUnreadable))
    expect(document.activeElement).toBe(durationField())
    expect(screen.queryByTestId('hours-entry-dialog-error')).toBeNull()

    onSubmit.mockRejectedValueOnce(refusedWith(422, 'future_day'))
    await save()
    await waitFor(() => expect(describedBy(dayField())).toContain(e.errors.dayFuture))
  })

  it('lets the person save again after a refusal: the dialog stays open and Save retries', async () => {
    await saveRefused(refusedWith(503, 'host_unavailable'), ON_PROJECT)
    await save()

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2))
    expect(onSubmit).toHaveBeenLastCalledWith({
      day: TODAY,
      minutes: 150,
      on: { type: 'project', id: 'p1' },
      note: 'Prepared the workshop',
    })
  })
})

describe('where the day and the keyboard start (AC-1.3, AC-2.3, AC-5.12; G7)', () => {
  it('opens on today and, with `focus: "duration"`, puts the keyboard on Duration', () => {
    renderDialog({ preset: ON_PROJECT, fixed: true, focus: 'duration' })

    expect(dayField().value).toBe(TODAY)
    expect(dayField().max).toBe(TODAY)
    expect(document.activeElement).toBe(durationField())
  })

  it('keeps Day first in the tab order, whatever has the focus', async () => {
    renderDialog({ preset: ON_PROJECT, fixed: true, focus: 'duration' })

    await userEvent.tab({ shift: true })
    expect(document.activeElement).toBe(dayField())
  })

  it('starts on Day, as My hours’ own dialog does, when no `focus` is given', () => {
    renderDialog({ preset: ON_PROJECT, fixed: true })

    expect(document.activeElement).toBe(dayField())
  })

  it('opens on the preset day, which is not today when the cell was another day (AC-5.12)', () => {
    renderDialog({ preset: { day: '2026-11-12', ...ON_PROJECT }, focus: 'duration' })

    expect(dayField().value).toBe('2026-11-12')
    expect(document.activeElement).toBe(durationField())
  })
})
