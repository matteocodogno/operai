/**
 * @vitest-environment jsdom
 *
 * EntryDialog, recording (specs/029-time-tracking T27; design S2, F1; AC-1.1, AC-1.2, AC-1.3, AC-1.7, AC-1.8,
 * AC-2.1, AC-2.2, AC-2.3, AC-2.5, AC-2.7, AC-2.10, AC-2.11, AC-3.4, AC-3.5, AC-3.6). The dialog owns the form,
 * its client rules and the words for a refusal; the page owns the request, so here `onSubmit` is a spy that
 * resolves or rejects with the error hours-api would have answered. The three pickers and the activity field
 * are real and read from `fakeApi`, as the browser reads the owners.
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
import { deferred, fakeApi, requests } from '../test-support/fakeApi'
import type { FakeHandler } from '../test-support/fakeApi'
import { ORIGINS } from '../test-support/fakeSession'
import { activitiesAnswer, dealActivities, projectTasks } from '../test-support/fixtures/activity'
import {
  DEAL_ROWS,
  ENTRY_LISTS,
  MEETING_ROWS,
  PROJECT_ROWS,
  RETIRED_ONLY_LISTS,
  TODAY,
  emoji,
  refusal,
} from '../test-support/fixtures/entry'
import EntryDialog from './EntryDialog'
import type { EntryDialogProps } from './EntryDialog'

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

const renderDialog = (props: Partial<Omit<EntryDialogProps, 'entry' | 'onSubmit'>> = {}) =>
  render(
    <EntryDialog
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
  // Only the clock: the pickers' debounce and the waits below run on real timers.
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
const optionTexts = (element: HTMLElement) =>
  within(element)
    .getAllByRole('option')
    .map((option) => option.textContent)
const submitButton = () => screen.getByRole('button', { name: e.dialog.save })

/** Chooses what the hours were on. */
const chooseKind = (label: string) => userEvent.click(kind(label))

/** Picks the first match of `name` in a server-searched picker, as a person does: type, wait, click. */
const pick = async (picker: string, optionName: RegExp) => {
  await userEvent.type(screen.getByRole('combobox', { name: picker }), 'a')
  await userEvent.click(await screen.findByRole('option', { name: optionName }))
}
const pickProject = () => pick(f.project.label, /Project Alpha/)
const pickDeal = () => pick(f.deal.label, /Acme renewal/)
const pickMeeting = () => pick(f.meeting.label, /Kick-off with Acme/)

describe('opening the dialog (AC-1.1, AC-1.2, AC-1.8, AC-2.1; design S2)', () => {
  it('is the record dialog, with focus on Day, which is today in Zurich and cannot be after it', () => {
    renderDialog()
    expect(screen.getByRole('dialog', { name: e.dialog.recordTitle })).not.toBeNull()
    expect(document.activeElement).toBe(dayField())
    expect(dayField().value).toBe(TODAY)
    expect(dayField().max).toBe(TODAY)
    expect(dayField().getAttribute('aria-required')).toBe('true')
  })

  it('offers exactly 48 durations, 30 min to 24 h in steps of 30, and none is chosen for the person', () => {
    renderDialog()
    const texts = optionTexts(durationField())
    expect(texts).toHaveLength(48)
    expect(texts.slice(0, 4)).toEqual(['30 min', '1 h', '1 h 30', '2 h'])
    expect(texts.at(-2)).toBe('23 h 30')
    expect(texts.at(-1)).toBe('24 h')
    expect(durationField().value).toBe('')
    expect(durationField().getAttribute('aria-required')).toBe('true')
    expect(screen.getByText(f.duration.hint)).not.toBeNull()
  })

  it('has no start or end field: a day and a duration only', () => {
    renderDialog()
    expect(screen.queryByLabelText(/start|end|from|to\b/i)).toBeNull()
    expect(document.querySelectorAll('input[type="time"], input[type="datetime-local"]')).toHaveLength(0)
    expect(dialogControls()).toEqual(['date', 'select', 'radio', 'radio', 'radio', 'radio', 'textarea'])
  })

  it('preselects nothing in "What was it on": four choices, none of them checked, and the field is required', () => {
    renderDialog()
    const radios = within(onGroup()).getAllByRole('radio')
    expect(radios.map((radio) => radio.closest('label')?.textContent)).toEqual([
      f.on.options.project,
      f.on.options.deal,
      f.on.options.meeting,
      f.on.options.none,
    ])
    expect(radios.some((radio) => (radio as HTMLInputElement).checked)).toBe(false)
    expect(onGroup().getAttribute('aria-required')).toBe('true')
  })
})

/** The kinds of control the dialog holds, in DOM order (no hidden or button inputs). */
const dialogControls = () =>
  [...screen.getByRole('dialog').querySelectorAll('input, select, textarea')].map((control) =>
    control instanceof HTMLInputElement ? control.type : control.tagName.toLowerCase(),
  )

