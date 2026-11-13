/**
 * @vitest-environment jsdom
 *
 * EntryDialog, editing (specs/029-time-tracking T28; design F2, S2 "Edit entry" and "The 'not visible' variant",
 * S2 "Note — when it is required", "Error surfaces"; AC-1.5, AC-2.4, AC-2.12, AC-3.4, AC-3.6, AC-4.10; plan § Entries
 * "Change an entry", "A blank note", D46, D50). The dialog owns the form, the client rules and the words for a
 * refusal; the page owns the request, so here `onSubmit` is a spy that resolves or rejects with the error hours-api
 * would have answered. The pickers and the activity field are real and read from `fakeApi`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const { apiFetch } = vi.hoisted(() => ({
  apiFetch: vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(),
}))
vi.mock('shell/session', async () => (await import('../test-support/fakeSession')).shellSessionMock(apiFetch))

import { HoursApiError } from '../lib/errors'
import type { EntryPatch, TimeEntryView } from '../lib/hoursApi.types'
import { strings } from '../strings'
import { fakeApi, requests } from '../test-support/fakeApi'
import { activitiesAnswer, dealActivities, projectTasks } from '../test-support/fixtures/activity'
import {
  DEAL_ROWS,
  EDIT_DEAL,
  EDIT_DEAL_WITH_ACTIVITY,
  EDIT_HIDDEN_DEAL,
  EDIT_HIDDEN_MEETING,
  EDIT_HIDDEN_PROJECT,
  EDIT_HIDDEN_PROJECT_NO_ACTIVITY,
  EDIT_MEETING,
  EDIT_OTHER_NO_NOTE,
  EDIT_OTHER_WITH_NOTE,
  EDIT_PROJECT,
  EDIT_RETIRED_CATEGORY,
  EDIT_RETIRED_WORK_TYPE,
  EDIT_TRAINING,
  EDIT_UNAVAILABLE_PROJECT,
  ENTRY_LISTS,
  MEETING_ROWS,
  PROJECT_ROWS,
  TODAY,
} from '../test-support/fixtures/entry'
import EntryDialog from './EntryDialog'
import type { EntryDialogProps } from './EntryDialog'

const e = strings.entry
const f = e.fields

type Submit = (patch: EntryPatch) => Promise<void>

let onSubmit: ReturnType<typeof vi.fn<Submit>>
let onCancel: ReturnType<typeof vi.fn<() => void>>
let onReloadLists: ReturnType<typeof vi.fn<() => void>>

const useApi = (overrides: Parameters<typeof fakeApi>[0] = {}) => {
  apiFetch.mockImplementation(
    fakeApi({
      'GET /projects': () => ({ status: 200, body: PROJECT_ROWS }),
      'GET /deals': () => ({ status: 200, body: DEAL_ROWS }),
      'GET /meetings': () => ({ status: 200, body: MEETING_ROWS }),
      'GET /activities': () => activitiesAnswer(projectTasks),
      ...overrides,
    }),
  )
}

const renderEdit = (entry: TimeEntryView, props: Partial<Omit<EntryDialogProps, 'entry' | 'onSubmit'>> = {}) =>
  render(
    <EntryDialog
      entry={entry}
      lists={{ status: 'loaded', lists: ENTRY_LISTS }}
      onReloadLists={onReloadLists}
      onSubmit={onSubmit}
      onCancel={onCancel}
      {...props}
    />,
  )

beforeEach(() => {
  apiFetch.mockReset()
  useApi()
  onSubmit = vi.fn<Submit>(async () => {})
  onCancel = vi.fn<() => void>()
  onReloadLists = vi.fn<() => void>()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-13T12:00:00.000Z'))
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

// ─── What the person sees and touches ───────────────────────────────────────

const dayField = () => screen.getByLabelText(new RegExp(`^${f.day}`)) as HTMLInputElement
const durationField = () => screen.getByRole('combobox', { name: f.duration.label }) as HTMLSelectElement
const onGroup = () => screen.getByRole('radiogroup', { name: f.on.label })
const kind = (name: string) => within(onGroup()).getByRole('radio', { name }) as HTMLInputElement
const noteField = () => screen.getByRole('textbox', { name: new RegExp(`^${f.note.label}`) }) as HTMLTextAreaElement
const select = (name: string) => screen.getByRole('combobox', { name }) as HTMLSelectElement
const maybe = (name: string) => screen.queryByRole('combobox', { name })
const picker = (name: string) => screen.getByRole('combobox', { name }) as HTMLInputElement
const optionTexts = (element: HTMLElement) =>
  within(element)
    .getAllByRole('option')
    .map((option) => option.textContent)
const selectedText = (element: HTMLSelectElement) => element.selectedOptions[0]?.textContent
const saveButton = () => screen.getByRole('button', { name: e.dialog.save })
const save = () => userEvent.click(saveButton())
const describedBy = (element: HTMLElement) =>
  (element.getAttribute('aria-describedby') ?? '')
    .split(' ')
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent)
    .join(' ')

const pick = async (name: string, optionName: RegExp) => {
  await userEvent.clear(picker(name))
  await userEvent.type(picker(name), 'a')
  await userEvent.click(await screen.findByRole('option', { name: optionName }))
}

/** The activity select once its read has settled. */
const activityReady = () =>
  waitFor(() => expect(select(strings.activity.label).getAttribute('aria-disabled')).toBeNull())