describe('the fields that apply to what it was on (AC-2.1, AC-3.5; design S2 matrix)', () => {
  it('nothing but Day, Duration, What was it on and the note before a choice is made', () => {
    renderDialog()
    expect(maybe(f.project.label)).toBeNull()
    expect(maybe(f.deal.label)).toBeNull()
    expect(maybe(f.meeting.label)).toBeNull()
    expect(maybe(f.category.label)).toBeNull()
    expect(maybe(f.workType.label)).toBeNull()
    expect(maybe(strings.activity.label)).toBeNull()
    expect(noteField()).not.toBeNull()
  })

  it('Project: its picker, the PROJECT work types, the activity field and the note; no category', async () => {
    renderDialog()
    await chooseKind(f.on.options.project)
    expect(screen.getByRole('combobox', { name: f.project.label })).not.toBeNull()
    expect(optionTexts(select(f.workType.label))).toEqual([f.workType.none, 'Development', 'Analysis'])
    expect(select(strings.activity.label)).not.toBeNull()
    expect(noteField()).not.toBeNull()
    expect(maybe(f.category.label)).toBeNull()
    expect(maybe(f.deal.label)).toBeNull()
    expect(maybe(f.meeting.label)).toBeNull()
  })

  it('Deal: its picker, the DEAL work types, the activity field and the note; no category', async () => {
    renderDialog()
    await chooseKind(f.on.options.deal)
    expect(screen.getByRole('combobox', { name: f.deal.label })).not.toBeNull()
    expect(optionTexts(select(f.workType.label))).toEqual([f.workType.none, 'Analysis', 'Demo'])
    expect(select(strings.activity.label)).not.toBeNull()
    expect(maybe(f.category.label)).toBeNull()
    expect(maybe(f.project.label)).toBeNull()
  })

  it('Meeting: its picker and the note, and no work type, no activity, no category', async () => {
    renderDialog()
    await chooseKind(f.on.options.meeting)
    expect(screen.getByRole('combobox', { name: f.meeting.label })).not.toBeNull()
    expect(noteField()).not.toBeNull()
    expect(maybe(f.workType.label)).toBeNull()
    expect(maybe(strings.activity.label)).toBeNull()
    expect(maybe(f.category.label)).toBeNull()
  })

  it('Other work: the category and the note, and no picker, no work type, no activity', async () => {
    renderDialog()
    await chooseKind(f.on.options.none)
    expect(select(f.category.label)).not.toBeNull()
    expect(noteField()).not.toBeNull()
    expect(maybe(f.project.label)).toBeNull()
    expect(maybe(f.deal.label)).toBeNull()
    expect(maybe(f.meeting.label)).toBeNull()
    expect(maybe(f.workType.label)).toBeNull()
    expect(maybe(strings.activity.label)).toBeNull()
  })

  it('offers only categories and work types that are not retired (AC-3.4)', async () => {
    renderDialog()
    await chooseKind(f.on.options.none)
    expect(optionTexts(select(f.category.label))).toEqual(['Formazione', 'Administration', 'Other'])
    await chooseKind(f.on.options.project)
    expect(optionTexts(select(f.workType.label))).not.toContain('Legacy support')
    await chooseKind(f.on.options.deal)
    expect(optionTexts(select(f.workType.label))).toEqual([f.workType.none, 'Analysis', 'Demo'])
  })
})

describe('changing what it was on (design S2: "changing the radio clears …")', () => {
  it('clears the entity, category, work type and activity, and keeps the day, the duration and the note', async () => {
    useApi({ 'GET /activities': () => activitiesAnswer(projectTasks) })
    renderDialog()
    fireEvent.change(dayField(), { target: { value: '2026-11-10' } })
    await userEvent.selectOptions(durationField(), '90')
    await userEvent.type(noteField(), 'Prepared the workshop')

    await chooseKind(f.on.options.project)
    await pickProject()
    await userEvent.selectOptions(select(f.workType.label), 'Development')
    await waitFor(() => expect(optionTexts(select(strings.activity.label))).toContain('Task · Write the offer'))
    await userEvent.selectOptions(select(strings.activity.label), 'Task · Write the offer')

    await chooseKind(f.on.options.none)
    await userEvent.selectOptions(select(f.category.label), 'Formazione')
    expect(maybe(f.project.label)).toBeNull()

    await chooseKind(f.on.options.project)
    // Nothing of the first choice survived the round trip.
    expect((screen.getByRole('combobox', { name: f.project.label }) as HTMLInputElement).value).toBe('')
    expect(select(f.workType.label).value).toBe('')
    expect(select(strings.activity.label).value).toBe('')
    expect(screen.getByText(strings.activity.chooseFirst.project)).not.toBeNull()
    await chooseKind(f.on.options.none)
    expect(select(f.category.label).value).toBe('')

    // And the three things that do not depend on it stayed.
    expect(dayField().value).toBe('2026-11-10')
    expect(durationField().value).toBe('90')
    expect(noteField().value).toBe('Prepared the workshop')
  })

  it('drops text typed into a picker and never picked when the choice changes', async () => {
    renderDialog()
    await chooseKind(f.on.options.project)
    await userEvent.type(screen.getByRole('combobox', { name: f.project.label }), 'half typ')
    await chooseKind(f.on.options.deal)
    await chooseKind(f.on.options.project)
    expect((screen.getByRole('combobox', { name: f.project.label }) as HTMLInputElement).value).toBe('')
  })
})