describe('opening an edit (F2 step 1; AC-1.5)', () => {
  it('is the "Edit entry" dialog with the same Save, and focus on Day, which holds the entry’s day', () => {
    renderEdit(EDIT_PROJECT)
    expect(screen.getByRole('dialog', { name: e.dialog.editTitle })).not.toBeNull()
    expect(screen.queryByRole('dialog', { name: e.dialog.recordTitle })).toBeNull()
    expect(saveButton()).not.toBeNull()
    expect(document.activeElement).toBe(dayField())
    expect(dayField().value).toBe('2026-11-12')
    expect(dayField().max).toBe(TODAY)
    expect(dayField().min).toBe('2000-01-01')
  })

  it('fills every value from the view: a project entry', async () => {
    renderEdit(EDIT_PROJECT)
    expect(durationField().value).toBe('150')
    expect(kind(f.on.options.project).checked).toBe(true)
    expect(picker(f.project.label).value).toBe('Project Alpha')
    expect(select(f.workType.label).value).toBe('wt-p-dev')
    expect(noteField().value).toBe('Prepared the workshop')
    // The activity is read as the person, and the entry's own pointer is selected once it arrives.
    await activityReady()
    expect(selectedText(select(strings.activity.label))).toBe('Task · Write the offer')
    expect(requests(apiFetch, 'GET /activities').map((request) => request.query)).toEqual([
      { projectId: 'p1', pageSize: '100' },
    ])
  })

  it('fills a deal entry, a meeting entry and an entry on other work', () => {
    useApi({ 'GET /activities': () => activitiesAnswer([]) })
    const deal = renderEdit(EDIT_DEAL)
    expect(kind(f.on.options.deal).checked).toBe(true)
    expect(picker(f.deal.label).value).toBe('Acme renewal')
    expect(select(f.workType.label).value).toBe('wt-d-demo')
    expect(durationField().value).toBe('90')
    deal.unmount()

    const meeting = renderEdit(EDIT_MEETING)
    expect(kind(f.on.options.meeting).checked).toBe(true)
    expect(picker(f.meeting.label).value).toBe('Kick-off with Acme')
    expect(noteField().value).toBe('Walked through the scope')
    expect(maybe(f.workType.label)).toBeNull()
    meeting.unmount()

    renderEdit(EDIT_TRAINING)
    expect(kind(f.on.options.none).checked).toBe(true)
    expect(select(f.category.label).value).toBe('tc-formazione')
    expect(noteField().value).toBe('')
  })

  it('an entry without a note has an empty note field, never the word "null"', () => {
    renderEdit(EDIT_RETIRED_CATEGORY)
    expect(noteField().value).toBe('')
  })

  it('has no start or end field: a day and a duration only (AC-1.8)', () => {
    renderEdit(EDIT_PROJECT)
    expect(document.querySelectorAll('input[type="time"], input[type="datetime-local"]')).toHaveLength(0)
  })
})