describe('the pickers (AC-2.2, AC-2.3, AC-2.5; plan § Components `hours-ui` "Target pickers")', () => {
  it('each states the rule for what it offers, and is required', async () => {
    renderDialog()
    await chooseKind(f.on.options.project)
    const project = screen.getByRole('combobox', { name: f.project.label })
    expect(project.getAttribute('aria-required')).toBe('true')
    expect(project.getAttribute('aria-describedby')).not.toBeNull()
    expect(screen.getByText(f.project.hint)).not.toBeNull()
    await chooseKind(f.on.options.deal)
    expect(screen.getByText(f.deal.hint)).not.toBeNull()
    await chooseKind(f.on.options.meeting)
    expect(screen.getByText(f.meeting.hint)).not.toBeNull()
  })

  it('the meeting picker searches meetings-api GET /meetings?q= as the person, and picks by title', async () => {
    renderDialog()
    await chooseKind(f.on.options.meeting)
    await userEvent.type(screen.getByRole('combobox', { name: f.meeting.label }), 'kick')

    const option = await screen.findByRole('option', { name: /Kick-off with Acme/ })
    expect(option.textContent).toContain('03.11.2026')
    await waitFor(() =>
      expect(requests(apiFetch, 'GET /meetings').map((request) => [request.origin, request.query])).toContainEqual([
        ORIGINS.meetings,
        { q: 'kick' },
      ]),
    )
    await userEvent.click(option)
    expect((screen.getByRole('combobox', { name: f.meeting.label }) as HTMLInputElement).value).toBe(
      'Kick-off with Acme',
    )
  })

  it('the project and deal pickers search projects-api and crm-api', async () => {
    renderDialog()
    await chooseKind(f.on.options.project)
    await pickProject()
    await chooseKind(f.on.options.deal)
    await pickDeal()
    const asked = requests(apiFetch).filter((request) => request.method === 'GET' && request.path !== '/activities')
    expect(asked.map((request) => request.origin)).toEqual([ORIGINS.projects, ORIGINS.crm])
  })

  it('says why a picker is empty: no match, not allowed to search, or the search is down', async () => {
    useApi({
      'GET /projects': () => ({ status: 200, body: { items: [], total: 0, page: 1, pageSize: 25 } }),
      'GET /deals': () => refusal(403, 'forbidden'),
      'GET /meetings': () => refusal(503, 'host_unavailable'),
    })
    renderDialog()
    await chooseKind(f.on.options.project)
    await userEvent.type(screen.getByRole('combobox', { name: f.project.label }), 'zzz')
    expect((await screen.findAllByText(f.project.messages.noMatch)).length).toBeGreaterThan(0)
    await chooseKind(f.on.options.deal)
    await userEvent.type(screen.getByRole('combobox', { name: f.deal.label }), 'a')
    expect((await screen.findAllByText(f.deal.messages.forbidden)).length).toBeGreaterThan(0)
    await chooseKind(f.on.options.meeting)
    await userEvent.type(screen.getByRole('combobox', { name: f.meeting.label }), 'a')
    expect((await screen.findAllByText(f.meeting.messages.unavailable)).length).toBeGreaterThan(0)
  })
})

describe('the activity field (AC-2.7; design S2 "Activity field")', () => {
  const activityRequests = () => requests(apiFetch, 'GET /activities')
  const activity = () => select(strings.activity.label)

  it('waits for a project: disabled, and it says to choose one first; nothing is read', async () => {
    renderDialog()
    await chooseKind(f.on.options.project)
    expect(activity().getAttribute('aria-disabled')).toBe('true')
    expect(screen.getByText(strings.activity.chooseFirst.project)).not.toBeNull()
    expect(activityRequests()).toHaveLength(0)
  })

  it('a picked project feeds it: its activities are read from activities-api as the person', async () => {
    useApi({ 'GET /activities': () => activitiesAnswer(projectTasks) })
    renderDialog()
    await chooseKind(f.on.options.project)
    await pickProject()

    await waitFor(() => expect(activity().getAttribute('aria-disabled')).toBeNull())
    expect(optionTexts(activity())).toEqual([
      strings.activity.none,
      'Task · Write the offer',
      'Task · Review the design',
    ])
    expect(activityRequests()).toHaveLength(1)
    expect(activityRequests()[0]).toMatchObject({ origin: ORIGINS.activities, query: { projectId: 'p1' } })
  })

  it('a picked deal feeds it with the deal’s activities', async () => {
    useApi({ 'GET /activities': () => activitiesAnswer(dealActivities) })
    renderDialog()
    await chooseKind(f.on.options.deal)
    await pickDeal()
    await waitFor(() => expect(activity().getAttribute('aria-disabled')).toBeNull())
    expect(optionTexts(activity())).toContain('Call · Call Acme about the renewal')
    expect(activityRequests()[0]!.query).toMatchObject({ dealId: 'd1' })
  })

  it('changing the entity clears the activity, and the new entity’s are read', async () => {
    useApi({ 'GET /activities': () => activitiesAnswer(projectTasks) })
    renderDialog()
    await chooseKind(f.on.options.project)
    await pickProject()
    await waitFor(() => expect(activity().getAttribute('aria-disabled')).toBeNull())
    await userEvent.selectOptions(activity(), 'Task · Write the offer')
    expect(activity().value).toBe('a-offer')

    // Typing after a pick un-picks it: the activity belongs to the old project.
    await userEvent.type(screen.getByRole('combobox', { name: f.project.label }), 'x')
    expect(activity().value).toBe('')
    expect(activity().getAttribute('aria-disabled')).toBe('true')
    expect(screen.getByText(strings.activity.chooseFirst.project)).not.toBeNull()

    // A different project: it starts again from "No activity".
    await userEvent.clear(screen.getByRole('combobox', { name: f.project.label }))
    await userEvent.type(screen.getByRole('combobox', { name: f.project.label }), 'beta')
    await userEvent.click(await screen.findByRole('option', { name: /Project Beta/ }))
    await waitFor(() => expect(activity().getAttribute('aria-disabled')).toBeNull())
    expect(activity().value).toBe('')
    expect(activityRequests().at(-1)!.query).toMatchObject({ projectId: 'p2' })
  })

  it.each([
    ['loading', () => new Promise<never>(() => {})],
    ['failed', () => refusal(404, 'not_found')],
  ] as const)('Save stays enabled while the activity field is %s', async (_state, handler) => {
    useApi({ 'GET /activities': handler as FakeHandler })
    renderDialog()
    await chooseKind(f.on.options.project)
    await pickProject()
    await waitFor(() => expect(activity().getAttribute('aria-disabled')).toBe('true'))
    expect(submitButton().hasAttribute('disabled')).toBe(false)
    expect(submitButton().getAttribute('aria-disabled')).toBeNull()
  })

  it('Save stays enabled before a project is chosen and once the activities are loaded', async () => {
    useApi({ 'GET /activities': () => activitiesAnswer(projectTasks) })
    renderDialog()
    await chooseKind(f.on.options.project)
    expect(submitButton().hasAttribute('disabled')).toBe(false)
    await pickProject()
    await waitFor(() => expect(activity().getAttribute('aria-disabled')).toBeNull())
    expect(submitButton().hasAttribute('disabled')).toBe(false)
  })
})

// ─── Recording an entry ─────────────────────────────────────────────────────

/** What a field is described by: the text of every element its `aria-describedby` names. */
const describedBy = (control: HTMLElement) =>
  (control.getAttribute('aria-describedby') ?? '')
    .split(' ')
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent ?? '')
    .join(' ')

const save = () => userEvent.click(submitButton())

/** A project entry filled as a person would, one field after the other. */
const fillProjectEntry = async () => {
  fireEvent.change(dayField(), { target: { value: '2026-11-12' } })
  await userEvent.selectOptions(durationField(), '150')
  await chooseKind(f.on.options.project)
  await pickProject()
  await userEvent.selectOptions(select(f.workType.label), 'Development')
  await userEvent.type(noteField(), 'Prepared the workshop')
}

const refusedWith = (status: number, rawCode: string | null) =>
  new HoursApiError({ status, title: `Problem ${status}`, rawCode })

describe('the client rules (AC-1.2, AC-1.3, AC-1.7, AC-2.1, AC-3.6): nothing is sent while one is broken', () => {
  it('an empty form asks for the duration and for what it was on, and focus goes to the first of them', async () => {
    renderDialog()
    await save()

    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByText(e.errors.durationRequired)).not.toBeNull()
    expect(screen.getByText(e.errors.onRequired)).not.toBeNull()
    expect(durationField().getAttribute('aria-invalid')).toBe('true')
    expect(describedBy(durationField())).toContain(e.errors.durationRequired)
    expect(onGroup().getAttribute('aria-invalid')).toBe('true')
    expect(document.activeElement).toBe(durationField())
    // The day was filled in, so it is not blamed.
    expect(dayField().getAttribute('aria-invalid')).toBeNull()
  })

  it('a project, deal or meeting that was not picked from the list is an error on its picker', async () => {
    renderDialog()
    await userEvent.selectOptions(durationField(), '60')
    for (const [label, picker, message] of [
      [f.on.options.project, f.project.label, e.errors.projectRequired],
      [f.on.options.deal, f.deal.label, e.errors.dealRequired],
      [f.on.options.meeting, f.meeting.label, e.errors.meetingRequired],
    ] as const) {
      await chooseKind(label)
      // Half-typed text is not a pick.
      await userEvent.type(screen.getByRole('combobox', { name: picker }), 'Proj')
      await save()
      expect(screen.getByText(message)).not.toBeNull()
      expect(screen.getByRole('combobox', { name: picker }).getAttribute('aria-invalid')).toBe('true')
      expect(document.activeElement).toBe(screen.getByRole('combobox', { name: picker }))
    }
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('focus moves to a picker that needs attention WITHOUT opening its list over the error that is under it', async () => {
    renderDialog()
    await userEvent.selectOptions(durationField(), '60')
    await chooseKind(f.on.options.project)
    await save()

    const picker = screen.getByRole('combobox', { name: f.project.label })
    expect(document.activeElement).toBe(picker)
    expect(picker.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(describedBy(picker)).toContain(e.errors.projectRequired)
    // The picker is as usable as ever, one frame later: typing opens the list, and picking clears the error.
    await waitFor(() => expect(picker.getAttribute('aria-disabled')).toBeNull())
    expect((picker as HTMLInputElement).readOnly).toBe(false)
    await userEvent.type(picker, 'a')
    await userEvent.click(await screen.findByRole('option', { name: /Project Alpha/ }))
    expect(screen.queryByText(e.errors.projectRequired)).toBeNull()
    expect(picker.getAttribute('aria-disabled')).toBeNull()
    expect((picker as HTMLInputElement).readOnly).toBe(false)
  })

  it('the same after a refusal on the picker: focused, list closed, the refusal readable', async () => {
    onSubmit.mockRejectedValueOnce(refusedWith(403, 'not_on_project'))
    renderDialog()
    await userEvent.selectOptions(durationField(), '60')
    await chooseKind(f.on.options.project)
    await pickProject()
    // The person was last in the note, so the picker has to be given focus (it keeps it, if it had it).
    await userEvent.type(noteField(), 'Workshop')
    await save()

    const picker = await screen.findByRole('combobox', { name: f.project.label })
    await waitFor(() => expect(describedBy(picker)).toContain(e.errors.notOnProject))
    // Give a late open every chance to show: the picker's own asks run after a debounce.
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(document.activeElement).toBe(picker)
    expect(picker.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('other work without a category is an error on the category', async () => {
    renderDialog()
    await userEvent.selectOptions(durationField(), '60')
    await chooseKind(f.on.options.none)
    await save()
    expect(screen.getByText(e.errors.categoryRequired)).not.toBeNull()
    expect(select(f.category.label).getAttribute('aria-invalid')).toBe('true')
    expect(document.activeElement).toBe(select(f.category.label))
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('a day after today (Zurich) is refused, on leaving the field and on Save; an empty day is asked for', async () => {
    renderDialog()
    await userEvent.selectOptions(durationField(), '60')
    await chooseKind(f.on.options.none)
    await userEvent.selectOptions(select(f.category.label), 'Formazione')

    fireEvent.change(dayField(), { target: { value: '2026-11-14' } })
    expect(screen.queryByText(e.errors.dayFuture)).toBeNull()
    fireEvent.blur(dayField())
    expect(screen.getByText(e.errors.dayFuture)).not.toBeNull()
    expect(dayField().getAttribute('aria-invalid')).toBe('true')

    // Fixing it clears the error as soon as the value is right.
    fireEvent.change(dayField(), { target: { value: '2026-11-13' } })
    expect(screen.queryByText(e.errors.dayFuture)).toBeNull()

    fireEvent.change(dayField(), { target: { value: '' } })
    await save()
    expect(screen.getByText(e.errors.dayRequired)).not.toBeNull()
    expect(document.activeElement).toBe(dayField())
    fireEvent.change(dayField(), { target: { value: '2026-11-20' } })
    await save()
    expect(screen.getByText(e.errors.dayFuture)).not.toBeNull()
    expect(onSubmit).not.toHaveBeenCalled()
  })
})

describe('the Day (plan § Entries "A day", amendment 4 of 2026-11-13)', () => {
  const FLOOR_TEXT = e.errors.dayTooEarly('01.01.2000')

  const readyForSave = async () => {
    await userEvent.selectOptions(durationField(), '60')
    await chooseKind(f.on.options.none)
    await userEvent.selectOptions(select(f.category.label), 'Formazione')
  }

  it('offers no day before 01.01.2000 to the browser’s own picker', () => {
    renderDialog()
    expect(dayField().min).toBe('2000-01-01')
    expect(dayField().max).toBe(TODAY)
  })

  it('a day before 01.01.2000 is a Day field error, on leaving the field and on Save, and nothing is sent', async () => {
    renderDialog()
    await readyForSave()

    fireEvent.change(dayField(), { target: { value: '1999-12-31' } })
    fireEvent.blur(dayField())
    expect(screen.getByText(FLOOR_TEXT)).not.toBeNull()
    expect(dayField().getAttribute('aria-invalid')).toBe('true')
    expect(describedBy(dayField())).toContain(FLOOR_TEXT)

    await save()
    expect(onSubmit).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(dayField())

    // A mistyped year (0226 for 2026) is the same mistake.
    fireEvent.change(dayField(), { target: { value: '0226-11-13' } })
    await save()
    expect(screen.getByText(FLOOR_TEXT)).not.toBeNull()
    expect(onSubmit).not.toHaveBeenCalled()

    // The first day the product takes is taken.
    fireEvent.change(dayField(), { target: { value: '2000-01-01' } })
    expect(screen.queryByText(FLOOR_TEXT)).toBeNull()
    await save()
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit.mock.calls[0]![0].day).toBe('2000-01-01')
  })

  it('a date that is not on the calendar (30.02.2026) is a Day field error, and nothing is sent', async () => {
    renderDialog()
    await readyForSave()
    // A date field holds nothing for a day the calendar does not have, which reads as "choose a day".
    fireEvent.change(dayField(), { target: { value: '2026-02-30' } })
    expect(dayField().value).toBe('')
    await save()

    expect(onSubmit).not.toHaveBeenCalled()
    expect(dayField().getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByText(e.errors.dayRequired)).not.toBeNull()
    expect(document.activeElement).toBe(dayField())
  })
})

describe('the note (AC-1.7, AC-3.6; plan § Entries "Counting a note", "A blank note")', () => {
  it('counts "n of 1000" as the person types', async () => {
    renderDialog()
    expect(screen.getByText('0 of 1000')).not.toBeNull()
    await userEvent.type(noteField(), 'Hello')
    expect(screen.getByText('5 of 1000')).not.toBeNull()
  })

  it('counts code points, not UTF-16 units: 1000 emoji is "1000 of 1000" with no error, and is sent', async () => {
    renderDialog()
    await userEvent.selectOptions(durationField(), '60')
    await chooseKind(f.on.options.none)
    await userEvent.selectOptions(select(f.category.label), 'Formazione')
    fireEvent.change(noteField(), { target: { value: emoji(1000) } })
    fireEvent.blur(noteField())

    expect(screen.getByText('1000 of 1000')).not.toBeNull()
    expect(screen.queryByText(e.errors.noteTooLong)).toBeNull()
    expect(noteField().getAttribute('aria-invalid')).toBeNull()
    await save()
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit.mock.calls[0]![0].note).toBe(emoji(1000))
  })

  it('1001 code points is a field error, shown on leaving the field and on Save, and nothing is sent', async () => {
    renderDialog()
    await userEvent.selectOptions(durationField(), '60')
    await chooseKind(f.on.options.none)
    await userEvent.selectOptions(select(f.category.label), 'Formazione')
    fireEvent.change(noteField(), { target: { value: emoji(1001) } })
    expect(screen.getByText('1001 of 1000')).not.toBeNull()
    fireEvent.blur(noteField())
    expect(screen.getByText(e.errors.noteTooLong)).not.toBeNull()
    expect(noteField().getAttribute('aria-invalid')).toBe('true')
    expect(describedBy(noteField())).toContain(e.errors.noteTooLong)

    await save()
    expect(onSubmit).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(noteField())

    // Back under the limit, the error goes.
    fireEvent.change(noteField(), { target: { value: emoji(1000) } })
    expect(screen.queryByText(e.errors.noteTooLong)).toBeNull()
  })

  it('a category that requires a note makes the note required, and says so', async () => {
    renderDialog()
    expect(noteField().getAttribute('aria-required')).toBeNull()
    await chooseKind(f.on.options.none)
    await userEvent.selectOptions(select(f.category.label), 'Formazione')
    expect(noteField().getAttribute('aria-required')).toBeNull()
    expect(screen.queryByText(f.note.needed)).toBeNull()

    await userEvent.selectOptions(select(f.category.label), 'Other')
    expect(noteField().getAttribute('aria-required')).toBe('true')
    expect(screen.getByText(f.note.needed)).not.toBeNull()
    expect(screen.getByText('0 of 1000')).not.toBeNull()
    expect(noteField().closest('.field')?.querySelector('.field-required')).not.toBeNull()
  })

  it('a note that is required and blank — empty, or only spaces — is the required-note error, and nothing is sent', async () => {
    renderDialog()
    await userEvent.selectOptions(durationField(), '60')
    await chooseKind(f.on.options.none)
    await userEvent.selectOptions(select(f.category.label), 'Other')

    await save()
    expect(screen.getByText(e.errors.noteRequired)).not.toBeNull()
    expect(document.activeElement).toBe(noteField())

    fireEvent.change(noteField(), { target: { value: ' \t\n  ' } })
    await save()
    expect(screen.getByText(e.errors.noteRequired)).not.toBeNull()
    expect(onSubmit).not.toHaveBeenCalled()

    await userEvent.type(noteField(), 'Internal workshop')
    expect(screen.queryByText(e.errors.noteRequired)).toBeNull()
    await save()
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it('a note on a category that does not require one may be blank, and a blank one is not sent at all', async () => {
    renderDialog()
    await userEvent.selectOptions(durationField(), '60')
    await chooseKind(f.on.options.none)
    await userEvent.selectOptions(select(f.category.label), 'Formazione')
    fireEvent.change(noteField(), { target: { value: '   ' } })
    await save()
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit.mock.calls[0]![0]).not.toHaveProperty('note')
  })

  it('a note is sent exactly as typed, not trimmed (AC-4.6)', async () => {
    renderDialog()
    await userEvent.selectOptions(durationField(), '60')
    await chooseKind(f.on.options.none)
    await userEvent.selectOptions(select(f.category.label), 'Formazione')
    fireEvent.change(noteField(), { target: { value: '  two  lines\nof text ' } })
    await save()
    expect(onSubmit.mock.calls[0]![0].note).toBe('  two  lines\nof text ')
  })
})

describe('what is sent (plan § Entries: POST /time-entries)', () => {
  it('a project entry: day, minutes, the project, the work type, the activity and the note', async () => {
    useApi({ 'GET /activities': () => activitiesAnswer(projectTasks) })
    renderDialog()
    await fillProjectEntry()
    await waitFor(() => expect(select(strings.activity.label).getAttribute('aria-disabled')).toBeNull())
    await userEvent.selectOptions(select(strings.activity.label), 'Task · Write the offer')
    await save()

    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit.mock.calls[0]![0]).toEqual({
      day: '2026-11-12',
      minutes: 150,
      on: { type: 'project', id: 'p1' },
      workTypeId: 'wt-p-dev',
      activityId: 'a-offer',
      note: 'Prepared the workshop',
    })
  })

  it('a deal entry with nothing optional sends no work type, activity or note', async () => {
    renderDialog()
    await userEvent.selectOptions(durationField(), '30')
    await chooseKind(f.on.options.deal)
    await pickDeal()
    await save()
    expect(onSubmit.mock.calls[0]![0]).toEqual({ day: TODAY, minutes: 30, on: { type: 'deal', id: 'd1' } })
  })

  it('a meeting entry', async () => {
    renderDialog()
    await userEvent.selectOptions(durationField(), '1440')
    await chooseKind(f.on.options.meeting)
    await pickMeeting()
    await save()
    expect(onSubmit.mock.calls[0]![0]).toEqual({ day: TODAY, minutes: 1440, on: { type: 'meeting', id: 'm1' } })
  })

  it('other work: its category', async () => {
    renderDialog()
    await userEvent.selectOptions(durationField(), '240')
    await chooseKind(f.on.options.none)
    await userEvent.selectOptions(select(f.category.label), 'Formazione')
    await save()
    expect(onSubmit.mock.calls[0]![0]).toEqual({
      day: TODAY,
      minutes: 240,
      on: { type: 'none', categoryId: 'tc-formazione' },
    })
  })

  it('never sends a work type or an activity after the choice moved to a meeting, or a category after a project', async () => {
    renderDialog()
    await userEvent.selectOptions(durationField(), '60')
    await chooseKind(f.on.options.none)
    await userEvent.selectOptions(select(f.category.label), 'Formazione')
    await chooseKind(f.on.options.project)
    await pickProject()
    await userEvent.selectOptions(select(f.workType.label), 'Development')
    await chooseKind(f.on.options.meeting)
    await pickMeeting()
    await save()
    expect(onSubmit.mock.calls[0]![0]).toEqual({ day: TODAY, minutes: 60, on: { type: 'meeting', id: 'm1' } })
  })

  it('has no way to send a person, a start or an end (AC-1.6, AC-1.8): the body holds only the plan’s members', async () => {
    renderDialog()
    await userEvent.selectOptions(durationField(), '60')
    await chooseKind(f.on.options.none)
    await userEvent.selectOptions(select(f.category.label), 'Formazione')
    await save()
    expect(Object.keys(onSubmit.mock.calls[0]![0]).sort()).toEqual(['day', 'minutes', 'on'])
  })
})

describe('saving (design S2: not dismissible while saving)', () => {
  it('locks the dialog while the request runs and sends once, however many times Save is pressed', async () => {
    const answer = deferred<void>()
    onSubmit.mockReturnValue(answer.promise)
    renderDialog()
    await userEvent.selectOptions(durationField(), '60')
    await chooseKind(f.on.options.project)
    await pickProject()
    await save()
    // The button now reads "Saving…"; pressing it again (and Enter in a field) sends nothing more.
    await userEvent.click(screen.getByRole('button', { name: e.dialog.saving }))
    fireEvent.submit(durationField().closest('form')!)

    expect(onSubmit).toHaveBeenCalledTimes(1)
    const saving = screen.getByRole('button', { name: e.dialog.saving })
    expect(saving.getAttribute('aria-busy')).toBe('true')
    expect(screen.getByRole('button', { name: strings.common.cancel }).hasAttribute('disabled')).toBe(true)
    expect(durationField().closest('fieldset')?.disabled).toBe(true)
    // The picker takes no input (it is read-only and aria-disabled, and its fieldset is disabled too).
    const picker = screen.getByRole('combobox', { name: f.project.label }) as HTMLInputElement
    expect(picker.getAttribute('aria-disabled')).toBe('true')
    expect(picker.readOnly).toBe(true)

    // Not dismissible: Escape and the × do nothing.
    await userEvent.keyboard('{Escape}')
    expect(onCancel).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: strings.common.close }).hasAttribute('disabled')).toBe(true)
    answer.resolve()
  })

  it('Cancel, the × and Escape close it when nothing is running', async () => {
    renderDialog()
    await userEvent.click(screen.getByRole('button', { name: strings.common.cancel }))
    await userEvent.click(screen.getByRole('button', { name: strings.common.close }))
    await userEvent.keyboard('{Escape}')
    expect(onCancel).toHaveBeenCalledTimes(3)
  })
})

describe('what hours-api refuses (design S2 "Error surfaces"; AC-2.2, AC-2.3, AC-2.7, AC-2.10, AC-2.11)', () => {
  /** Fills a project entry, makes the save fail with `error`, presses Save. */
  const failWith = async (error: unknown) => {
    onSubmit.mockRejectedValueOnce(error)
    renderDialog()
    await fillProjectEntry()
    await save()
    await waitFor(() => expect(screen.getByRole('button', { name: e.dialog.save })).not.toBeNull())
  }

  const valuesSurvived = () => {
    expect(dayField().value).toBe('2026-11-12')
    expect(durationField().value).toBe('150')
    expect(kind(f.on.options.project).checked).toBe(true)
    expect((screen.getByRole('combobox', { name: f.project.label }) as HTMLInputElement).value).toBe('Project Alpha')
    expect(select(f.workType.label).value).toBe('wt-p-dev')
    expect(noteField().value).toBe('Prepared the workshop')
  }

  it('not_on_project is on the project picker, in words about the team, and every typed value survives', async () => {
    await failWith(refusedWith(403, 'not_on_project'))
    const picker = screen.getByRole('combobox', { name: f.project.label })
    expect(screen.getByText(e.errors.notOnProject)).not.toBeNull()
    expect(picker.getAttribute('aria-invalid')).toBe('true')
    expect(describedBy(picker)).toContain(e.errors.notOnProject)
    expect(document.activeElement).toBe(picker)
    valuesSurvived()
    expect(screen.queryByText(e.errors.generic)).toBeNull()
  })

  it('not_involved_in_deal is on the deal picker', async () => {
    onSubmit.mockRejectedValueOnce(refusedWith(403, 'not_involved_in_deal'))
    renderDialog()
    await userEvent.selectOptions(durationField(), '60')
    await chooseKind(f.on.options.deal)
    await pickDeal()
    await save()
    const picker = await screen.findByRole('combobox', { name: f.deal.label })
    await waitFor(() => expect(picker.getAttribute('aria-invalid')).toBe('true'))
    expect(describedBy(picker)).toContain(e.errors.notInvolvedInDeal)
    expect((picker as HTMLInputElement).value).toBe('Acme renewal')
  })

  it.each([
    ['project', f.on.options.project, f.project.label, e.errors.targetGone.project],
    ['deal', f.on.options.deal, f.deal.label, e.errors.targetGone.deal],
    ['meeting', f.on.options.meeting, f.meeting.label, e.errors.targetGone.meeting],
  ] as const)(
    'a 404 on a %s is on its picker, with words that do not say whether it is missing or unreadable (AC-2.10)',
    async (_name, radio, picker, message) => {
      onSubmit.mockRejectedValueOnce(refusedWith(404, 'not_found'))
      renderDialog()
      await userEvent.selectOptions(durationField(), '60')
      await chooseKind(radio)
      await pick(picker, /Project Alpha|Acme renewal|Kick-off with Acme/)
      await save()
      const input = await screen.findByRole('combobox', { name: picker })
      await waitFor(() => expect(describedBy(input)).toContain(message))
      expect(message).not.toMatch(/exist|delet|permission|allowed to (see|read)|not found|missing/i)
      expect(input.getAttribute('aria-invalid')).toBe('true')
    },
  )

  it('activity_not_allowed is on the Activity field, which keeps the chosen activity', async () => {
    useApi({ 'GET /activities': () => activitiesAnswer(projectTasks) })
    onSubmit.mockRejectedValueOnce(refusedWith(422, 'activity_not_allowed'))
    renderDialog()
    await fillProjectEntry()
    await waitFor(() => expect(select(strings.activity.label).getAttribute('aria-disabled')).toBeNull())
    await userEvent.selectOptions(select(strings.activity.label), 'Task · Review the design')
    await save()

    await waitFor(() =>
      expect(describedBy(select(strings.activity.label))).toContain(e.errors.activityNotAllowed.project),
    )
    expect(select(strings.activity.label).getAttribute('aria-invalid')).toBe('true')
    expect(select(strings.activity.label).value).toBe('a-review')
    expect(document.activeElement).toBe(select(strings.activity.label))
    valuesSurvived()
  })

  it('host_unavailable fails closed: an alert saying nothing was saved, no field blamed, Save again retries', async () => {
    onSubmit.mockRejectedValueOnce(refusedWith(503, 'host_unavailable'))
    renderDialog()
    await fillProjectEntry()
    await save()

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe(e.errors.hostUnavailable.project)
    expect(alert.className).toContain('form-error')
    expect(alert.textContent).toMatch(/Nothing was saved/)
    expect(document.querySelectorAll('[aria-invalid="true"]')).toHaveLength(0)
    valuesSurvived()

    await save()
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(onSubmit.mock.calls[1]![0]).toEqual(onSubmit.mock.calls[0]![0])
  })

  it.each([
    [f.on.options.deal, e.errors.hostUnavailable.deal],
    [f.on.options.meeting, e.errors.hostUnavailable.meeting],
  ] as const)('host_unavailable on a %s names it', async (radio, message) => {
    onSubmit.mockRejectedValueOnce(refusedWith(503, 'host_unavailable'))
    renderDialog()
    await userEvent.selectOptions(durationField(), '60')
    await chooseKind(radio)
    await (radio === f.on.options.deal ? pickDeal() : pickMeeting())
    await save()
    expect((await screen.findByRole('alert')).textContent).toBe(message)
  })

  it.each([
    ['invalid_minutes', 'minutes', e.errors.durationRequired],
    ['future_day', 'day', e.errors.dayFuture],
    ['note_too_long', 'note', e.errors.noteTooLong],
    ['note_required', 'note', e.errors.noteRequired],
  ] as const)('%s is on its own field, in the same words as the client rule', async (code, field, message) => {
    await failWith(refusedWith(422, code))
    const control = field === 'minutes' ? durationField() : field === 'day' ? dayField() : noteField()
    expect(describedBy(control)).toContain(message)
    expect(control.getAttribute('aria-invalid')).toBe('true')
    expect(document.activeElement).toBe(control)
    valuesSurvived()
  })

  it.each(['work_type_retired', 'work_type_not_found', 'work_type_not_allowed'])(
    '%s is on the work type: "no longer available — choose another", and the lists are read again',
    async (code) => {
      await failWith(refusedWith(422, code))
      expect(describedBy(select(f.workType.label))).toContain(e.errors.noLongerAvailable)
      expect(onReloadLists).toHaveBeenCalledTimes(1)
    },
  )

  it.each(['category_retired', 'category_not_found'])(
    '%s is on the category, and the lists are read again',
    async (code) => {
      onSubmit.mockRejectedValueOnce(refusedWith(422, code))
      renderDialog()
      await userEvent.selectOptions(durationField(), '60')
      await chooseKind(f.on.options.none)
      await userEvent.selectOptions(select(f.category.label), 'Formazione')
      await save()
      await waitFor(() => expect(describedBy(select(f.category.label))).toContain(e.errors.noLongerAvailable))
      expect(onReloadLists).toHaveBeenCalledTimes(1)
    },
  )

  it.each([
    ['a 400 invalid_request', refusedWith(400, 'invalid_request')],
    ['a code this build does not know', refusedWith(422, 'brand_new_code')],
    ['an answer with no code', refusedWith(500, null)],
    ['a network failure', new TypeError('Failed to fetch')],
  ] as const)('%s is the generic alert, and nothing else is blamed', async (_name, error) => {
    await failWith(error)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe(e.errors.generic)
    expect(document.querySelectorAll('[aria-invalid="true"]')).toHaveLength(0)
    valuesSurvived()
  })

  it('a refusal on a field goes away when that field changes, and a new Save clears the old alert', async () => {
    await failWith(refusedWith(403, 'not_on_project'))
    // The picker takes input again one frame after focus was moved to it.
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: f.project.label }).getAttribute('aria-disabled')).toBeNull(),
    )
    await userEvent.type(screen.getByRole('combobox', { name: f.project.label }), 'x')
    expect(screen.queryByText(e.errors.notOnProject)).toBeNull()

    onSubmit.mockRejectedValueOnce(refusedWith(503, 'host_unavailable'))
    await userEvent.clear(screen.getByRole('combobox', { name: f.project.label }))
    await pickProject()
    await save()
    expect(await screen.findByRole('alert')).not.toBeNull()
    onSubmit.mockResolvedValueOnce(undefined)
    await save()
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })
})