describe('what an edit sends: only the members that changed (AC-2.12, D46)', () => {
  it('a new day alone is `{ day }`', async () => {
    renderEdit(EDIT_PROJECT)
    fireEvent.change(dayField(), { target: { value: '2026-11-10' } })
    await save()
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit.mock.calls[0]![0]).toEqual({ day: '2026-11-10' })
  })

  it('a new duration alone is `{ minutes }`, and the target, work type, activity and note are not sent', async () => {
    renderEdit(EDIT_PROJECT)
    await userEvent.selectOptions(durationField(), '60')
    await save()
    expect(onSubmit.mock.calls[0]![0]).toEqual({ minutes: 60 })
  })

  it('a note-only edit sends `{ note }` exactly as typed', async () => {
    renderEdit(EDIT_PROJECT)
    fireEvent.change(noteField(), { target: { value: '  Prepared the workshop and the demo ' } })
    await save()
    expect(onSubmit.mock.calls[0]![0]).toEqual({ note: '  Prepared the workshop and the demo ' })
  })

  it('a new work type alone is `{ workTypeId }`', async () => {
    renderEdit(EDIT_PROJECT)
    await userEvent.selectOptions(select(f.workType.label), 'Analysis')
    await save()
    expect(onSubmit.mock.calls[0]![0]).toEqual({ workTypeId: 'wt-p-analysis' })
  })

  it('"No work type" clears the work type with an explicit `null`', async () => {
    renderEdit(EDIT_PROJECT)
    await userEvent.selectOptions(select(f.workType.label), f.workType.none)
    await save()
    expect(onSubmit.mock.calls[0]![0]).toEqual({ workTypeId: null })
  })

  it('a new activity alone is `{ activityId }`', async () => {
    renderEdit(EDIT_PROJECT)
    await activityReady()
    await userEvent.selectOptions(select(strings.activity.label), 'Task · Review the design')
    await save()
    expect(onSubmit.mock.calls[0]![0]).toEqual({ activityId: 'a-review' })
  })

  it('"No activity" clears the activity with an explicit `null`', async () => {
    renderEdit(EDIT_PROJECT)
    await activityReady()
    await userEvent.selectOptions(select(strings.activity.label), strings.activity.none)
    await save()
    expect(onSubmit.mock.calls[0]![0]).toEqual({ activityId: null })
  })

  it('the project picked again is no move: nothing about the target is sent', async () => {
    renderEdit(EDIT_PROJECT)
    await activityReady()
    await pick(f.project.label, /Project Alpha/)
    await activityReady()
    // Typing after a pick dropped the activity, as for any change of target; choosing it again keeps the entry
    // on the same project, so `on` is not sent.
    await userEvent.selectOptions(select(strings.activity.label), 'Task · Write the offer')
    await userEvent.selectOptions(durationField(), '60')
    await save()
    expect(onSubmit.mock.calls[0]![0]).toEqual({ minutes: 60 })
  })

  it('another project is `on`, and clears the activity that belonged to the old one with an explicit `null`', async () => {
    renderEdit(EDIT_PROJECT)
    await activityReady()
    await pick(f.project.label, /Project Beta/)
    await save()
    expect(onSubmit.mock.calls[0]![0]).toEqual({ on: { type: 'project', id: 'p2' }, activityId: null })
  })

  it('another project with an activity of the new one chosen: `on` and the new `activityId`', async () => {
    renderEdit(EDIT_PROJECT)
    await activityReady()
    await pick(f.project.label, /Project Beta/)
    await activityReady()
    await userEvent.selectOptions(select(strings.activity.label), 'Task · Review the design')
    await save()
    expect(onSubmit.mock.calls[0]![0]).toEqual({ on: { type: 'project', id: 'p2' }, activityId: 'a-review' })
  })

  it('moving to another kind sends the new target and clears the work type and the activity with `null`', async () => {
    renderEdit(EDIT_PROJECT)
    await userEvent.click(kind(f.on.options.meeting))
    await pick(f.meeting.label, /Kick-off with Acme/)
    await save()
    expect(onSubmit.mock.calls[0]![0]).toEqual({
      on: { type: 'meeting', id: 'm1' },
      workTypeId: null,
      activityId: null,
    })
  })

  it('moving to other work sends the category, and the work type and activity are cleared', async () => {
    renderEdit(EDIT_PROJECT)
    await userEvent.click(kind(f.on.options.none))
    await userEvent.selectOptions(select(f.category.label), 'Formazione')
    await save()
    expect(onSubmit.mock.calls[0]![0]).toEqual({
      on: { type: 'none', categoryId: 'tc-formazione' },
      workTypeId: null,
      activityId: null,
    })
  })

  it('moving from a deal to a project sends the project and clears the deal’s work type', async () => {
    useApi({ 'GET /activities': () => activitiesAnswer([]) })
    renderEdit(EDIT_DEAL)
    await userEvent.click(kind(f.on.options.project))
    await pick(f.project.label, /Project Alpha/)
    await save()
    expect(onSubmit.mock.calls[0]![0]).toEqual({ on: { type: 'project', id: 'p1' }, workTypeId: null })
  })

  it('changing several members sends exactly those', async () => {
    renderEdit(EDIT_PROJECT)
    fireEvent.change(dayField(), { target: { value: '2026-11-11' } })
    await userEvent.selectOptions(durationField(), '240')
    fireEvent.change(noteField(), { target: { value: 'Rewritten' } })
    await save()
    expect(onSubmit.mock.calls[0]![0]).toEqual({ day: '2026-11-11', minutes: 240, note: 'Rewritten' })
  })

  it('nothing was changed: Save closes the dialog and sends nothing (an empty PATCH is a 400)', async () => {
    renderEdit(EDIT_PROJECT)
    await save()
    expect(onSubmit).not.toHaveBeenCalled()
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})

describe('a category or work type retired since (AC-3.4)', () => {
  it('an entry on a retired category keeps it, shown as retired, and offers the live ones beside it', () => {
    renderEdit(EDIT_RETIRED_CATEGORY)
    const category = select(f.category.label)
    expect(selectedText(category)).toBe('Seminars (retired)')
    expect(category.value).toBe('tc-seminars')
    // In the list's own order, the entry's retired category where the list puts it.
    expect(optionTexts(category)).toEqual(['Formazione', 'Administration', 'Seminars (retired)', 'Other'])
    expect(category.getAttribute('aria-disabled')).toBeNull()
  })

  it('a note-only edit of an entry on a retired category sends `{ note }`: the category is not touched', async () => {
    renderEdit(EDIT_RETIRED_CATEGORY)
    await userEvent.type(noteField(), 'Conference day')
    await save()
    expect(onSubmit.mock.calls[0]![0]).toEqual({ note: 'Conference day' })
  })

  it('a day or duration edit of it sends no category either', async () => {
    renderEdit(EDIT_RETIRED_CATEGORY)
    await userEvent.selectOptions(durationField(), '60')
    await save()
    expect(onSubmit.mock.calls[0]![0]).toEqual({ minutes: 60 })
  })

  it('moving it to a live category is `on`, and the retired one is then no longer on offer as a new choice', async () => {
    renderEdit(EDIT_RETIRED_CATEGORY)
    await userEvent.selectOptions(select(f.category.label), 'Formazione')
    await save()
    expect(onSubmit.mock.calls[0]![0]).toEqual({ on: { type: 'none', categoryId: 'tc-formazione' } })
  })

  it('another entry does not see the retired category: it is offered only to the entry that has it', () => {
    renderEdit(EDIT_TRAINING)
    expect(optionTexts(select(f.category.label))).not.toContain('Seminars (retired)')
    expect(optionTexts(select(f.category.label))).not.toContain('Seminars')
  })

  it('an entry on a retired work type keeps it, shown as retired, and a minutes-only edit does not send it', async () => {
    renderEdit(EDIT_RETIRED_WORK_TYPE)
    expect(selectedText(select(f.workType.label))).toBe('Legacy support (retired)')
    await userEvent.selectOptions(durationField(), '60')
    await save()
    expect(onSubmit.mock.calls[0]![0]).toEqual({ minutes: 60 })
  })

  it('a note-only edit of an entry on a retired work type is exactly `{ note }`: the work type it never touched stays', async () => {
    renderEdit(EDIT_RETIRED_WORK_TYPE)
    await userEvent.type(noteField(), 'Handed over')
    await save()
    // Not `{ note, workTypeId: null }`: a retired work type is the entry's own, never "unchosen".
    expect(onSubmit.mock.calls[0]![0]).toEqual({ note: 'Handed over' })
  })

  it('the same while the lists are loading, and after they failed to load', async () => {
    const loading = renderEdit(EDIT_RETIRED_WORK_TYPE, { lists: { status: 'loading' } })
    expect(selectedText(select(f.workType.label))).toBe('Legacy support (retired)')
    await userEvent.type(noteField(), 'Handed over')
    await save()
    expect(onSubmit.mock.calls[0]![0]).toEqual({ note: 'Handed over' })
    loading.unmount()
    onSubmit.mockClear()

    renderEdit(EDIT_RETIRED_WORK_TYPE, { lists: { status: 'error' } })
    await userEvent.type(noteField(), 'Handed over')
    await save()
    expect(onSubmit.mock.calls[0]![0]).toEqual({ note: 'Handed over' })
  })

  it('moving to another project keeps a retired work type (the same list carries it) and still clears the activity', async () => {
    renderEdit({
      ...EDIT_RETIRED_WORK_TYPE,
      activity: { id: 'a-offer', subject: 'Write the offer', visibility: 'visible' },
    })
    await activityReady()
    await pick(f.project.label, /Project Beta/)
    await save()
    expect(onSubmit.mock.calls[0]![0]).toEqual({ on: { type: 'project', id: 'p2' }, activityId: null })
  })

  it('choosing another work type for it is `{ workTypeId }`, and the retired one is then no longer chosen', async () => {
    renderEdit(EDIT_RETIRED_WORK_TYPE)
    await userEvent.selectOptions(select(f.workType.label), 'Analysis')
    await save()
    expect(onSubmit.mock.calls[0]![0]).toEqual({ workTypeId: 'wt-p-analysis' })
  })

  it('moving a deal entry to another deal carries its work type and sends the cleared activity as `null`, never omitted', async () => {
    useApi({ 'GET /activities': () => activitiesAnswer(dealActivities) })
    renderEdit(EDIT_DEAL_WITH_ACTIVITY)
    await activityReady()
    expect(selectedText(select(strings.activity.label))).toBe('Call · Call Acme about the renewal')
    await pick(f.deal.label, /Globex pilot/)
    await save()
    expect(onSubmit.mock.calls[0]![0]).toEqual({ on: { type: 'deal', id: 'd2' }, activityId: null })
  })

  it('the retired work type is the project list’s: moving the entry to a deal does not offer it', async () => {
    renderEdit(EDIT_RETIRED_WORK_TYPE)
    await userEvent.click(kind(f.on.options.deal))
    expect(optionTexts(select(f.workType.label))).toEqual([f.workType.none, 'Analysis', 'Demo'])
  })

  it('the entry keeps its category and work type even while the lists are loading or failed to load', async () => {
    renderEdit(EDIT_RETIRED_CATEGORY, { lists: { status: 'loading' } })
    expect(selectedText(select(f.category.label))).toBe('Seminars (retired)')
    await userEvent.type(noteField(), 'Conference day')
    await save()
    expect(onSubmit.mock.calls[0]![0]).toEqual({ note: 'Conference day' })
  })
})

describe('the "not visible" variant (design S2; AC-4.10, D43, AC-2.12)', () => {
  const dialog = (): HTMLElement => screen.getByRole('dialog')

  it('keeps the entry on its type, and the picker holds "Not visible to you" with the hint that says why', () => {
    renderEdit(EDIT_HIDDEN_PROJECT)
    expect(kind(f.on.options.project).checked).toBe(true)
    expect(picker(f.project.label).value).toBe(strings.names.hidden)
    expect(describedBy(picker(f.project.label))).toContain(f.project.hiddenHint)
    expect(describedBy(picker(f.project.label))).not.toContain(f.project.hint)
    expect(dialog().textContent).not.toContain('Secret project')
    // The id the dialog holds to keep the entry on its project is never drawn: not as text, not in any attribute.
    expect(dialog().innerHTML).not.toContain('p-secret')
    expect(dialog().innerHTML).not.toContain('a-secret')
  })

  it('a hidden deal and meeting leak no id into the markup either', () => {
    const deal = renderEdit(EDIT_HIDDEN_DEAL)
    expect(dialog().innerHTML).not.toContain('d-secret')
    deal.unmount()
    renderEdit(EDIT_HIDDEN_MEETING)
    expect(dialog().innerHTML).not.toContain('m-secret')
  })

  it('the Activity is not editable and is not fetched: it shows the pointer as "Not visible to you" and says why', async () => {
    renderEdit(EDIT_HIDDEN_PROJECT)
    const activity = select(strings.activity.label)
    expect(activity.getAttribute('aria-disabled')).toBe('true')
    expect(selectedText(activity)).toBe(strings.activity.currentHidden)
    expect(describedBy(activity)).toContain(strings.activity.locked.project)
    // Give a read the time it would take: there is none.
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(requests(apiFetch, 'GET /activities')).toEqual([])
  })

  it('an entry with no activity shows "No activity" and still reads nothing', async () => {
    renderEdit(EDIT_HIDDEN_PROJECT_NO_ACTIVITY)
    expect(selectedText(select(strings.activity.label))).toBe(strings.activity.none)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(requests(apiFetch, 'GET /activities')).toEqual([])
  })

  it('Day, Duration, Work type and Note can still be changed, and the save sends exactly those', async () => {
    renderEdit(EDIT_HIDDEN_PROJECT)
    fireEvent.change(dayField(), { target: { value: '2026-11-09' } })
    await userEvent.selectOptions(durationField(), '60')
    await userEvent.selectOptions(select(f.workType.label), 'Analysis')
    await userEvent.type(noteField(), 'Handed over')
    await save()
    expect(onSubmit).toHaveBeenCalledTimes(1)
    // No `on` (the target is unchanged) and no `activityId` (it was not touched).
    expect(onSubmit.mock.calls[0]![0]).toEqual({
      day: '2026-11-09',
      minutes: 60,
      workTypeId: 'wt-p-analysis',
      note: 'Handed over',
    })
  })

  it('a deal and a meeting the person cannot read are the same variant, in their own words', () => {
    const deal = renderEdit(EDIT_HIDDEN_DEAL)
    expect(picker(f.deal.label).value).toBe(strings.names.hidden)
    expect(describedBy(picker(f.deal.label))).toContain(f.deal.hiddenHint)
    expect(describedBy(select(strings.activity.label))).toContain(strings.activity.locked.deal)
    deal.unmount()

    renderEdit(EDIT_HIDDEN_MEETING)
    expect(picker(f.meeting.label).value).toBe(strings.names.hidden)
    expect(describedBy(picker(f.meeting.label))).toContain(f.meeting.hiddenHint)
    // A meeting has no activity field at all.
    expect(maybe(strings.activity.label)).toBeNull()
  })

  it('"Name unavailable" is not this variant: the dialog opens normally and the activity read is attempted', async () => {
    renderEdit(EDIT_UNAVAILABLE_PROJECT)
    expect(picker(f.project.label).value).toBe(strings.names.unavailable)
    expect(describedBy(picker(f.project.label))).toContain(f.project.hint)
    expect(describedBy(picker(f.project.label))).not.toContain(f.project.hiddenHint)
    await waitFor(() => expect(requests(apiFetch, 'GET /activities')).toHaveLength(1))
    await activityReady()
    expect(describedBy(select(strings.activity.label))).not.toContain(strings.activity.locked.project)
  })

  it('picking another target makes the field ordinary again: it reads that project’s activities, and `on` is sent with a cleared activity', async () => {
    renderEdit(EDIT_HIDDEN_PROJECT)
    await pick(f.project.label, /Project Alpha/)
    expect(describedBy(picker(f.project.label))).toContain(f.project.hint)
    await activityReady()
    expect(requests(apiFetch, 'GET /activities').map((request) => request.query)).toEqual([
      { projectId: 'p1', pageSize: '100' },
    ])
    // The old pointer belongs to the old project: it is not on offer for this one.
    expect(optionTexts(select(strings.activity.label))).not.toContain(strings.activity.currentHidden)
    await save()
    expect(onSubmit.mock.calls[0]![0]).toEqual({ on: { type: 'project', id: 'p1' }, activityId: null })
  })

  it('typing in the picker replaces the placeholder: nothing is chosen until another project is picked', async () => {
    renderEdit(EDIT_HIDDEN_PROJECT)
    await userEvent.type(picker(f.project.label), 'x')
    expect(describedBy(picker(f.project.label))).toContain(f.project.hint)
    await save()
    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByText(e.errors.projectRequired)).not.toBeNull()
    expect(picker(f.project.label).getAttribute('aria-invalid')).toBe('true')
  })

  it('not_on_project after picking another project is on the picker, in the words used when recording, and every value stays', async () => {
    onSubmit.mockRejectedValue(new HoursApiError({ status: 403, title: 'Forbidden', rawCode: 'not_on_project' }))
    renderEdit(EDIT_PROJECT)
    await pick(f.project.label, /Project Beta/)
    fireEvent.change(noteField(), { target: { value: 'Moved by mistake' } })
    await save()

    expect(await screen.findByText(e.errors.notOnProject)).not.toBeNull()
    expect(describedBy(picker(f.project.label))).toContain(e.errors.notOnProject)
    expect(picker(f.project.label).getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByRole('dialog', { name: e.dialog.editTitle })).not.toBeNull()
    expect(picker(f.project.label).value).toBe('Project Beta')
    expect(noteField().value).toBe('Moved by mistake')
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('not_involved_in_deal after picking another deal is on the deal picker', async () => {
    onSubmit.mockRejectedValue(new HoursApiError({ status: 403, title: 'Forbidden', rawCode: 'not_involved_in_deal' }))
    useApi({ 'GET /activities': () => activitiesAnswer([]) })
    renderEdit(EDIT_DEAL)
    await pick(f.deal.label, /Globex pilot/)
    await save()
    expect(await screen.findByText(e.errors.notInvolvedInDeal)).not.toBeNull()
    expect(describedBy(picker(f.deal.label))).toContain(e.errors.notInvolvedInDeal)
  })
})

describe('a 404 on a save (design F2 step 3, S2 "Error surfaces"; AC-2.10)', () => {
  const gone = () => new HoursApiError({ status: 404, title: 'Not found', rawCode: 'not_found' })

  it('on a save that kept the target the entry, or what it is on, can no longer be found: the dialog’s alert', async () => {
    onSubmit.mockRejectedValue(gone())
    renderEdit(EDIT_PROJECT)
    await userEvent.selectOptions(durationField(), '60')
    await save()

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe(e.errors.entryGone)
    expect(alert.textContent).toMatch(/can no longer be found/)
    expect(screen.getByRole('dialog', { name: e.dialog.editTitle })).not.toBeNull()
    // No picker error: the target was not asked about, and the person is not told which of the two is gone.
    expect(picker(f.project.label).getAttribute('aria-invalid')).toBeNull()
    expect(durationField().value).toBe('60')
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('a 404 with NO code (the entry is not the person’s, or was deleted in another tab) is the same alert, after a save that kept the target', async () => {
    onSubmit.mockRejectedValue(new HoursApiError({ status: 404, title: 'Not found' }))
    renderEdit(EDIT_PROJECT)
    await userEvent.selectOptions(durationField(), '60')
    await save()
    expect((await screen.findByRole('alert')).textContent).toBe(e.errors.entryGone)
    expect(picker(f.project.label).getAttribute('aria-invalid')).toBeNull()
  })

  it('and after a save that MOVED the entry: the entry is what is gone, so the alert, not the new project’s picker', async () => {
    onSubmit.mockRejectedValue(new HoursApiError({ status: 404, title: 'Not found' }))
    renderEdit(EDIT_PROJECT)
    await pick(f.project.label, /Project Beta/)
    await save()
    expect((await screen.findByRole('alert')).textContent).toBe(e.errors.entryGone)
    expect(screen.queryByText(e.errors.targetGone.project)).toBeNull()
    expect(picker(f.project.label).getAttribute('aria-invalid')).toBeNull()
    expect(picker(f.project.label).value).toBe('Project Beta')
  })

  it('on a save that moved the entry, `not_found` is the new target’s, on the picker, in the words used when recording', async () => {
    onSubmit.mockRejectedValue(gone())
    renderEdit(EDIT_PROJECT)
    await pick(f.project.label, /Project Beta/)
    await save()
    expect(await screen.findByText(e.errors.targetGone.project)).not.toBeNull()
    expect(describedBy(picker(f.project.label))).toContain(e.errors.targetGone.project)
    expect(screen.queryByText(e.errors.entryGone)).toBeNull()
  })

  it('host_unavailable fails closed: nothing was saved, and Save asks again', async () => {
    onSubmit.mockRejectedValueOnce(
      new HoursApiError({ status: 503, title: 'Unavailable', rawCode: 'host_unavailable' }),
    )
    renderEdit(EDIT_PROJECT)
    await pick(f.project.label, /Project Beta/)
    await save()
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe(e.errors.hostUnavailable.project)
    expect(alert.textContent).toMatch(/Nothing was saved/)

    await save()
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2))
  })
})

describe('the note when editing (design S2 "Note — when it is required"; D50, AC-3.6; plan amendment 4)', () => {
  it('a note-less entry that stays on a category since marked as requiring a note: the note is optional and unmarked', () => {
    renderEdit(EDIT_OTHER_NO_NOTE)
    expect(noteField().getAttribute('aria-required')).toBeNull()
    expect(screen.queryByText(f.note.needed)).toBeNull()
    expect(noteField().closest('.field')?.querySelector('.field-required')).toBeNull()
  })

  it('a minutes-only edit of it saves without a note and sends exactly `{ minutes }`', async () => {
    renderEdit(EDIT_OTHER_NO_NOTE)
    await userEvent.selectOptions(durationField(), '60')
    await save()
    expect(screen.queryByText(e.errors.noteRequired)).toBeNull()
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit.mock.calls[0]![0]).toEqual({ minutes: 60 })
  })

  it('a day-only edit of it likewise sends `{ day }`', async () => {
    renderEdit(EDIT_OTHER_NO_NOTE)
    fireEvent.change(dayField(), { target: { value: '2026-11-03' } })
    await save()
    expect(onSubmit.mock.calls[0]![0]).toEqual({ day: '2026-11-03' })
  })

  it('a note typed and erased again is the stored value again: no `note` is sent, and the save goes through', async () => {
    renderEdit(EDIT_OTHER_NO_NOTE)
    await userEvent.selectOptions(durationField(), '60')
    await userEvent.type(noteField(), 'oops')
    await userEvent.clear(noteField())
    await save()
    expect(screen.queryByText(e.errors.noteRequired)).toBeNull()
    expect(onSubmit.mock.calls[0]![0]).toEqual({ minutes: 60 })
  })

  it('spaces typed into an empty note change nothing', async () => {
    renderEdit(EDIT_OTHER_NO_NOTE)
    await userEvent.selectOptions(durationField(), '60')
    fireEvent.change(noteField(), { target: { value: '   ' } })
    await save()
    expect(onSubmit.mock.calls[0]![0]).toEqual({ minutes: 60 })
  })

  it('clearing the note of an entry whose category requires one is the required-note error, and nothing is sent', async () => {
    renderEdit(EDIT_OTHER_WITH_NOTE)
    expect(noteField().getAttribute('aria-required')).toBe('true')
    expect(screen.getByText(f.note.needed)).not.toBeNull()

    await userEvent.clear(noteField())
    await save()
    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByText(e.errors.noteRequired)).not.toBeNull()
    expect(noteField().getAttribute('aria-invalid')).toBe('true')
    expect(document.activeElement).toBe(noteField())

    // Only spaces is the same.
    fireEvent.change(noteField(), { target: { value: ' \t ' } })
    await save()
    expect(onSubmit).not.toHaveBeenCalled()

    // A new note saves, and is the only member sent.
    await userEvent.clear(noteField())
    await userEvent.type(noteField(), 'Internal workshop, day two')
    await save()
    expect(onSubmit.mock.calls[0]![0]).toEqual({ note: 'Internal workshop, day two' })
  })

  it('an entry that has its required note saves a duration edit without touching the note', async () => {
    renderEdit(EDIT_OTHER_WITH_NOTE)
    await userEvent.selectOptions(durationField(), '60')
    await save()
    expect(onSubmit.mock.calls[0]![0]).toEqual({ minutes: 60 })
  })

  it('moving a note-less entry to a category that requires one is the required-note error, with marker and hint appearing with the choice', async () => {
    renderEdit(EDIT_TRAINING)
    expect(noteField().getAttribute('aria-required')).toBeNull()
    await userEvent.selectOptions(select(f.category.label), 'Other')
    expect(noteField().getAttribute('aria-required')).toBe('true')
    expect(screen.getByText(f.note.needed)).not.toBeNull()
    // Nothing is announced or moved by the choice itself.
    expect(screen.queryByText(e.errors.noteRequired)).toBeNull()

    await save()
    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByText(e.errors.noteRequired)).not.toBeNull()
    expect(document.activeElement).toBe(noteField())

    await userEvent.type(noteField(), 'Now it has one')
    await save()
    expect(onSubmit.mock.calls[0]![0]).toEqual({
      on: { type: 'none', categoryId: 'tc-other' },
      note: 'Now it has one',
    })
  })

  it('moving a note-less project entry to Other work is a move to that category too', async () => {
    renderEdit(EDIT_HIDDEN_PROJECT)
    await userEvent.click(kind(f.on.options.none))
    await userEvent.selectOptions(select(f.category.label), 'Other')
    await save()
    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByText(e.errors.noteRequired)).not.toBeNull()
  })

  it('moving an entry that HAS a note saves: the note it has satisfies the category, and is not sent', async () => {
    renderEdit(EDIT_PROJECT)
    await userEvent.click(kind(f.on.options.none))
    await userEvent.selectOptions(select(f.category.label), 'Other')
    await save()
    expect(screen.queryByText(e.errors.noteRequired)).toBeNull()
    expect(onSubmit.mock.calls[0]![0]).toEqual({
      on: { type: 'none', categoryId: 'tc-other' },
      workTypeId: null,
      activityId: null,
    })
  })

  it('choosing another category and then the original back is no move: the note stays optional', async () => {
    renderEdit(EDIT_OTHER_NO_NOTE)
    await userEvent.selectOptions(select(f.category.label), 'Formazione')
    expect(noteField().getAttribute('aria-required')).toBeNull()
    await userEvent.selectOptions(select(f.category.label), 'Other')
    expect(noteField().getAttribute('aria-required')).toBeNull()
    await userEvent.selectOptions(durationField(), '60')
    await save()
    expect(onSubmit.mock.calls[0]![0]).toEqual({ minutes: 60 })
  })

  it('a note_required the server still answers (the category changed under the person) lands on the note', async () => {
    onSubmit.mockRejectedValue(new HoursApiError({ status: 422, title: 'Unprocessable', rawCode: 'note_required' }))
    renderEdit(EDIT_OTHER_NO_NOTE)
    await userEvent.selectOptions(durationField(), '60')
    await save()
    expect(await screen.findByText(e.errors.noteRequired)).not.toBeNull()
    expect(noteField().getAttribute('aria-invalid')).toBe('true')
  })
})

describe('the other client rules still apply when editing', () => {
  it('a note over 1000 code points is the field error, and nothing is sent', async () => {
    renderEdit(EDIT_PROJECT)
    fireEvent.change(noteField(), { target: { value: '😀'.repeat(1001) } })
    await save()
    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByText(e.errors.noteTooLong)).not.toBeNull()
  })

  it('a day before 01.01.2000 is the Day field error, and nothing is sent', async () => {
    renderEdit(EDIT_PROJECT)
    fireEvent.change(dayField(), { target: { value: '1999-12-31' } })
    await save()
    expect(onSubmit).not.toHaveBeenCalled()
    expect(dayField().getAttribute('aria-invalid')).toBe('true')
  })
})