describe('the lists (AC-3.4, design S2 "Category", "Work type")', () => {
  it('while they load: the category and work type cannot be filled, and say so; the entity fields still work', async () => {
    renderDialog({ lists: { status: 'loading' } })
    await chooseKind(f.on.options.none)
    expect(select(f.category.label).getAttribute('aria-disabled')).toBe('true')
    expect(screen.getByText(f.category.loading)).not.toBeNull()
    await chooseKind(f.on.options.project)
    expect(select(f.workType.label).getAttribute('aria-disabled')).toBe('true')
    expect(screen.getByText(f.workType.loading)).not.toBeNull()
    await pickProject()
    await userEvent.selectOptions(durationField(), '60')
    await save()
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it('when they could not be loaded: it says so, offers Try again, and a project can still be recorded', async () => {
    renderDialog({ lists: { status: 'error' } })
    await chooseKind(f.on.options.project)
    expect(screen.getByText(f.workType.loadFailed)).not.toBeNull()
    await userEvent.click(screen.getByRole('button', { name: e.listsRetry }))
    expect(onReloadLists).toHaveBeenCalledTimes(1)
    await chooseKind(f.on.options.none)
    expect(screen.getByText(f.category.loadFailed)).not.toBeNull()
  })

  it('with every category retired, other work says none is available and Save is blocked', async () => {
    renderDialog({ lists: { status: 'loaded', lists: RETIRED_ONLY_LISTS } })
    await chooseKind(f.on.options.none)
    expect(screen.getByText(f.category.noneAvailable)).not.toBeNull()
    expect(submitButton().hasAttribute('disabled')).toBe(true)
    // A project is still recordable: Save is only blocked for the kind that needs a category.
    await chooseKind(f.on.options.project)
    expect(submitButton().hasAttribute('disabled')).toBe(false)
  })

  it('a chosen category that is retired by a fresh read of the lists is no longer chosen', async () => {
    const view = renderDialog()
    await userEvent.selectOptions(durationField(), '60')
    await chooseKind(f.on.options.none)
    await userEvent.selectOptions(select(f.category.label), 'Formazione')
    const retired = {
      ...ENTRY_LISTS,
      categories: ENTRY_LISTS.categories.map((category) => ({ ...category, retired: category.id === 'tc-formazione' })),
    }
    view.rerender(
      <EntryDialog
        lists={{ status: 'loaded', lists: retired }}
        onReloadLists={onReloadLists}
        onSubmit={onSubmit}
        onCancel={onCancel}
      />,
    )
    expect(select(f.category.label).value).toBe('')
    await save()
    expect(screen.getByText(e.errors.categoryRequired)).not.toBeNull()
    expect(onSubmit).not.toHaveBeenCalled()
  })
})
